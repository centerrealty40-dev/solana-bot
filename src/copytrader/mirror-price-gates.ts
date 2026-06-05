import type { CopyTraderConfig } from './config.js';
import type { DexInfo } from './dex-info.js';
import type { EvalResult } from './evaluate.js';

export function addPriceAboveLeaderCap(
  leaderPriceUsd: number,
  currentPriceUsd: number,
  maxPremiumPct: number,
): boolean {
  if (!(leaderPriceUsd > 0) || !(currentPriceUsd > 0)) return false;
  return currentPriceUsd > leaderPriceUsd * (1 + maxPremiumPct / 100);
}

export function partialSellPriceBelowLeaderFloor(
  leaderPriceUsd: number,
  currentPriceUsd: number,
  maxDrawdownPct: number,
): boolean {
  if (!(leaderPriceUsd > 0) || !(currentPriceUsd > 0)) return false;
  return currentPriceUsd < leaderPriceUsd * (1 - maxDrawdownPct / 100);
}

/** Add mirror: skip averaging when price already ran +N% above leader signal. */
export function evaluateCopyAdd(
  cfg: CopyTraderConfig,
  input: {
    mint: string;
    leaderPriceUsd: number;
    leaderBuyUsd: number;
    currentPriceUsd: number;
    dex: DexInfo | null;
    nowMs: number;
  },
): EvalResult {
  const reasons: string[] = [];
  let score = 0;

  if (!(input.leaderBuyUsd >= cfg.minLeaderBuyUsd)) {
    reasons.push(`leader_buy_usd=${input.leaderBuyUsd.toFixed(0)}<min=${cfg.minLeaderBuyUsd}`);
  } else {
    score += 1;
  }

  if (!(input.leaderPriceUsd > 0) || !(input.currentPriceUsd > 0)) {
    reasons.push('missing_price');
  } else if (addPriceAboveLeaderCap(input.leaderPriceUsd, input.currentPriceUsd, cfg.addMaxPremiumPct)) {
    reasons.push(
      `add_price_too_high current=${input.currentPriceUsd.toExponential(4)} max=${(input.leaderPriceUsd * (1 + cfg.addMaxPremiumPct / 100)).toExponential(4)}`,
    );
  } else {
    score += 2;
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
  }

  return { pass: reasons.length === 0, reasons, score };
}
