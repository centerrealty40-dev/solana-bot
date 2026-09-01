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
import {
  mintDecimalsFromTxMeta,
  mintPriceUsdFromTxMeta,
} from './stream-mint-price.js';

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
    skipReasonCounts: Record<string, number>;
    txRetryAttempts: number;
    txRetrySucceeded: number;
  };
};

export type StreamPriceSample = {
  mint: string;
  priceUsd: number;
  tsMs: number;
  source: 'stream';
};

type FetchParsedTransactionFn = (
  rpcUrl: string,
  signature: string,
) => Promise<unknown | null>;

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
  onPriceSample?: (sample: StreamPriceSample) => void;
  fetchParsedTransactionFn?: FetchParsedTransactionFn;
  txRetryEnabled?: boolean;
  txRetryMaxAttempts?: number;
  txRetryDelayMs?: number;
  txRetryMaxAgeMs?: number;
  minSignerNotionalUsd?: number;
}): StreamPriceSampler {
  const minGap = Math.max(500, args.minGapMsPerMint ?? 2_000);
  const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 3));
  const txRetryEnabled = args.txRetryEnabled === true;
  const txRetryMaxAttempts = Math.max(0, Math.floor(args.txRetryMaxAttempts ?? 2));
  const txRetryDelayMs = Math.max(0, Math.floor(args.txRetryDelayMs ?? 400));
  const txRetryMaxAgeMs = Math.max(0, Math.floor(args.txRetryMaxAgeMs ?? 30_000));
  const fetchTx = args.fetchParsedTransactionFn ?? fetchParsedTransaction;
  const lastFetchAt = new Map<string, number>();
  const seenSig = new Set<string>();
  const queue: Array<{
    mint: string;
    signature: string;
    tsMs: number;
    retryAttempt?: number;
  }> = [];
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const skipReasonCounts = new Map<string, number>();
  let inFlight = 0;
  let sampled = 0;
  let skipped = 0;
  let lastSampleAtMs: number | null = null;
  let lastSkipReason: string | null = null;
  let txRetryAttempts = 0;
  let txRetrySucceeded = 0;
  let stopped = false;

  const noteSkip = (reason: string): void => {
    skipped += 1;
    lastSkipReason = reason;
    skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
  };

  const retryJob = (
    job: {
      mint: string;
      signature: string;
      tsMs: number;
      retryAttempt?: number;
    },
    nowMs: number,
  ): void => {
    const attempt = job.retryAttempt ?? 0;
    if (
      !txRetryEnabled ||
      attempt >= txRetryMaxAttempts ||
      nowMs - job.tsMs > txRetryMaxAgeMs ||
      stopped
    ) {
      return;
    }
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (stopped) return;
      queue.push({ ...job, retryAttempt: attempt + 1 });
      pump();
    }, txRetryDelayMs);
    retryTimers.add(timer);
  };

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
    retryAttempt?: number;
  }): Promise<void> => {
    const nowMs = Date.now();
    const isRetry = (job.retryAttempt ?? 0) > 0;
    if (isRetry && nowMs - job.tsMs > txRetryMaxAgeMs) return;
    if (!isRetry && !args.shouldSample(job.mint, nowMs)) {
      noteSkip('should_sample_false');
      return;
    }
    const forced = args.forceFetch?.(job.mint) === true;
    const last = lastFetchAt.get(job.mint) ?? 0;
    if (!isRetry && !forced && nowMs - last < minGap) {
      noteSkip('min_gap');
      return;
    }
    lastFetchAt.set(job.mint, nowMs);
    if (isRetry) txRetryAttempts += 1;

    const solUsd = getSolUsd();
    const tx = (await fetchTx(args.rpcUrl, job.signature)) as TxJsonParsed | null;
    if (!tx) {
      noteSkip('get_tx_null');
      retryJob(job, nowMs);
      return;
    }
    const knownDecimals = mintDecimalsFromTxMeta(tx, job.mint);
    if (knownDecimals != null) {
      mildDipPriceRing.noteMintDecimals(job.mint, knownDecimals);
    }
    if (isRetry) txRetrySucceeded += 1;

    let noted = false;
    let priceHint = 0;
    let sampleSkipReason: string | null = null;
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
        if (
          !mildDipPriceRing.isPlausiblePrice(mint, s.priceUsd, {
            nowMs: ts,
            windowMs: 10 * 60_000,
            maxRatio: 20,
          })
        ) {
          if (mint === job.mint) sampleSkipReason = 'price_outlier';
          continue;
        }
        mildDipPriceRing.note(mint, s.priceUsd, { tsMs: ts, source: 'stream' });
        args.onPriceSample?.({ mint, priceUsd: s.priceUsd, tsMs: ts, source: 'stream' });
        if (mint === job.mint) {
          noted = true;
          if (s.priceUsd > priceHint) priceHint = s.priceUsd;
        }
      }

      // 1.11.798 — balance-route fallback when SwapInsert decode misses.
      if (!noted) {
        const balPx = mintPriceUsdFromTxMeta(tx, job.mint, solUsd, {
          minSignerNotionalUsd: args.minSignerNotionalUsd,
        });
        if (balPx != null && balPx > 0) {
          if (
            !mildDipPriceRing.isPlausiblePrice(job.mint, balPx, {
              nowMs: ts,
              windowMs: 10 * 60_000,
              maxRatio: 20,
            })
          ) {
            sampleSkipReason = 'price_outlier';
          } else {
            mildDipPriceRing.note(job.mint, balPx, { tsMs: ts, source: 'stream' });
            args.onPriceSample?.({
              mint: job.mint,
              priceUsd: balPx,
              tsMs: ts,
              source: 'stream',
            });
            noted = true;
            priceHint = balPx;
          }
        }
      }
    } else {
      sampleSkipReason = 'sol_usd_zero';
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
      noteSkip(sampleSkipReason ?? (solUsd > 0 ? 'no_price_decode' : 'sol_usd_zero'));
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
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
    },
    stats: () => ({
      queued: queue.length,
      inFlight,
      sampled,
      skipped,
      lastSampleAtMs,
      lastSkipReason,
      skipReasonCounts: Object.fromEntries(skipReasonCounts),
      txRetryAttempts,
      txRetrySucceeded,
    }),
  };
}
