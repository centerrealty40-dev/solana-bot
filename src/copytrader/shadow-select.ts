/**
 * Shadow selection model for leader buys — paper filter only unless
 * `shadowSelectFilterLive` is on.
 *
 * Dump-first (2026-08-05): leader buys are mostly red 5m candles
 * (median pc5 ≈ −5…−6%, ~73% negative). wouldBuy when:
 *   priceChange5mPct ≤ maxPriceChange5mPct (default −5 = ≥5% dump)
 *   AND buySellRatio5m < maxBuySellRatio5m (default 1 = sell pressure)
 * Volume / min-bs floors are off by default — high vol5m alone is not the signal.
 */
import type { CopyTraderConfig } from './config.js';
import type { CopyEntryContext } from './entry-context.js';

export type ShadowSelectConfig = Pick<
  CopyTraderConfig,
  | 'shadowSelectEnabled'
  | 'shadowSelectMinVolume5mUsd'
  | 'shadowSelectMinBuySellRatio5m'
  | 'shadowSelectMaxPriceChange5mPct'
  | 'shadowSelectMaxBuySellRatio5m'
  | 'shadowSelectMinMcapUsd'
  | 'shadowSelectMinLiquidityUsd'
  | 'shadowSelectRequireCtx'
>;

export type ShadowSelectMetrics = {
  volume5mUsd: number | null;
  buySellRatio5m: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  pairAgeHours: number | null;
  priceChange5mPct: number | null;
};

export type ShadowSelectResult = {
  wouldBuy: boolean;
  reasons: string[];
  metrics: ShadowSelectMetrics;
  ruleId: string;
};

export function shadowSelectRuleId(cfg: ShadowSelectConfig): string {
  return [
    `dump5m<=${cfg.shadowSelectMaxPriceChange5mPct}`,
    `bs<${cfg.shadowSelectMaxBuySellRatio5m}`,
    `vol5m>=${cfg.shadowSelectMinVolume5mUsd}`,
    `bsMin>=${cfg.shadowSelectMinBuySellRatio5m}`,
    `mcap>=${cfg.shadowSelectMinMcapUsd}`,
    `liq>=${cfg.shadowSelectMinLiquidityUsd}`,
  ].join('|');
}

export function metricsFromCtx(ctx: CopyEntryContext | null): ShadowSelectMetrics {
  return {
    volume5mUsd: ctx?.volume5mUsd ?? null,
    buySellRatio5m: ctx?.buySellRatio5m ?? null,
    marketCapUsd: ctx?.marketCapUsd ?? null,
    liquidityUsd: ctx?.liquidityUsd ?? null,
    pairAgeHours: ctx?.pairAgeHours ?? null,
    priceChange5mPct: ctx?.priceChange5mPct ?? null,
  };
}

/**
 * Evaluate whether the shadow model would have selected this mint at the
 * moment we saw the leader buy. Missing context fails closed when
 * `shadowSelectRequireCtx` is true (default).
 */
export function evaluateShadowSelect(
  cfg: ShadowSelectConfig,
  ctx: CopyEntryContext | null,
): ShadowSelectResult {
  const metrics = metricsFromCtx(ctx);
  const ruleId = shadowSelectRuleId(cfg);
  const reasons: string[] = [];

  if (!cfg.shadowSelectEnabled) {
    return { wouldBuy: false, reasons: ['shadow_disabled'], metrics, ruleId };
  }

  if (!ctx) {
    if (cfg.shadowSelectRequireCtx) {
      return { wouldBuy: false, reasons: ['ctx_missing'], metrics, ruleId };
    }
    return { wouldBuy: true, reasons: [], metrics, ruleId };
  }

  /** Dump gate: require pc5 ≤ max (default −5). Disabled when max ≥ 1000. */
  if (cfg.shadowSelectMaxPriceChange5mPct < 1000) {
    if (ctx.priceChange5mPct == null || !Number.isFinite(ctx.priceChange5mPct)) {
      reasons.push('price_change_5m_unknown');
    } else if (ctx.priceChange5mPct > cfg.shadowSelectMaxPriceChange5mPct) {
      reasons.push(
        `dump_5m_pct=${ctx.priceChange5mPct.toFixed(1)}>max=${cfg.shadowSelectMaxPriceChange5mPct}`,
      );
    }
  }

  /**
   * Sell-pressure cap: require buy/sell < max (default 1). **0** = off.
   * Opposite of the old min-bs≥1 “momentum” rule.
   */
  if (cfg.shadowSelectMaxBuySellRatio5m > 0) {
    if (ctx.buySellRatio5m == null || !Number.isFinite(ctx.buySellRatio5m)) {
      reasons.push('buy_sell_ratio_unknown');
    } else if (ctx.buySellRatio5m >= cfg.shadowSelectMaxBuySellRatio5m) {
      reasons.push(
        `buy_sell_5m=${ctx.buySellRatio5m.toFixed(2)}>=max=${cfg.shadowSelectMaxBuySellRatio5m}`,
      );
    }
  }

  if (cfg.shadowSelectMinVolume5mUsd > 0) {
    if (ctx.volume5mUsd == null || !Number.isFinite(ctx.volume5mUsd)) {
      reasons.push('volume_5m_unknown');
    } else if (ctx.volume5mUsd < cfg.shadowSelectMinVolume5mUsd) {
      reasons.push(
        `volume_5m_usd=${Math.round(ctx.volume5mUsd)}<min=${cfg.shadowSelectMinVolume5mUsd}`,
      );
    }
  }

  /** Legacy min buy/sell floor — off by default (0). Prefer maxBuySellRatio5m. */
  if (cfg.shadowSelectMinBuySellRatio5m > 0) {
    if (ctx.buySellRatio5m == null || !Number.isFinite(ctx.buySellRatio5m)) {
      reasons.push('buy_sell_ratio_unknown');
    } else if (ctx.buySellRatio5m < cfg.shadowSelectMinBuySellRatio5m) {
      reasons.push(
        `buy_sell_5m=${ctx.buySellRatio5m.toFixed(2)}<min=${cfg.shadowSelectMinBuySellRatio5m}`,
      );
    }
  }

  if (cfg.shadowSelectMinMcapUsd > 0) {
    if (ctx.marketCapUsd == null || !(ctx.marketCapUsd > 0)) {
      reasons.push('mcap_unknown');
    } else if (ctx.marketCapUsd < cfg.shadowSelectMinMcapUsd) {
      reasons.push(`mcap=${Math.round(ctx.marketCapUsd)}<min=${cfg.shadowSelectMinMcapUsd}`);
    }
  }

  if (cfg.shadowSelectMinLiquidityUsd > 0) {
    if (ctx.liquidityUsd == null || !(ctx.liquidityUsd > 0)) {
      reasons.push('liq_unknown');
    } else if (ctx.liquidityUsd < cfg.shadowSelectMinLiquidityUsd) {
      reasons.push(`liq=${Math.round(ctx.liquidityUsd)}<min=${cfg.shadowSelectMinLiquidityUsd}`);
    }
  }

  return { wouldBuy: reasons.length === 0, reasons, metrics, ruleId };
}
