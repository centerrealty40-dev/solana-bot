/**
 * Resolve mint (+ price + SOL notional) when program logs show Instruction: Buy
 * but omit the mint (common on PumpSwap).
 *
 * One getTransaction per sig — economics extracted in the same call (no second
 * getTx via priceSampler). Cap getTx/min so we don't burn Helius on the firehose;
 * newest-first + short queue; overflow drops oldest.
 */
import { fetchParsedTransaction } from '../copytrader/rpc.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { extractBuyEconomics, type BuyEconomics } from './buy-economics.js';
import { mildDipHotMints } from './hot-mints.js';
import { mildDipPriceRing } from './price-ring.js';

export { extractMintFromParsedTx } from './buy-economics.js';

/** Max age of a queued sig before we drop it. */
const STALE_JOB_MS = 45_000;

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

export type BuyResolveResult = BuyEconomics & {
  tsMs: number;
};

export type BuyMintResolver = {
  enqueue: (signature: string, tsMs?: number) => void;
  stop: () => void;
  stats: () => {
    queued: number;
    inFlight: number;
    resolved: number;
    failed: number;
    failedRpc: number;
    failedNoEcon: number;
    skipped: number;
    droppedOverflow: number;
    droppedStale: number;
    volumeMarks: number;
  };
};

export function createBuyMintResolver(args: {
  rpcUrl: string;
  /** Cap getTransaction resolves per rolling minute (0 = off). */
  maxPerMin?: number;
  concurrency?: number;
  /** Max waiting sigs. Default = maxPerMin. */
  queueMax?: number;
  /** Drop jobs older than this before getTx. */
  staleJobMs?: number;
  /** SOL size to mark volume-impulse (0 = off). */
  volumeImpulseMinSol?: number;
  onResolved?: (result: BuyResolveResult) => void;
}): BuyMintResolver {
  const maxPerMin = Math.max(0, args.maxPerMin ?? 30);
  const concurrency = Math.max(1, Math.min(6, args.concurrency ?? 2));
  const queueMax = Math.max(concurrency, Math.min(60, args.queueMax ?? Math.min(maxPerMin, 40)));
  const staleJobMs = Math.max(5_000, args.staleJobMs ?? STALE_JOB_MS);
  const volumeMinSol = Math.max(0, args.volumeImpulseMinSol ?? 0);
  const seenSig = new Set<string>();
  /** Newest at the end — we pop() for LIFO. */
  const queue: Array<{ signature: string; tsMs: number }> = [];
  let inFlight = 0;
  let resolved = 0;
  let failed = 0;
  let failedRpc = 0;
  let failedNoEcon = 0;
  let skipped = 0;
  let droppedOverflow = 0;
  let droppedStale = 0;
  let volumeMarks = 0;
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
      if (Date.now() - job.tsMs > staleJobMs) {
        droppedStale += 1;
        return;
      }
      let raw = (await fetchParsedTransaction(args.rpcUrl, job.signature)) as TxJsonParsed | null;
      // Brand-new WS sigs are often not indexed on the first poll — one short retry.
      if (!raw && Date.now() - job.tsMs < staleJobMs) {
        await new Promise((r) => setTimeout(r, 350));
        raw = (await fetchParsedTransaction(args.rpcUrl, job.signature)) as TxJsonParsed | null;
      }
      if (!raw) {
        failed += 1;
        failedRpc += 1;
        return;
      }
      const solUsd = getSolUsd();
      const econ = extractBuyEconomics(raw, { solUsd: solUsd > 0 ? solUsd : 150 });
      if (!econ) {
        failed += 1;
        failedNoEcon += 1;
        return;
      }
      const ts = Date.now();
      mildDipHotMints.note(econ.mint, ts, 8);
      mildDipHotMints.markBuyForce(econ.mint, ts);
      // Seed ring from THIS tx — no second getTx.
      mildDipPriceRing.note(econ.mint, econ.priceUsd, { tsMs: job.tsMs || ts, source: 'stream' });
      if (volumeMinSol > 0 && econ.solNotional >= volumeMinSol) {
        mildDipHotMints.markVolumeImpulse(econ.mint, econ.solNotional, ts);
        volumeMarks += 1;
      }
      resolved += 1;
      args.onResolved?.({ ...econ, tsMs: ts });
    } catch {
      failed += 1;
      failedRpc += 1;
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
      failedRpc,
      failedNoEcon,
      skipped,
      droppedOverflow,
      droppedStale,
      volumeMarks,
    }),
  };
}
