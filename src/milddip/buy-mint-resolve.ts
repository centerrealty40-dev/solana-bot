/**
 * Resolve mint when program logs show Instruction: Buy but omit the mint
 * (common on PumpSwap — log text has no base58 mint).
 *
 * RCA (BDdzUjk / 5mq4Ttx): FIFO queue of 200 @ 40 getTx/min → ~5 min backlog,
 * so the leader Buy resolved too late (or never). Fix without blowing Helius /
 * Dex enrich:
 * - resolve **Buy only** (skip Sell — entry path doesn't need it)
 * - process **newest first**
 * - hard queue ≤ ~1 min of work; drop stale (>20s) jobs
 * - keep maxPerMin cap (vol-green: 40)
 */
import { fetchParsedTransaction } from '../copytrader/rpc.js';
import type { TokenBal, TxJsonParsed } from '../parser/rpc-http.js';
import { mildDipHotMints } from './hot-mints.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SKIP = new Set([WSOL, USDC, USDT]);

/** Max age of a queued sig before we drop it (candle already gone). */
const STALE_JOB_MS = 60_000;

export function logsIndicateBuyOrSell(logs: string[]): boolean {
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes('Instruction: Buy') || line.includes('Instruction: Sell')) return true;
  }
  return false;
}

export function logsIndicateBuy(logs: string[]): boolean {
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes('Instruction: Buy')) return true;
  }
  return false;
}

/** Only Buys without mint — Sells skipped to protect Helius getTx budget. */
export function needsBuyMintResolve(logs: string[], extractedMints: string[]): boolean {
  return logsIndicateBuy(logs) && extractedMints.length === 0;
}

function accountKeyPubkeys(tx: TxJsonParsed): string[] {
  const msg = tx.transaction?.message as
    | { accountKeys?: Array<string | { pubkey?: string }> }
    | undefined;
  const keys = msg?.accountKeys;
  if (!Array.isArray(keys)) return [];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof k === 'string') out.push(k);
    else if (k && typeof k.pubkey === 'string') out.push(k.pubkey);
  }
  return out;
}

function uiAmount(b: TokenBal): number {
  const ui = b.uiTokenAmount?.uiAmount;
  if (typeof ui === 'number' && Number.isFinite(ui)) return ui;
  const amt = b.uiTokenAmount?.amount;
  const dec = b.uiTokenAmount?.decimals ?? 0;
  if (typeof amt === 'string' && /^\d+$/.test(amt)) {
    return Number(amt) / 10 ** dec;
  }
  return 0;
}

/**
 * Prefer fee-payer's largest positive non-stable token delta (Buy).
 * Fallback: .pump in account keys, then largest |delta| non-stable mint.
 */
export function extractMintFromParsedTx(tx: TxJsonParsed | null | undefined): string | null {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = accountKeyPubkeys(tx);
  const payer = keys[0] ?? '';
  const pre = new Map<string, number>();
  for (const b of tx.meta.preTokenBalances ?? []) {
    if (!b.mint || SKIP.has(b.mint)) continue;
    const owner = b.owner ?? '';
    pre.set(`${owner}|${b.mint}`, uiAmount(b));
  }

  let bestPayer: { mint: string; delta: number } | null = null;
  let bestAny: { mint: string; abs: number } | null = null;

  for (const b of tx.meta.postTokenBalances ?? []) {
    if (!b.mint || SKIP.has(b.mint)) continue;
    const owner = b.owner ?? '';
    const key = `${owner}|${b.mint}`;
    const post = uiAmount(b);
    const before = pre.get(key) ?? 0;
    const delta = post - before;
    if (owner === payer && delta > 0) {
      if (!bestPayer || delta > bestPayer.delta) bestPayer = { mint: b.mint, delta };
    }
    const abs = Math.abs(delta);
    if (abs > 0 && (!bestAny || abs > bestAny.abs)) bestAny = { mint: b.mint, abs };
  }

  for (const b of tx.meta.postTokenBalances ?? []) {
    if (!b.mint || SKIP.has(b.mint)) continue;
    const owner = b.owner ?? '';
    const key = `${owner}|${b.mint}`;
    if (pre.has(key)) continue;
    const post = uiAmount(b);
    if (owner === payer && post > 0) {
      if (!bestPayer || post > bestPayer.delta) bestPayer = { mint: b.mint, delta: post };
    }
  }

  if (bestPayer?.mint) return bestPayer.mint;

  const pumpKey = keys.find((k) => k.endsWith('pump') && !SKIP.has(k));
  if (pumpKey) return pumpKey;

  return bestAny?.mint ?? null;
}

