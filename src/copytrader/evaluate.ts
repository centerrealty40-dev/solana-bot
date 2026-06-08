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
