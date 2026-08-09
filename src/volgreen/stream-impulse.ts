/**
 * Stream → local 1m impulse → buy candidates.
 * No Dex probe / Gecko OHLCV — price ring samples only (+ targeted chain refresh).
 */
import type {
  EnrichFilterResult,
  EntrySkip,
  MildDipCandidate,
} from '../milddip/discover.js';
import type { MildDipConfig } from '../milddip/config.js';
import { mapPool } from '../milddip/exit-engine.js';
import { mildDipHotMints } from '../milddip/hot-mints.js';
import {
  mintPriceRefreshEnabled,
  refreshMintPriceFromChain,
} from '../milddip/mint-price-refresh.js';
import { mildDipPriceRing } from '../milddip/price-ring.js';
import { evaluateTripleGreenEntry } from './triple-green.js';

const LOOKBACK_MS = 20 * 60_000;
const DEFAULT_EVAL_MAX = 24;
/** Refresh when last ring sample older than this. */
const STALE_SAMPLE_MS = 15_000;
/** Intrabar impulse window (leader mid-minute). */
const INTRABAR_MS = 60_000;

function needsPriceRefresh(mint: string, nowMs: number): boolean {
  const n = mildDipPriceRing.sampleCount(mint, LOOKBACK_MS, nowMs);
  if (n < 2) return true;
  const last = mildDipPriceRing.lastPrice(mint, nowMs);
  if (!last || !(last.priceUsd > 0)) return true;
  return nowMs - last.tsMs > STALE_SAMPLE_MS;
}

function candidateFromPass(args: {
  mint: string;
  nowMs: number;
  entryPath: 'green_tape_impulse' | 'green_tape_triple';
  score: number;
  huge: number;
  small0: number;
  small1: number;
  hugeVol: number;
  hugeTs: number;
}): MildDipCandidate | null {
  const last = mildDipPriceRing.lastPrice(args.mint, args.nowMs);
  if (!last || !(last.priceUsd > 0)) return null;
  const ringPc5m = mildDipPriceRing.changeFromOldestPct(args.mint, 300_000, args.nowMs);
  mildDipHotMints.clearBuyForce(args.mint);
  return {
    mint: args.mint,
    symbol: args.mint.slice(0, 6),
    priceUsd: last.priceUsd,
    dipSource: 'stream',
    entryPath: args.entryPath,
    entryScore: args.score,
    metrics: {
      priceChange5mPct: ringPc5m,
      volume5mUsd: null,
      liquidityUsd: null,
      marketCapUsd: null,
      pairAgeHours: null,
      dexId: 'pumpswap',
      buys5m: null,
      sells5m: null,
      volume1hUsd: null,
      priceChange1hPct: null,
      triplePattern: {
        small0: args.small0,
        small1: args.small1,
        huge: args.huge,
        hugeVol: args.hugeVol,
        hugeTs: args.hugeTs,
      },
    },
  };
}

