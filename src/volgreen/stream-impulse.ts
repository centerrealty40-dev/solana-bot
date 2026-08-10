/**
 * Stream → local 1m impulse → buy candidates.
 * No Dex probe / Gecko OHLCV — price ring samples only (+ targeted chain refresh).
 *
 * Early race: mid-impulse flex (huge-in-middle, tip soft OK), intrabar_fast 20s,
 * F_early tape (~60s). Early shapes skip require_leader_bought so we can lead.
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
import {
  earlyMinSampleSpanMs,
  earlyMinSamples,
  earlySampleLookbackMs,
  envOn as qualityEnvOn,
  isImpulsePlayedOut,
  isThinEarlyTape,
  offPeakDdMaxPct,
  offPeakLookbackMs,
} from './entry-quality.js';
import {
  detectDualLeaderTape,
  earlyTapeEnabled,
  f7LeaderTapeGates,
  f8LeaderTapeGates,
  fEarlyLeaderTapeGates,
} from './leader-formulas.js';
import {
  hasLeaderBought,
  requireLeaderBoughtEnabled,
} from './leader-mint-allowlist.js';
import { defaultScamLadderGates, detectMonotonicGrind } from './scam-ladder.js';
import { evaluateTripleGreenEntry } from './triple-green.js';

/** Keep enough history for scam-ladder (~1h grind). */
const LOOKBACK_MS = 60 * 60_000;
const DEFAULT_EVAL_MAX = 24;
/** Refresh when last ring sample older than this. */
const STALE_SAMPLE_MS = 15_000;
/** Intrabar impulse window (1m). */
const INTRABAR_MS = 60_000;
/** Fast race window — catch forming green before bar close. */
const INTRABAR_FAST_MS = 20_000;

