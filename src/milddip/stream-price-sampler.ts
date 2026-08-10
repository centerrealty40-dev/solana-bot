/**
 * Decode pump/PumpSwap txs from program logs → USD price samples.
 * Only samples mints the caller marks as watched (cooldown / priority) to
 * protect Helius RPC budget.
 *
 * Also extracts sell prints on open mints (tx meta balances) so exits can
 * classify whale oneshot vs mass flee before peak_giveback.
 */
import { fetchParsedTransaction } from '../copytrader/rpc.js';
import { getSolUsd } from '../papertrader/pricing.js';
import { decodeAllowlistedDexSwapInserts } from '../parser/allowlisted-dex-swap.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import {
  extractMintSellPrints,
  type DumpSellPrint,
  type DumpSellTape,
} from './dump-classify.js';
import {
  detectOneshotEmptiedDump,
  type OneshotDumpDetectOpts,
  type OneshotDumpEvent,
} from './oneshot-dump.js';
import { mildDipPriceRing } from './price-ring.js';
import { mintPriceUsdFromTxMeta } from './stream-mint-price.js';

export type StreamPriceSampler = {
  enqueue: (mint: string, signature: string, tsMs?: number) => void;
  stop: () => void;
  stats: () => {
    queued: number;
    inFlight: number;
    sampled: number;
    skipped: number;
    lastSampleAtMs: number | null;
    lastSkipReason: string | null;
  };
};

export function createStreamPriceSampler(args: {
  rpcUrl: string;
  shouldSample: (mint: string, nowMs: number) => boolean;
  /** Min gap between RPC price fetches per mint. */
  minGapMsPerMint?: number;
  concurrency?: number;
  /**
   * When true, bypass per-mint minGap so every unique signature is fetched
   * (open-book dump classify / oneshot). Still deduped by signature.
   */
  forceFetch?: (mint: string) => boolean;
  /** Optional oneshot emptied-bag dump detection on decoded txs. */
  oneshot?: OneshotDumpDetectOpts & { enabled: boolean };
  onOneshotDump?: (ev: OneshotDumpEvent) => void;
  /** Recent sell tape for giveback dump classify. */
  sellTape?: DumpSellTape | null;
  maxPostResidualFrac?: number;
  onSellPrints?: (prints: DumpSellPrint[]) => void;
}): StreamPriceSampler {
  const minGap = Math.max(500, args.minGapMsPerMint ?? 2_000);
  const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 3));
  const lastFetchAt = new Map<string, number>();
  const seenSig = new Set<string>();
  const queue: Array<{ mint: string; signature: string; tsMs: number }> = [];
  let inFlight = 0;
  let sampled = 0;
  let skipped = 0;
  let lastSampleAtMs: number | null = null;
  let lastSkipReason: string | null = null;
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
      lastSkipReason = 'should_sample_false';
      return;
    }
    const forced = args.forceFetch?.(job.mint) === true;
    const last = lastFetchAt.get(job.mint) ?? 0;
    if (!forced && nowMs - last < minGap) {
      skipped += 1;
      lastSkipReason = 'min_gap';
      return;
    }
    lastFetchAt.set(job.mint, nowMs);

    const solUsd = getSolUsd();
    const tx = (await fetchParsedTransaction(args.rpcUrl, job.signature)) as TxJsonParsed | null;
    if (!tx) {
      skipped += 1;
      lastSkipReason = 'get_tx_null';
      return;
    }

    let noted = false;
    let priceHint = 0;
    const ts = job.tsMs || nowMs;

    // Price decode needs SOL/USD; sell-balance classify does not.
    if (solUsd > 0) {
      const swaps = decodeAllowlistedDexSwapInserts(tx, PUMP_FUN_PROGRAM_ID, solUsd);
      for (const s of swaps) {
        if (!(s.priceUsd > 0) || !s.baseMint) continue;
        // Note job mint and any other watched mint in this tx (extract can be noisy).
        const mint = s.baseMint;
        if (
          mint !== job.mint &&
          !args.shouldSample(mint, nowMs) &&
          args.forceFetch?.(mint) !== true
        ) {
          continue;
        }
        mildDipPriceRing.note(mint, s.priceUsd, { tsMs: ts, source: 'stream' });
        if (mint === job.mint) {
          noted = true;
          if (s.priceUsd > priceHint) priceHint = s.priceUsd;
        }
      }

      // 1.11.798 — balance-route fallback when SwapInsert decode misses.
      if (!noted) {
        const balPx = mintPriceUsdFromTxMeta(tx, job.mint, solUsd);
        if (balPx != null && balPx > 0) {
          mildDipPriceRing.note(job.mint, balPx, { tsMs: ts, source: 'stream' });
          noted = true;
          priceHint = balPx;
        }
      }
    } else {
      lastSkipReason = 'sol_usd_zero';
    }

    const ringPx = mildDipPriceRing.lastPrice(job.mint, nowMs)?.priceUsd ?? 0;
    const px = priceHint > 0 ? priceHint : ringPx;

    // Always extract sells for forced/open mints — dump classify before giveback.
    if (forced || args.sellTape || args.onSellPrints) {
      const prints = extractMintSellPrints(tx, job.mint, {
        priceUsd: px,
        tsMs: ts,
        signature: job.signature,
        maxPostResidualFrac: args.maxPostResidualFrac ?? args.oneshot?.maxPostResidualFrac,
      });
      if (prints.length > 0) {
        args.sellTape?.noteMany(prints);
        args.onSellPrints?.(prints);
      }
    }

    if (args.oneshot?.enabled && args.onOneshotDump) {
      const dump = detectOneshotEmptiedDump(
        tx,
        job.mint,
        {
          minSellUsd: args.oneshot.minSellUsd,
          maxPostResidualFrac: args.oneshot.maxPostResidualFrac,
        },
        {
          priceUsd: px,
          tsMs: ts,
          signature: job.signature,
        },
      );
      if (dump) args.onOneshotDump(dump);
    }

    if (noted) {
      sampled += 1;
      lastSampleAtMs = nowMs;
      lastSkipReason = null;
    } else {
      skipped += 1;
      if (!lastSkipReason || lastSkipReason === 'sol_usd_zero') {
        lastSkipReason = solUsd > 0 ? 'no_price_decode' : 'sol_usd_zero';
      }
    }
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
      // Open-book forceFetch: never drop on minGap at enqueue — sampleOne bypasses too.
      const forced = args.forceFetch?.(mint) === true;
      const last = lastFetchAt.get(mint) ?? 0;
      if (!forced && tsMs - last < minGap && queue.some((q) => q.mint === mint)) {
        // Already have a refresh queued for this mint within gap — skip pile-up.
        return;
      }
      if (queue.length > 400) {
        // Prefer keeping forced/open work: drop from the front.
        queue.splice(0, queue.length - 400);
      }
      queue.push({ mint, signature, tsMs });
      pump();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
    stats: () => ({
      queued: queue.length,
      inFlight,
      sampled,
      skipped,
      lastSampleAtMs,
      lastSkipReason,
    }),
  };
}