export async function evaluateStreamImpulseCandidates(
  cfg: MildDipConfig,
  opts?: {
    nowMs?: number;
    /** Cap how many mints get local-bar eval per scan. */
    evalMax?: number;
    fetchImpl?: typeof fetch;
    rpcUrl?: string;
    /** Disable chain refresh (unit tests). */
    allowPriceRefresh?: boolean;
  },
): Promise<EnrichFilterResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const evalMax = Math.max(4, Math.min(48, opts?.evalMax ?? DEFAULT_EVAL_MAX));
  const rpcUrl = (opts?.rpcUrl ?? cfg.rpcUrl ?? '').trim();
  const allowRefresh =
    opts?.allowPriceRefresh !== false &&
    mintPriceRefreshEnabled() &&
    rpcUrl.length > 8;

  const buyForce = mildDipHotMints.takeForceEnrichBuyResolved(nowMs, 16);
  const hot = mildDipHotMints.listForEnrich(nowMs);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const m of [...buyForce, ...hot]) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    ordered.push(m);
    if (ordered.length >= evalMax * 2) break;
  }

  const ranked = ordered
    .map((mint) => {
      const n = mildDipPriceRing.sampleCount(mint, LOOKBACK_MS, nowMs);
      const last = mildDipPriceRing.lastPrice(mint, nowMs)?.tsMs ?? 0;
      const forceBoost = buyForce.includes(mint) ? 1_000_000 : 0;
      return { mint, score: forceBoost + n * 100 + last / 1e12 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, evalMax);

  // Targeted chain price refresh for stale / thin rings (not Dex enrich).
  if (allowRefresh) {
    const need = ranked.filter((r) => needsPriceRefresh(r.mint, nowMs)).map((r) => r.mint);
    if (need.length > 0) {
      await mapPool(need, 4, async (mint) => {
        await refreshMintPriceFromChain(mint, rpcUrl, {
          nowMs,
          minGapMs: 3_000,
          maxPerMin: 20,
          sigLimit: 4,
        });
        return null;
      });
    }
  }

  const candidates: MildDipCandidate[] = [];
  const skips: EntrySkip[] = [];
  const firstStrongMin = cfg.greenTape.firstStrongMinPc ?? 0;
  const gates = {
    enabled: true,
    smallMinPc: cfg.greenTape.tripleSmallMinPc,
    smallMaxPc: cfg.greenTape.tripleSmallMaxPc,
    hugeMinPc: cfg.greenTape.tripleHugeMinPc,
    hugeMinVolUsd: 0,
    maxAgeAfterHugeMs: cfg.greenTape.tripleMaxAgeAfterHugeMs,
    firstStrongMinPc: firstStrongMin,
    firstStrongMaxPriorPc: cfg.greenTape.firstStrongMaxPriorPc,
  };

  for (const { mint } of ranked) {
    const samples = mildDipPriceRing.listSamples(mint, LOOKBACK_MS, nowMs);

    // Large SOL buy from stream resolve — enter on notional, don't wait for 1m bars.
    if (mildDipHotMints.isVolumeImpulse(mint, nowMs)) {
      const solN = mildDipHotMints.volumeImpulseSol(mint, nowMs);
      const last = mildDipPriceRing.lastPrice(mint, nowMs);
      if (last && last.priceUsd > 0 && solN > 0) {
        const cand = candidateFromPass({
          mint,
          nowMs,
          entryPath: 'green_tape_impulse',
          score: solN * 10,
          huge: Math.max(firstStrongMin || 20, solN * 5),
          small0: 0,
          small1: 0,
          hugeVol: solN * 150, // proxy USD if SOL≈$150
          hugeTs: Math.floor(nowMs / 1000),
        });
        if (cand) {
          candidates.push(cand);
          continue;
        }
      }
    }

    // Intrabar: strong move in last 60s even if completed 1m bars look flat/stale.
    if (firstStrongMin > 0) {
      const ringPc60 = mildDipPriceRing.changeFromOldestPct(mint, INTRABAR_MS, nowMs);
      if (ringPc60 != null && Number.isFinite(ringPc60) && ringPc60 >= firstStrongMin) {
        const cand = candidateFromPass({
          mint,
          nowMs,
          entryPath: 'green_tape_impulse',
          score: ringPc60,
          huge: +ringPc60.toFixed(2),
          small0: 0,
          small1: 0,
          hugeVol: 0,
          hugeTs: Math.floor(nowMs / 1000),
        });
        if (cand) {
          candidates.push(cand);
          continue;
        }
      }
    }

    if (samples.length < 2) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: [`stream_impulse_need_samples=${samples.length}<2`],
      });
      continue;
    }

    const tg = await evaluateTripleGreenEntry({
      pairAddress: null,
      nowMs,
      localPriceSamples: samples,
      allowGeckoHttp: false,
      geckoPriority: false,
      leaderFlex: mildDipHotMints.isLeaderHighlight(mint, nowMs),
      gates,
      fetchImpl: opts?.fetchImpl,
    });

    if (!tg.pass) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: tg.reasons,
        metrics: {
          triplePattern: tg.pattern ?? null,
          priceChange5mPct: mildDipPriceRing.changeFromOldestPct(mint, 300_000, nowMs),
        },
      });
      continue;
    }

    const firstStrong =
      tg.pattern != null &&
      tg.pattern.small1 === 0 &&
      firstStrongMin > 0 &&
      tg.pattern.huge >= firstStrongMin;

    const cand = candidateFromPass({
      mint,
      nowMs,
      entryPath: firstStrong ? 'green_tape_impulse' : 'green_tape_triple',
      score:
        (tg.pattern?.huge ?? 0) + (tg.pattern?.small0 ?? 0) + (tg.pattern?.small1 ?? 0),
      huge: tg.pattern?.huge ?? 0,
      small0: tg.pattern?.small0 ?? 0,
      small1: tg.pattern?.small1 ?? 0,
      hugeVol: tg.pattern?.hugeVol ?? 0,
      hugeTs: tg.pattern?.hugeTs ?? Math.floor(nowMs / 1000),
    });
    if (!cand) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: ['stream_impulse_no_price'],
      });
      continue;
    }
    candidates.push(cand);
  }

  return { candidates, skips };
}
