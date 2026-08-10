/**
 * Resolve mint (+ price + SOL notional) when program logs show Instruction: Buy
 * but omit the mint (common on PumpSwap).
 *
 * One getTransaction per sig. Newest-first within priority lanes; overflow drops
 * lowest-priority oldest jobs first so impulse Buys are not buried under dust.
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

/**
 * Heuristic priority from logs (higher = served first).
 * Large SOL prints / clear Buy lines beat anonymous dust.
 */
export function resolvePriorityFromLogs(logs: string[]): number {
  let pri = 1;
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    if (line.includes('Instruction: Buy')) pri = Math.max(pri, 2);
    // Pump / AMM often log lamports; treat big numbers as likely size.
    const m = line.match(/\b(\d{9,})\b/); // ≥1 SOL in lamports-ish
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 2e9) pri = Math.max(pri, 5); // ≥2 SOL
      else if (Number.isFinite(n) && n >= 5e8) pri = Math.max(pri, 3);
    }
  }
  return pri;
}

export type BuyResolveResult = BuyEconomics & {
  tsMs: number;
};

type Job = { signature: string; tsMs: number; priority: number };

export type BuyMintResolver = {
  enqueue: (signature: string, tsMs?: number, priority?: number) => void;
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
    priorityServed: number;
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
  const concurrency = Math.max(1, Math.min(16, args.concurrency ?? 2));
  const queueMax = Math.max(
    concurrency,
    Math.min(500, args.queueMax ?? Math.min(Math.max(maxPerMin, 80), 400)),
  );
  const staleJobMs = Math.max(5_000, args.staleJobMs ?? STALE_JOB_MS);
  const volumeMinSol = Math.max(0, args.volumeImpulseMinSol ?? 0);
  const seenSig = new Set<string>();
  const queue: Job[] = [];
  let inFlight = 0;
  let resolved = 0;
  let failed = 0;
  let failedRpc = 0;
  let failedNoEcon = 0;
  let skipped = 0;
  let droppedOverflow = 0;
  let droppedStale = 0;
  let volumeMarks = 0;
  let priorityServed = 0;
  let stopped = false;
  let grantTs: number[] = [];

  /** Pop highest priority, then newest. */
  const takeNextFresh = (nowMs: number): Job | null => {
    // Drop stale from anywhere (cheap scan; queue bounded).
    for (let i = queue.length - 1; i >= 0; i--) {
      if (nowMs - queue[i]!.tsMs > staleJobMs) {
        queue.splice(i, 1);
        droppedStale += 1;
      }
    }
    if (queue.length === 0) return null;
    let bestI = 0;
    for (let i = 1; i < queue.length; i++) {
      const a = queue[i]!;
      const b = queue[bestI]!;
      if (a.priority > b.priority || (a.priority === b.priority && a.tsMs > b.tsMs)) {
        bestI = i;
      }
    }
    const [job] = queue.splice(bestI, 1);
    return job ?? null;
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
      if (job.priority >= 3) priorityServed += 1;
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

  const resolveOne = async (job: Job): Promise<void> => {
    try {
      if (Date.now() - job.tsMs > staleJobMs) {
        droppedStale += 1;
        return;
      }
      let raw = (await fetchParsedTransaction(args.rpcUrl, job.signature)) as TxJsonParsed | null;
      // Only retry high-priority jobs — low pri retries burn the minute budget.
      if (!raw && job.priority >= 3 && Date.now() - job.tsMs < staleJobMs) {
        await new Promise((r) => setTimeout(r, 250));
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
    enqueue(signature, tsMs = Date.now(), priority = 1) {
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
      const pri = Math.max(0, Math.min(10, Math.floor(priority)));
      queue.push({ signature, tsMs, priority: pri });
      // Overflow: drop lowest priority, then oldest.
      while (queue.length > queueMax) {
        let worstI = 0;
        for (let i = 1; i < queue.length; i++) {
          const a = queue[i]!;
          const b = queue[worstI]!;
          if (a.priority < b.priority || (a.priority === b.priority && a.tsMs < b.tsMs)) {
            worstI = i;
          }
        }
        queue.splice(worstI, 1);
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
      priorityServed,
    }),
  };
}
