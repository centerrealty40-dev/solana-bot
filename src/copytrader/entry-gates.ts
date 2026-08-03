/**
 * Selective copy gates for a leader who fires ~590 buys a day.
 *
 * Copied blind, at our entry lag and round trip cost, his flow is negative. What
 * separates the profitable part is how much the pool is actually being traded:
 * 5m volume against liquidity, and 1h volume against market cap. Pools with no
 * turnover neither absorb our clip nor move for us. Pair age is the one other
 * feature that reproduces — his edge is in the first day of a pair's life.
 *
 * Market cap, liquidity and clip size on their own do not survive an
 * out-of-sample check; neither does his prior record on the same mint. See
 * LEADER_8ZKG_AUDIT.md "Market structure, measured properly".
 */
import type { CopyTraderConfig } from './config.js';
import type { CopyEntryContext } from './entry-context.js';
import type { LeaderMintStats } from './leader-history.js';

export type LeaderGateConfig = Pick<
  CopyTraderConfig,
  | 'leaderGatesEnabled'
  | 'minLeaderPriorSessions'
  | 'minLeaderPriorAvgPct'
  | 'entryMinPairAgeHours'
  | 'entryMaxPairAgeHours'
  | 'entryMinBuySellRatio5m'
  | 'entryMaxChase5mPct'
  | 'entryMinTurnover5m'
  | 'entryMinVolToMcap1h'
  | 'entryMinVolume5mUsd'
>;

export type LeaderGateResult = {
  pass: boolean;
  reasons: string[];
};

const PASS: LeaderGateResult = { pass: true, reasons: [] };

/** Null unless both sides are usable, so a missing feed reads as unknown, not zero. */
function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || !Number.isFinite(numerator) || numerator < 0) return null;
  if (denominator == null || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * State-only gate — free to evaluate, so callers run it before spending a
 * DexScreener request on market context.
 *
 * Measured rank correlation with our realised return is ~0.01, and the bucket
 * with the fewest prior sessions was the best one out of sample, so this is off
 * for 8zkgFGVZ. Kept configurable for lanes that have not been measured.
 */
export function evaluateLeaderPriorGate(
  cfg: LeaderGateConfig,
  stats: LeaderMintStats | null,
): LeaderGateResult {
  if (!cfg.leaderGatesEnabled) return PASS;

  const minSessions = cfg.minLeaderPriorSessions;
  if (minSessions > 0) {
    const sessions = stats?.sessions ?? 0;
    if (sessions < minSessions) {
      return { pass: false, reasons: [`leader_prior_sessions=${sessions}<min=${minSessions}`] };
    }
  }

  if (stats && cfg.minLeaderPriorAvgPct > -100) {
    if (!(stats.avgPct > cfg.minLeaderPriorAvgPct)) {
      return {
        pass: false,
        reasons: [
          `leader_prior_avg_pct=${stats.avgPct.toFixed(1)}<=min=${cfg.minLeaderPriorAvgPct} (n=${stats.sessions})`,
        ],
      };
    }
  }

  return PASS;
}

/**
 * Market-context gate. Missing context fails closed: these thresholds are the
 * whole reason we are being selective, so an unknown value is not a pass.
 */
export function evaluateLeaderMarketGate(
  cfg: LeaderGateConfig,
  ctx: CopyEntryContext | null,
): LeaderGateResult {
  if (!cfg.leaderGatesEnabled) return PASS;

  const wantsAge = cfg.entryMinPairAgeHours > 0 || cfg.entryMaxPairAgeHours > 0;
  const wantsPressure = cfg.entryMinBuySellRatio5m > 0;
  const wantsChase = cfg.entryMaxChase5mPct > 0;
  const wantsTurnover = cfg.entryMinTurnover5m > 0;
  const wantsVolToMcap = cfg.entryMinVolToMcap1h > 0;
  const wantsVol5m = cfg.entryMinVolume5mUsd > 0;
  if (!wantsAge && !wantsPressure && !wantsChase && !wantsTurnover && !wantsVolToMcap && !wantsVol5m) {
    return PASS;
  }

  if (!ctx) return { pass: false, reasons: ['no_entry_context'] };

  const reasons: string[] = [];

  if (wantsAge) {
    if (ctx.pairAgeHours == null) {
      reasons.push('pair_age_unknown');
    } else {
      if (cfg.entryMinPairAgeHours > 0 && ctx.pairAgeHours < cfg.entryMinPairAgeHours) {
        reasons.push(`pair_age_h=${ctx.pairAgeHours.toFixed(1)}<min=${cfg.entryMinPairAgeHours}`);
      }
      if (cfg.entryMaxPairAgeHours > 0 && ctx.pairAgeHours > cfg.entryMaxPairAgeHours) {
        reasons.push(`pair_age_h=${ctx.pairAgeHours.toFixed(1)}>max=${cfg.entryMaxPairAgeHours}`);
      }
    }
  }

  if (wantsPressure) {
    if (ctx.buySellRatio5m == null) {
      reasons.push('buy_sell_ratio_unknown');
    } else if (ctx.buySellRatio5m < cfg.entryMinBuySellRatio5m) {
      reasons.push(
        `buy_sell_5m=${ctx.buySellRatio5m.toFixed(2)}<min=${cfg.entryMinBuySellRatio5m}`,
      );
    }
  }

  if (wantsChase) {
    if (ctx.priceChange5mPct == null) {
      reasons.push('price_change_5m_unknown');
    } else if (ctx.priceChange5mPct > cfg.entryMaxChase5mPct) {
      reasons.push(`chase_5m_pct=${ctx.priceChange5mPct.toFixed(1)}>max=${cfg.entryMaxChase5mPct}`);
    }
  }

  if (wantsTurnover) {
    const turnover = ratio(ctx.volume5mUsd, ctx.liquidityUsd);
    if (turnover == null) {
      reasons.push('turnover_5m_unknown');
    } else if (turnover < cfg.entryMinTurnover5m) {
      reasons.push(`turnover_5m=${turnover.toFixed(3)}<min=${cfg.entryMinTurnover5m}`);
    }
  }

  if (wantsVolToMcap) {
    const share = ratio(ctx.volume1hUsd, ctx.marketCapUsd);
    if (share == null) {
      reasons.push('vol_to_mcap_1h_unknown');
    } else if (share < cfg.entryMinVolToMcap1h) {
      reasons.push(`vol_to_mcap_1h=${share.toFixed(3)}<min=${cfg.entryMinVolToMcap1h}`);
    }
  }

  if (wantsVol5m) {
    if (ctx.volume5mUsd == null || !(ctx.volume5mUsd > 0)) {
      reasons.push('volume_5m_unknown');
    } else if (ctx.volume5mUsd < cfg.entryMinVolume5mUsd) {
      reasons.push(
        `volume_5m_usd=${Math.round(ctx.volume5mUsd)}<min=${cfg.entryMinVolume5mUsd}`,
      );
    }
  }

  return { pass: reasons.length === 0, reasons };
}

export function evaluateLeaderCopyGates(
  cfg: LeaderGateConfig,
  input: { stats: LeaderMintStats | null; ctx: CopyEntryContext | null },
): LeaderGateResult {
  const prior = evaluateLeaderPriorGate(cfg, input.stats);
  const market = evaluateLeaderMarketGate(cfg, input.ctx);
  const reasons = [...prior.reasons, ...market.reasons];
  return { pass: reasons.length === 0, reasons };
}
