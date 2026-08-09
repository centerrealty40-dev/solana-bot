/**
 * Stream → local 1m impulse → buy candidates.
 * No Dex probe / Gecko OHLCV — price ring samples only.
 */
import type {
  EnrichFilterResult,
  EntrySkip,
  MildDipCandidate,
} from '../milddip/discover.js';
import type { MildDipConfig } from '../milddip/config.js';
import { mildDipHotMints } from '../milddip/hot-mints.js';
import { mildDipPriceRing } from '../milddip/price-ring.js';
import { evaluateTripleGreenEntry } from './triple-green.js';

const LOOKBACK_MS = 20 * 60_000;
const DEFAULT_EVAL_MAX = 24;

export async function evaluateStreamImpulseCandidates(
  cfg: MildDipConfig,
  opts?: {
    nowMs?: number;
    /** Cap how many mints get local-bar eval per scan. */
    evalMax?: number;
    fetchImpl?: typeof fetch;
  },
): Promise<EnrichFilterResult> {
  const nowMs = opts?.nowMs ?? Date.now();
  const evalMax = Math.max(4, Math.min(48, opts?.evalMax ?? DEFAULT_EVAL_MAX));

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

  // Prefer mints that already have stream prices (can form bars).
  const ranked = ordered
    .map((mint) => {
      const n = mildDipPriceRing.sampleCount(mint, LOOKBACK_MS, nowMs);
      const last = mildDipPriceRing.lastPrice(mint, nowMs)?.tsMs ?? 0;
      const forceBoost = buyForce.includes(mint) ? 1_000_000 : 0;
      return { mint, score: forceBoost + n * 100 + last / 1e12 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, evalMax);

  const candidates: MildDipCandidate[] = [];
  const skips: EntrySkip[] = [];
  const gates = {
    enabled: true,
    smallMinPc: cfg.greenTape.tripleSmallMinPc,
    smallMaxPc: cfg.greenTape.tripleSmallMaxPc,
    hugeMinPc: cfg.greenTape.tripleHugeMinPc,
    hugeMinVolUsd: 0, // local proxy vol only
    maxAgeAfterHugeMs: cfg.greenTape.tripleMaxAgeAfterHugeMs,
    firstStrongMinPc: cfg.greenTape.firstStrongMinPc,
    firstStrongMaxPriorPc: cfg.greenTape.firstStrongMaxPriorPc,
  };

  for (const { mint } of ranked) {
    const samples = mildDipPriceRing.listSamples(mint, LOOKBACK_MS, nowMs);
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
      // Keep buyForce — next 1m sample may complete the impulse.
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

    const last = mildDipPriceRing.lastPrice(mint, nowMs);
    if (!last || !(last.priceUsd > 0)) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: ['stream_impulse_no_price'],
      });
      continue;
    }

    const firstStrong =
      tg.pattern != null &&
      tg.pattern.small1 === 0 &&
      (cfg.greenTape.firstStrongMinPc ?? 0) > 0 &&
      tg.pattern.huge >= cfg.greenTape.firstStrongMinPc;

    const ringPc5m = mildDipPriceRing.changeFromOldestPct(mint, 300_000, nowMs);
    const score =
      (tg.pattern?.huge ?? 0) + (tg.pattern?.small0 ?? 0) + (tg.pattern?.small1 ?? 0);

    mildDipHotMints.clearBuyForce(mint);
    candidates.push({
      mint,
      symbol: mint.slice(0, 6),
      priceUsd: last.priceUsd,
      dipSource: 'stream',
      entryPath: firstStrong ? 'green_tape_impulse' : 'green_tape_triple',
      entryScore: score,
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
        triplePattern: tg.pattern ?? null,
      },
    });
  }

  return { candidates, skips };
}