function envOn(key: string, defaultOn = true): boolean {
  return qualityEnvOn(process.env, key, defaultOn);
}

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
  impulseShape?: string;
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
      impulseShape: args.impulseShape ?? null,
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

  const scamGates = defaultScamLadderGates(process.env);
  const f8Gates = f8LeaderTapeGates(process.env);
  const f7Gates = f7LeaderTapeGates(process.env);
  const fEarlyGates = fEarlyLeaderTapeGates(process.env);
  const minSamplesForEval = Math.min(
    f8Gates.minSamples,
    f7Gates.minSamples,
    earlyTapeEnabled() ? fEarlyGates.minSamples : f8Gates.minSamples,
  );
  const requireLeaderBought = requireLeaderBoughtEnabled(process.env);
  /** Early/mid/intrabar may enter without allowlist (plan phase 4A). */
  const requireLeaderBoughtEarlyExempt = envOn(
    'VOL_GREEN_EARLY_SKIP_REQUIRE_LEADER_BOUGHT',
    true,
  );
  const leaderFlexAlways = envOn('VOL_GREEN_LEADER_FLEX', true);
  const intrabarFastOn = envOn('VOL_GREEN_INTRABAR_FAST', true);
  const intrabarFastMin = (() => {
    const n = Number(process.env.VOL_GREEN_INTRABAR_FAST_MIN_PC?.trim());
    return Number.isFinite(n) && n > 0 ? n : 6;
  })();

  const volumeEntryRaw = (
    process.env.MILD_DIP_VOLUME_IMPULSE_ENTRY ??
    process.env.VOL_GREEN_VOLUME_IMPULSE_ENTRY ??
    '0'
  )
    .trim()
    .toLowerCase();
  const volumeImpulseEntry =
    volumeEntryRaw === '1' || volumeEntryRaw === 'true' || volumeEntryRaw === 'yes';

  const maxPc5mRaw = Number(
    (
      process.env.VOL_GREEN_ENTRY_MAX_PC5M_PCT ??
      process.env.MILD_DIP_ENTRY_MAX_PC5M_PCT ??
      '15'
    ).trim(),
  );
  const maxEntryPc5mPct =
    Number.isFinite(maxPc5mRaw) && maxPc5mRaw > 0 ? maxPc5mRaw : 0;

  // Cliff RCA: skip when already off local peak / early path on thin tape.
  const offPeakOn = envOn('VOL_GREEN_OFF_PEAK_GUARD', true);
  const offPeakDd = offPeakDdMaxPct(process.env);
  const offPeakLb = offPeakLookbackMs(process.env);
  const thinEarlyOn = envOn('VOL_GREEN_EARLY_THIN_TAPE_GUARD', true);
  const earlyMinN = earlyMinSamples(process.env);
  const earlyMinSpan = earlyMinSampleSpanMs(process.env);
  const earlySampleLb = earlySampleLookbackMs(process.env);

  const pushOrSkipLadder = (
    mint: string,
    samples: Array<{ tsMs: number; priceUsd: number }>,
    cand: MildDipCandidate | null,
    opts?: { earlyPath?: boolean },
  ): void => {
    if (!cand) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: ['stream_impulse_no_price'],
      });
      return;
    }
    const earlyPath = opts?.earlyPath === true;
    const grind = detectMonotonicGrind(samples, scamGates, nowMs);
    if (grind.hit) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: grind.reasons,
        metrics: {
          priceChange5mPct: mildDipPriceRing.changeFromOldestPct(mint, 300_000, nowMs),
        },
      });
      return;
    }
    const ringPc5m = mildDipPriceRing.changeFromOldestPct(mint, 300_000, nowMs);
    if (
      maxEntryPc5mPct > 0 &&
      ringPc5m != null &&
      Number.isFinite(ringPc5m) &&
      ringPc5m > maxEntryPc5mPct
    ) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: [`chase_pc5m=${ringPc5m.toFixed(1)}>${maxEntryPc5mPct}`],
        metrics: { priceChange5mPct: ringPc5m },
      });
      mildDipHotMints.clearBuyForce(mint);
      return;
    }

    // Early path must have a real price tape — no 2–3 tick cliffs.
    if (thinEarlyOn && earlyPath) {
      const thin = isThinEarlyTape(samples, {
        nowMs,
        lookbackMs: earlySampleLb,
        minSamples: earlyMinN,
        minSpanMs: earlyMinSpan,
      });
      if (thin.hit) {
        skips.push({
          mint,
          entryMode: 'green_tape',
          reasons: [
            `early_thin_tape:n=${thin.samples}<${earlyMinN}_or_span=${thin.spanMs}<${earlyMinSpan}`,
          ],
          metrics: { priceChange5mPct: ringPc5m },
        });
        mildDipHotMints.clearBuyForce(mint);
        return;
      }
    }

    // Impulse already played out — last price too far below recent peak.
    if (offPeakOn) {
      const played = isImpulsePlayedOut(samples, {
        nowMs,
        lookbackMs: offPeakLb,
        maxDdPct: offPeakDd,
        minSamples: 4,
      });
      if (played.hit && played.ddPct != null) {
        skips.push({
          mint,
          entryMode: 'green_tape',
          reasons: [
            `impulse_played_out:dd=${played.ddPct.toFixed(1)}<-${offPeakDd}`,
          ],
          metrics: { priceChange5mPct: ringPc5m },
        });
        mildDipHotMints.clearBuyForce(mint);
        return;
      }
    }

    const tape = detectDualLeaderTape(samples, {
      nowMs,
      ringPc5mPct: ringPc5m,
    });
    if (!tape.pass) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: tape.reasons,
        metrics: {
          priceChange5mPct: ringPc5m,
          ...(tape.stats
            ? {
                triplePattern: {
                  small0: tape.stats.chg1m,
                  small1: tape.stats.maxG1m,
                  huge: tape.stats.runup25m,
                  hugeVol: 0,
                  hugeTs: Math.floor(nowMs / 1000),
                },
              }
            : {}),
        },
      });
      mildDipHotMints.clearBuyForce(mint);
      return;
    }
    if (tape.formula) {
      cand.metrics.leaderFormula = tape.formula;
    }
    // F_early counts as early — apply thin-tape if we only got here via tape.
    if (thinEarlyOn && tape.formula === 'F_early' && !earlyPath) {
      const thin = isThinEarlyTape(samples, {
        nowMs,
        lookbackMs: earlySampleLb,
        minSamples: earlyMinN,
        minSpanMs: earlyMinSpan,
      });
      if (thin.hit) {
        skips.push({
          mint,
          entryMode: 'green_tape',
          reasons: [
            `early_thin_tape:n=${thin.samples}<${earlyMinN}_or_span=${thin.spanMs}<${earlyMinSpan}`,
          ],
          metrics: { priceChange5mPct: ringPc5m },
        });
        mildDipHotMints.clearBuyForce(mint);
        return;
      }
    }
    // Allowlist: required for slow F8; early/mid/intrabar/F_early may race first-touch.
    const skipAllowlist =
      requireLeaderBoughtEarlyExempt &&
      (earlyPath || tape.formula === 'F_early');
    if (requireLeaderBought && !skipAllowlist && !hasLeaderBought(mint)) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: ['require_leader_bought'],
        metrics: { priceChange5mPct: ringPc5m },
      });
      mildDipHotMints.clearBuyForce(mint);
      return;
    }
    candidates.push(cand);
  };

  for (const { mint } of ranked) {
    const samples = mildDipPriceRing.listSamples(mint, LOOKBACK_MS, nowMs);

    if (samples.length >= 2) {
      const grindEarly = detectMonotonicGrind(samples, scamGates, nowMs);
      if (grindEarly.hit) {
        skips.push({
          mint,
          entryMode: 'green_tape',
          reasons: grindEarly.reasons,
          metrics: {
            priceChange5mPct: mildDipPriceRing.changeFromOldestPct(mint, 300_000, nowMs),
          },
        });
        mildDipHotMints.clearBuyForce(mint);
        continue;
      }
    }

    if (!volumeImpulseEntry && mildDipHotMints.isVolumeImpulse(mint, nowMs)) {
      // mark only
    } else if (volumeImpulseEntry && mildDipHotMints.isVolumeImpulse(mint, nowMs)) {
      const solN = mildDipHotMints.volumeImpulseSol(mint, nowMs);
      const last = mildDipPriceRing.lastPrice(mint, nowMs);
      const ringPc60 = mildDipPriceRing.changeFromOldestPct(mint, INTRABAR_MS, nowMs);
      if (last && last.priceUsd > 0 && solN > 0 && ringPc60 != null && ringPc60 < 3) {
        skips.push({
          mint,
          entryMode: 'green_tape',
          reasons: [
            `volume_no_price_impulse:sol=${solN.toFixed(2)} pc60=${ringPc60.toFixed(1)}`,
          ],
        });
        mildDipHotMints.clearBuyForce(mint);
        continue;
      }
      if (last && last.priceUsd > 0 && solN > 0) {
        const cand = candidateFromPass({
          mint,
          nowMs,
          entryPath: 'green_tape_impulse',
          score: solN * 10,
          huge: Math.max(firstStrongMin || 20, solN * 5),
          small0: 0,
          small1: 0,
          hugeVol: solN * 150,
          hugeTs: Math.floor(nowMs / 1000),
          impulseShape: 'volume',
        });
        pushOrSkipLadder(mint, samples, cand, { earlyPath: false });
        continue;
      }
    }

    if (samples.length < minSamplesForEval) {
      skips.push({
        mint,
        entryMode: 'green_tape',
        reasons: [
          `stream_impulse_need_samples=${samples.length}<${minSamplesForEval}`,
        ],
      });
      continue;
    }

    // Fast intrabar (20s) — race forming green before 1m close.
    if (intrabarFastOn && samples.length >= 4) {
      const ringPcFast = mildDipPriceRing.changeFromOldestPct(
        mint,
        INTRABAR_FAST_MS,
        nowMs,
      );
      if (
        ringPcFast != null &&
        Number.isFinite(ringPcFast) &&
        ringPcFast >= intrabarFastMin
      ) {
        const cand = candidateFromPass({
          mint,
          nowMs,
          entryPath: 'green_tape_impulse',
          score: ringPcFast,
          huge: +ringPcFast.toFixed(2),
          small0: 0,
          small1: 0,
          hugeVol: 0,
          hugeTs: Math.floor(nowMs / 1000),
          impulseShape: 'intrabar',
        });
        pushOrSkipLadder(mint, samples, cand, { earlyPath: true });
        continue;
      }
    }

    // Classic 60s intrabar (first-strong threshold).
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
          impulseShape: 'tip',
        });
        pushOrSkipLadder(mint, samples, cand, { earlyPath: true });
        continue;
      }
    }

    const flex =
      leaderFlexAlways || mildDipHotMints.isLeaderHighlight(mint, nowMs);

    const tg = await evaluateTripleGreenEntry({
      pairAddress: null,
      nowMs,
      localPriceSamples: samples,
      allowGeckoHttp: false,
      geckoPriority: false,
      leaderFlex: flex,
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
    // Mid-impulse: flex pattern has two "small" legs and a huge (not firstStrong shape).
    const midImpulse =
      flex &&
      tg.pattern != null &&
      !firstStrong &&
      tg.pattern.small1 !== 0;

    const cand = candidateFromPass({
      mint,
      nowMs,
      entryPath: firstStrong || midImpulse ? 'green_tape_impulse' : 'green_tape_triple',
      score:
        (tg.pattern?.huge ?? 0) + (tg.pattern?.small0 ?? 0) + (tg.pattern?.small1 ?? 0),
      huge: tg.pattern?.huge ?? 0,
      small0: tg.pattern?.small0 ?? 0,
      small1: tg.pattern?.small1 ?? 0,
      hugeVol: tg.pattern?.hugeVol ?? 0,
      hugeTs: tg.pattern?.hugeTs ?? Math.floor(nowMs / 1000),
      impulseShape: midImpulse ? 'mid' : firstStrong ? 'tip' : 'triple',
    });
    pushOrSkipLadder(mint, samples, cand, {
      earlyPath: midImpulse || firstStrong,
    });
  }

  return { candidates, skips };
}
