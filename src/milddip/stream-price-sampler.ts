/**
 * Decode pump/PumpSwap txs from program logs → USD price samples.
 * Only samples mints the caller marks as watched (cooldown / priority) to
 * protect Helius RPC budget.
 */
import { fetchParsedTransaction } from '../copytrader/rpc.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { mildDipHotMints } from './hot-mints.js';
import { priceUsdFromParsedSwapTx } from './mint-price-refresh.js';
import { mildDipPriceRing } from './price-ring.js';

export type StreamPriceSampler = {
  enqueue: (mint: string, signature: string, tsMs?: number) => void;
  stop: () => void;
  stats: () => { queued: number; inFlight: number; sampled: number; skipped: number };
};

export function createStreamPriceSampler(args: {
  rpcUrl: string;
  shouldSample: (mint: string, nowMs: number) => boolean;
  /** Min gap between RPC price fetches per mint. */
  minGapMsPerMint?: number;
  /** Faster gap for buyForce / hot race mints (default 500ms). */
  minGapMsBuyForce?: number;
  concurrency?: number;
}): StreamPriceSampler {
  const minGap = Math.max(500, args.minGapMsPerMint ?? 2_000);
  const minGapForce = Math.max(250, args.minGapMsBuyForce ?? 500);
  const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 3));
  const lastFetchAt = new Map<string, number>();
  const seenSig = new Set<string>();
  const queue: Array<{ mint: string; signature: string; tsMs: number }> = [];
  let inFlight = 0;
  let sampled = 0;
  let skipped = 0;
  let stopped = false;

  const pump = (): void => {
    if (stopped) return;
    while (inFlight < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      inFlight += 1;
      void (async () => {
        try {
          await sampleOne(job);
        } finally {
          inFlight -= 1;
          pump();
        }
      })();
    }
  };

  const sampleOne = async (job: {
    mint: string;
    signature: string;
    tsMs: number;
  }): Promise<void> => {
    const nowMs = Date.now();
    if (!args.shouldSample(job.mint, nowMs)) {
      skipped += 1;
      return;
    }
    const last = lastFetchAt.get(job.mint) ?? 0;
    const gap = mildDipHotMints.isBuyForcePending(job.mint, nowMs) ? minGapForce : minGap;
    if (nowMs - last < gap) {
      skipped += 1;
      return;
    }
    lastFetchAt.set(job.mint, nowMs);

    const solUsd = getSolUsd();
    if (!(solUsd > 0)) {
      skipped += 1;
      return;
    }

    const tx = (await fetchParsedTransaction(args.rpcUrl, job.signature)) as TxJsonParsed | null;
    if (!tx) {
      skipped += 1;
      return;
    }

    const hit = priceUsdFromParsedSwapTx(tx, job.mint, solUsd);
    if (hit && hit.priceUsd > 0) {
      mildDipPriceRing.note(job.mint, hit.priceUsd, {
        tsMs: job.tsMs || nowMs,
        source: 'stream',
      });
      sampled += 1;
      return;
    }
    skipped += 1;
  };

  return {
    enqueue(mint, signature, tsMs = Date.now()) {
      if (stopped) return;
      if (!mint || mint.length < 32 || !signature) return;
      if (seenSig.has(signature)) return;
      // Bound memory: forget old sigs.
      if (seenSig.size > 5_000) {
        const drop = [...seenSig].slice(0, 2_000);
        for (const s of drop) seenSig.delete(s);
      }
      seenSig.add(signature);
      // Always queue — shouldSample checked in sampleOne (resolve path must not drop).
      if (queue.length > 400) queue.splice(0, queue.length - 400);
      queue.push({ mint, signature, tsMs });
      pump();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
    stats: () => ({ queued: queue.length, inFlight, sampled, skipped }),
  };
}
