/**
 * Decode pump/PumpSwap txs from program logs → USD price samples.
 * Only samples mints the caller marks as watched (cooldown / priority) to
 * protect Helius RPC budget.
 *
 * Also detects one-shot emptied-bag sells on open mints (same tx meta —
 * no extra balance RPC) so exits can grace peak_giveback briefly.
 */
import { fetchParsedTransaction } from '../copytrader/rpc.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { decodeAllowlistedDexSwapInserts } from '../parser/allowlisted-dex-swap.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import {
  detectOneshotEmptiedDump,
  type OneshotDumpDetectOpts,
  type OneshotDumpEvent,
} from './oneshot-dump.js';
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
  concurrency?: number;
  /**
   * When true, bypass per-mint minGap so every unique signature is fetched
   * (open-book oneshot dump detect). Still deduped by signature.
   */
  forceFetch?: (mint: string) => boolean;
  /** Optional oneshot emptied-bag dump detection on decoded txs. */
  oneshot?: OneshotDumpDetectOpts & { enabled: boolean };
  onOneshotDump?: (ev: OneshotDumpEvent) => void;
}): StreamPriceSampler {
  const minGap = Math.max(500, args.minGapMsPerMint ?? 2_000);
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
    const forced = args.forceFetch?.(job.mint) === true;
    const last = lastFetchAt.get(job.mint) ?? 0;
    if (!forced && nowMs - last < minGap) {
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

    const swaps = decodeAllowlistedDexSwapInserts(tx, PUMP_FUN_PROGRAM_ID, solUsd);
    let noted = false;
    let priceHint = 0;
    for (const s of swaps) {
      if (s.baseMint !== job.mint) continue;
      if (!(s.priceUsd > 0)) continue;
      mildDipPriceRing.note(job.mint, s.priceUsd, {
        tsMs: job.tsMs || nowMs,
        source: 'stream',
      });
      noted = true;
      if (s.priceUsd > priceHint) priceHint = s.priceUsd;
    }

    if (args.oneshot?.enabled && args.onOneshotDump) {
      const ringPx = mildDipPriceRing.lastPrice(job.mint, nowMs)?.priceUsd ?? 0;
      const dump = detectOneshotEmptiedDump(
        tx,
        job.mint,
        {
          minSellUsd: args.oneshot.minSellUsd,
          maxPostResidualFrac: args.oneshot.maxPostResidualFrac,
        },
        {
          priceUsd: priceHint > 0 ? priceHint : ringPx,
          tsMs: job.tsMs || nowMs,
          signature: job.signature,
        },
      );
      if (dump) args.onOneshotDump(dump);
    }

    if (noted) sampled += 1;
    else skipped += 1;
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
      if (!args.shouldSample(mint, tsMs)) return;
      const last = lastFetchAt.get(mint) ?? 0;
      if (tsMs - last < minGap && queue.every((q) => q.mint !== mint)) {
        // still allow one queued refresh after gap
      }
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
