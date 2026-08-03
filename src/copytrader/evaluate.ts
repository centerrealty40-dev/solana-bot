import type { CopyTraderConfig } from './config.js';
import type { DexInfo } from './dex-info.js';
import { entryDipMaxPriceUsd } from './entry-probe.js';

export type EvalInput = {
  mint: string;
  leaderPriceUsd: number;
  leaderBuyUsd: number;
  currentPriceUsd: number;
  dex: DexInfo | null;
  nowMs: number;
  /** Our probe leg avg entry — dip must also be below this (split entry). */
  probeEntryPriceUsd?: number;
};

export type EvalResult = {
  pass: boolean;
  reasons: string[];
  score: number;
};

export type QuotePremiumVerdict =
  | { block: false; premiumPct: number | null }
  | { block: true; premiumPct: number; maxAllowedPriceUsd: number; reason: string };

/**
 * Post-quote premium guard.
 *
 * `evaluateCopyEntry` caps premium against the DEX snapshot price, which can be
 * minutes stale by the time the Jupiter quote lands. Without a second check the
 * swap executes at whatever the route offers — live journals show fills up to
 * +23% over the leader on a 3% cap, turning the leader's winners into our
 * losers. This re-checks the executable quote price right before sending.
 */
export function checkQuotePremium(args: {
  quotePriceUsd: number;
  leaderPriceUsd: number;
  maxPremiumPct: number;
}): QuotePremiumVerdict {
  const { quotePriceUsd, leaderPriceUsd, maxPremiumPct } = args;
  if (!(quotePriceUsd > 0) || !(leaderPriceUsd > 0) || !(maxPremiumPct >= 0)) {
    return { block: false, premiumPct: null };
  }
  const premiumPct = (quotePriceUsd / leaderPriceUsd - 1) * 100;
  const maxAllowedPriceUsd = leaderPriceUsd * (1 + maxPremiumPct / 100);
  if (quotePriceUsd <= maxAllowedPriceUsd) return { block: false, premiumPct };
  return {
    block: true,
    premiumPct,
    maxAllowedPriceUsd,
    reason: `quote_premium_too_high premium=${premiumPct.toFixed(2)}%>max=${maxPremiumPct}%`,
  };
}

/**
 * Cap used for the live Jupiter quote check. Inside the grace window after the
 * leader fill we allow a wider first shot; past that we fall back to the steady
 * guard. A miss is terminal either way — see `isBuyTerminalError`.
 */
export function effectiveQuotePremiumCap(args: {
  guardPct: number;
  firstShotPct: number;
  graceMs: number;
  leaderBuyTs: number;
  nowMs: number;
}): { maxPremiumPct: number; firstShot: boolean } {
  const { guardPct, firstShotPct, graceMs, leaderBuyTs, nowMs } = args;
  if (!(guardPct > 0) && !(firstShotPct > 0)) return { maxPremiumPct: 0, firstShot: false };
  const ageMs = leaderBuyTs > 0 ? nowMs - leaderBuyTs : Number.POSITIVE_INFINITY;
  const inGrace = graceMs > 0 && ageMs >= 0 && ageMs <= graceMs;
  if (inGrace && firstShotPct > 0) {
    return { maxPremiumPct: Math.max(guardPct, firstShotPct), firstShot: true };
  }
  return { maxPremiumPct: guardPct, firstShot: false };
}

function marketCapEval(cfg: CopyTraderConfig, dex: DexInfo): { fail?: string; scoreInc: number } {
  if (cfg.minMarketCapUsd <= 0) return { scoreInc: 0 };
  if (!(dex.marketCap > 0)) {
    return { fail: `mcap_missing_or_zero<min=${cfg.minMarketCapUsd}`, scoreInc: 0 };
  }
  if (dex.marketCap < cfg.minMarketCapUsd) {
    return {
      fail: `mcap=${Math.round(dex.marketCap)}<min=${cfg.minMarketCapUsd}`,
      scoreInc: 0,
    };
  }
  return { scoreInc: 1 };
}