export type BuyMintResolver = {
  enqueue: (signature: string, tsMs?: number) => void;
  stop: () => void;
  stats: () => {
    queued: number;
    inFlight: number;
    resolved: number;
    failed: number;
    skipped: number;
    droppedOverflow: number;
    droppedStale: number;
  };
};

export function createBuyMintResolver(args: {
  rpcUrl: string;
  /** Cap getTransaction resolves per rolling minute (0 = off). */
  maxPerMin?: number;
  concurrency?: number;
  /** Max waiting sigs (~1 min of work). Default = maxPerMin. */
  queueMax?: number;
  /** Drop jobs older than this before getTx. Default 20s. */
  staleJobMs?: number;
  onResolved?: (mint: string, signature: string, tsMs: number) => void;
}): BuyMintResolver {
  const maxPerMin = Math.max(0, args.maxPerMin ?? 30);
  const concurrency = Math.max(1, Math.min(6, args.concurrency ?? 2));
  const queueMax = Math.max(concurrency, Math.min(80, args.queueMax ?? Math.max(maxPerMin, 20)));
  const staleJobMs = Math.max(5_000, args.staleJobMs ?? STALE_JOB_MS);
  const seenSig = new Set<string>();
  /** Newest at the end — we pop() for LIFO. */
  const queue: Array<{ signature: string; tsMs: number }> = [];
  let inFlight = 0;
  let resolved = 0;
  let failed = 0;
  let skipped = 0;
  let droppedOverflow = 0;
  let droppedStale = 0;
  let stopped = false;
  let grantTs: number[] = [];

  const takeNextFresh = (nowMs: number): { signature: string; tsMs: number } | null => {
    while (queue.length > 0) {
      const job = queue.pop()!;
      if (nowMs - job.tsMs > staleJobMs) {
        droppedStale += 1;
        continue;
      }
      return job;
    }
    return null;
  };

  const pump = (): void => {
    if (stopped || maxPerMin <= 0) return;
    while (inFlight < concurrency) {
      const nowMs = Date.now();
      grantTs = grantTs.filter((t) => nowMs - t < 60_000);
      if (grantTs.length >= maxPerMin) break;
      const job = takeNextFresh(nowMs);
      if (!job) break;
      grantTs.push(nowMs);
      inFlight += 1;
      void (async () => {
        try {
          await resolveOne(job);
        } finally {
          inFlight -= 1;
          pump();
        }
      })();
    }
  };

  const resolveOne = async (job: { signature: string; tsMs: number }): Promise<void> => {
    try {
      // Skip getTx if job went stale while waiting for a worker slot.
      if (Date.now() - job.tsMs > staleJobMs) {
        droppedStale += 1;
        return;
      }
      const raw = (await fetchParsedTransaction(args.rpcUrl, job.signature)) as TxJsonParsed | null;
      const mint = extractMintFromParsedTx(raw);
      if (!mint) {
        failed += 1;
        return;
      }
      const ts = Date.now();
      // Fresh note + force — race the candle on the next scan (buyForce).
      mildDipHotMints.note(mint, ts, 8);
      mildDipHotMints.markBuyForce(mint, ts);
      resolved += 1;
      args.onResolved?.(mint, job.signature, ts);
    } catch {
      failed += 1;
    }
  };

  return {
    enqueue(signature, tsMs = Date.now()) {
      if (stopped || maxPerMin <= 0) return;
      if (!signature || signature.length < 32) return;
      if (seenSig.has(signature)) {
        skipped += 1;
        return;
      }
      if (seenSig.size > 8_000) {
        for (const s of [...seenSig].slice(0, 3_000)) seenSig.delete(s);
      }
      seenSig.add(signature);
      // Keep only the newest queueMax sigs — drop oldest at the front.
      queue.push({ signature, tsMs });
      while (queue.length > queueMax) {
        queue.shift();
        droppedOverflow += 1;
      }
      pump();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
    stats: () => ({
      queued: queue.length,
      inFlight,
      resolved,
      failed,
      skipped,
      droppedOverflow,
      droppedStale,
    }),
  };
}
