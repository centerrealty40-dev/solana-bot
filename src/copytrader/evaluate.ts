import type { CopyTraderConfig } from './config.js';
import type { DexInfo } from './dex-info.js';

export type EvalInput = {
  mint: string;
  leaderPriceUsd: number;
  leaderBuyUsd: number;
  currentPriceUsd: number;
  dex: DexInfo | null;
  nowMs: number;
};

export type EvalResult = {
  pass: boolean;
  reasons: string[];
  score: number;
};

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

    if (cfg.minMarketCapUsd > 0 && dex.marketCap > 0 && dex.marketCap < cfg.minMarketCapUsd) {
      reasons.push(`mcap=${Math.round(dex.marketCap)}<min=${cfg.minMarketCapUsd}`);
    } else if (dex.marketCap > 0) {
      score += 1;
    }

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