export function evaluateCopyEntry(cfg: CopyTraderConfig, input: EvalInput): EvalResult {
  const reasons: string[] = [];
  let score = 0;

  if (!(input.leaderBuyUsd >= cfg.minLeaderBuyUsd)) {
    reasons.push(`leader_buy_usd=${input.leaderBuyUsd.toFixed(0)}<min=${cfg.minLeaderBuyUsd}`);
  } else {
    score += 1;
  }

  if (!(input.leaderPriceUsd > 0) || !(input.currentPriceUsd > 0)) {
    reasons.push('missing_price');
  } else {
    const maxAllowed = input.leaderPriceUsd * (1 + cfg.buyPriceMaxPremiumPct / 100);
    if (input.currentPriceUsd > maxAllowed) {
      reasons.push(
        `price_too_high current=${input.currentPriceUsd.toExponential(4)} max=${maxAllowed.toExponential(4)}`,
      );
    } else {
      score += 2;
      if (input.currentPriceUsd <= input.leaderPriceUsd) score += 1;
    }
  }

  const dex = input.dex;
  if (!dex) {
    reasons.push('no_dex_data');
  } else {
    if (cfg.minLiquidityUsd > 0 && dex.liquidityUsd < cfg.minLiquidityUsd) {
      reasons.push(`liquidity=${Math.round(dex.liquidityUsd)}<min=${cfg.minLiquidityUsd}`);
    } else if (dex.liquidityUsd > 0) {
      score += 1;
    }

    const mcap = marketCapEval(cfg, dex);
    if (mcap.fail) reasons.push(mcap.fail);
    else score += mcap.scoreInc;

    if (cfg.maxMarketCapUsd > 0 && dex.marketCap > cfg.maxMarketCapUsd) {
      reasons.push(`mcap=${Math.round(dex.marketCap)}>max=${cfg.maxMarketCapUsd}`);
    }

    if (cfg.minPairAgeHours > 0 && dex.pairCreatedAtMs) {
      const ageH = (input.nowMs - dex.pairCreatedAtMs) / 3_600_000;
      if (ageH < cfg.minPairAgeHours) {
        reasons.push(`pair_age_h=${ageH.toFixed(1)}<min=${cfg.minPairAgeHours}`);
      } else {
        score += 1;
      }
    }

    if (dex.volume1h > 0 && dex.liquidityUsd > 0) {
      const turnover = dex.volume1h / dex.liquidityUsd;
      if (turnover >= 0.05 && turnover <= 8) score += 1;
    }
  }

  const pass = reasons.length === 0;
  return { pass, reasons, score };
}

/** Dip leg: enter at or below leader −discount% (no +premium chase). */
export function evaluateCopyEntryDip(cfg: CopyTraderConfig, input: EvalInput): EvalResult {
  const reasons: string[] = [];
  let score = 0;

  if (!(input.leaderBuyUsd >= cfg.minLeaderBuyUsd)) {
    reasons.push(`leader_buy_usd=${input.leaderBuyUsd.toFixed(0)}<min=${cfg.minLeaderBuyUsd}`);
  } else {
    score += 1;
  }

  if (!(input.leaderPriceUsd > 0) || !(input.currentPriceUsd > 0)) {
    reasons.push('missing_price');
  } else {
    const maxAllowed = entryDipMaxPriceUsd(cfg, input.leaderPriceUsd, input.probeEntryPriceUsd);
    if (input.currentPriceUsd > maxAllowed) {
      const leaderCap = entryDipMaxPriceUsd(cfg, input.leaderPriceUsd);
      const probePx = input.probeEntryPriceUsd ?? 0;
      const probeOnlyCap =
        probePx > 0 && cfg.entryDipVsProbePct > 0
          ? probePx * (1 - cfg.entryDipVsProbePct / 100)
          : null;
      const detail =
        probeOnlyCap != null && probeOnlyCap < leaderCap
          ? ` (probe_cap=${probeOnlyCap.toExponential(4)} leader_cap=${leaderCap.toExponential(4)})`
          : '';
      reasons.push(
        `price_not_low_enough current=${input.currentPriceUsd.toExponential(4)} max=${maxAllowed.toExponential(4)}${detail}`,
      );
    } else {
      score += 2;
      if (input.currentPriceUsd <= maxAllowed * 0.99) score += 1;
    }
  }

  const dex = input.dex;
  if (!dex) {
    reasons.push('no_dex_data');
  } else {
    if (cfg.minLiquidityUsd > 0 && dex.liquidityUsd < cfg.minLiquidityUsd) {
      reasons.push(`liquidity=${Math.round(dex.liquidityUsd)}<min=${cfg.minLiquidityUsd}`);
    } else if (dex.liquidityUsd > 0) {
      score += 1;
    }

    const mcap = marketCapEval(cfg, dex);
    if (mcap.fail) reasons.push(mcap.fail);
    else score += mcap.scoreInc;

    if (cfg.maxMarketCapUsd > 0 && dex.marketCap > cfg.maxMarketCapUsd) {
      reasons.push(`mcap=${Math.round(dex.marketCap)}>max=${cfg.maxMarketCapUsd}`);
    }

    if (cfg.minPairAgeHours > 0 && dex.pairCreatedAtMs) {
      const ageH = (input.nowMs - dex.pairCreatedAtMs) / 3_600_000;
      if (ageH < cfg.minPairAgeHours) {
        reasons.push(`pair_age_h=${ageH.toFixed(1)}<min=${cfg.minPairAgeHours}`);
      } else {
        score += 1;
      }
    }

    if (dex.volume1h > 0 && dex.liquidityUsd > 0) {
      const turnover = dex.volume1h / dex.liquidityUsd;
      if (turnover >= 0.05 && turnover <= 8) score += 1;
    }
  }

  return { pass: reasons.length === 0, reasons, score };
}

