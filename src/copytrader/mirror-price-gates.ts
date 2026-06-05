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

/** Gate on Jupiter quote price right before send (not stale Dex). */
export function buyQuoteGateReason(
  cfg: CopyTraderConfig,
  kind: 'entry' | 'add',
  leaderPriceUsd: number,
  quotePriceUsd: number,
): string | null {
  if (!(leaderPriceUsd > 0) || !(quotePriceUsd > 0)) return 'quote_missing_price';
  const maxPct = kind === 'add' ? cfg.addMaxPremiumPct : cfg.buyPriceMaxPremiumPct;
  const prefix = kind === 'add' ? 'quote_add_price_too_high' : 'quote_entry_price_too_high';
  if (addPriceAboveLeaderCap(leaderPriceUsd, quotePriceUsd, maxPct)) {
    const max = leaderPriceUsd * (1 + maxPct / 100);
    return `${prefix} quote=${quotePriceUsd.toExponential(4)} leader=${leaderPriceUsd.toExponential(4)} max=${max.toExponential(4)}`;
  }
  return null;
}

export function partialSellQuoteGateReason(
  cfg: CopyTraderConfig,
  leaderPriceUsd: number,
  quotePriceUsd: number,
): string | null {
  if (!(leaderPriceUsd > 0) || !(quotePriceUsd > 0)) return null;
  if (partialSellPriceBelowLeaderFloor(leaderPriceUsd, quotePriceUsd, cfg.partialSellMaxDrawdownPct)) {
    return `quote_partial_sell_price_too_low quote=${quotePriceUsd.toExponential(4)} leader=${leaderPriceUsd.toExponential(4)}`;
  }
  return null;
}

export function isQuoteGateDeferReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    reason.startsWith('quote_entry_price_too_high') ||
    reason.startsWith('quote_add_price_too_high') ||
    reason.startsWith('quote_partial_sell_price_too_low') ||
    reason === 'quote_missing_price'
  );
}

/** Add mirror: liquidity / leader size only; price gate runs on Jupiter quote. */
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
