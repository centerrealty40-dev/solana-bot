/**
 * Selective copy gates derived from the 30d audit of leader 8zkgFGVZ.
 *
 * The leader fires ~590 buys/day; roughly half are one-off entries into mints he
 * never revisits and they are net negative. These gates keep the slice that
 * carries his edge: young-but-not-brand-new pairs, mild buyer pressure, no
 * post-spike chase, and mints where he already has a positive track record.
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
>;

export type LeaderGateResult = {
  pass: boolean;
  reasons: string[];
};

const PASS: LeaderGateResult = { pass: true, reasons: [] };

/**
 * State-only gate — free to evaluate, so callers run it before spending a
 * DexScreener request on market context.
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
  if (!wantsAge && !wantsPressure && !wantsChase) return PASS;

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
