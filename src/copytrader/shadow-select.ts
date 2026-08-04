/**
 * Shadow selection model for leader buys — paper filter only unless
 * `shadowSelectFilterLive` is on.
 *
 * Fitted 2026-08-04 on 36h case-control (PG-covered leader buys vs same-minute
 * universe): vol5m ≥ $2k AND buys/sells ≥ 1.0 → ~76% recall, ~4× lift.
 */
import type { CopyTraderConfig } from './config.js';
import type { CopyEntryContext } from './entry-context.js';

export type ShadowSelectConfig = Pick<
  CopyTraderConfig,
  | 'shadowSelectEnabled'
  | 'shadowSelectMinVolume5mUsd'
  | 'shadowSelectMinBuySellRatio5m'
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
    `vol5m>=${cfg.shadowSelectMinVolume5mUsd}`,
    `bs>=${cfg.shadowSelectMinBuySellRatio5m}`,
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

  if (cfg.shadowSelectMinVolume5mUsd > 0) {
    if (ctx.volume5mUsd == null || !Number.isFinite(ctx.volume5mUsd)) {
      reasons.push('volume_5m_unknown');
    } else if (ctx.volume5mUsd < cfg.shadowSelectMinVolume5mUsd) {
      reasons.push(
        `volume_5m_usd=${Math.round(ctx.volume5mUsd)}<min=${cfg.shadowSelectMinVolume5mUsd}`,
      );
    }
  }

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