/** Proportional add: mirror leader add price — no +premium chase (unlike entry probe). */
export function evaluateCopyAdd(cfg: CopyTraderConfig, input: EvalInput): EvalResult {
  const reasons: string[] = [];
  let score = 0;

  if (!(input.leaderBuyUsd >= cfg.minLeaderBuyUsd)) {
    reasons.push(`leader_buy_usd=${input.leaderBuyUsd.toFixed(0)}<min=${cfg.minLeaderBuyUsd}`);
  } else {
    score += 1;
  }

  if (!(input.leaderPriceUsd > 0) || !(input.currentPriceUsd > 0)) {
    reasons.push('missing_price');
  } else {
    const maxAllowed = input.leaderPriceUsd * (1 + cfg.addPriceMaxPremiumPct / 100);
    if (input.currentPriceUsd > maxAllowed) {
      reasons.push(
        `add_price_too_high current=${input.currentPriceUsd.toExponential(4)} max=${maxAllowed.toExponential(4)}`,
      );
    } else {
      score += 2;
      if (input.currentPriceUsd <= input.leaderPriceUsd) score += 1;
    }
  }

  const dex = input.dex;
  if (!dex) {
    reasons.push('no_dex_data');
  } else {
    if (cfg.minLiquidityUsd > 0 && dex.liquidityUsd < cfg.minLiquidityUsd) {
      reasons.push(`liquidity=${Math.round(dex.liquidityUsd)}<min=${cfg.minLiquidityUsd}`);
    } else if (dex.liquidityUsd > 0) {
      score += 1;
    }

    const mcap = marketCapEval(cfg, dex);
    if (mcap.fail) reasons.push(mcap.fail);
    else score += mcap.scoreInc;

    if (cfg.maxMarketCapUsd > 0 && dex.marketCap > cfg.maxMarketCapUsd) {
      reasons.push(`mcap=${Math.round(dex.marketCap)}>max=${cfg.maxMarketCapUsd}`);
    }

    if (cfg.minPairAgeHours > 0 && dex.pairCreatedAtMs) {
      const ageH = (input.nowMs - dex.pairCreatedAtMs) / 3_600_000;
      if (ageH < cfg.minPairAgeHours) {
        reasons.push(`pair_age_h=${ageH.toFixed(1)}<min=${cfg.minPairAgeHours}`);
      } else {
        score += 1;
      }
    }

    if (dex.volume1h > 0 && dex.liquidityUsd > 0) {
      const turnover = dex.volume1h / dex.liquidityUsd;
      if (turnover >= 0.05 && turnover <= 8) score += 1;
    }
  }

  return { pass: reasons.length === 0, reasons, score };
}
