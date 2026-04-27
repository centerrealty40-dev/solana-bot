import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import type { HypothesisSignal } from '../hypotheses/base.js';

const log = child('risk-manager');

export interface RiskDecision {
  approved: boolean;
  reason?: string;
  /** allowed sizeUsd after caps */
  adjustedSizeUsd: number;
}

/**
 * Per-hypothesis risk gate applied to every entry signal.
 *
 * Checks:
 *   1. Hard cap on a single trade size (config.maxPositionUsd)
 *   2. Daily PnL kill-switch: if today's realized loss exceeds dailyLossLimitPct of
 *      a virtual capital baseline, reject all new entries
 *   3. Per-hypothesis open-position limit (5 by default)
 *   4. No duplicate entries for the same (hypothesis, baseMint) within 5 minutes
 *
 * Note: in paper mode the kill-switch still applies — we want the same shape of
 * curve we'd see in live.
 */
/** Hypotheses allowed to use the high-conviction position cap. */
const HIGH_CONVICTION_HYPOTHESES = new Set(['h7']);

export async function evaluate(signal: HypothesisSignal): Promise<RiskDecision> {
  // 1. hard cap (per-hypothesis tier)
  const sizeCap = HIGH_CONVICTION_HYPOTHESES.has(signal.hypothesisId)
    ? config.maxPositionUsdHighConviction
    : config.maxPositionUsd;
  const cappedSize = Math.min(signal.sizeUsd, sizeCap);

  // 2. daily PnL kill switch (paper mode uses virtual $1k baseline; live mode uses configured)
  const today = new Date().toISOString().slice(0, 10);
  const baseline = config.executorMode === 'live' ? 1000 : 1000;
  const todayRow = await db
    .select()
    .from(schema.dailyPnl)
    .where(
      dsql`${schema.dailyPnl.hypothesisId} = ${signal.hypothesisId}
        AND ${schema.dailyPnl.day} = ${today}
        AND ${schema.dailyPnl.mode} = ${config.executorMode}`,
    );
  const todayPnl = todayRow[0]?.realizedPnlUsd ?? 0;
  const lossPct = (-todayPnl / baseline) * 100;
  if (lossPct >= config.dailyLossLimitPct) {
    log.warn(
      { hypothesisId: signal.hypothesisId, lossPct },
      'daily loss limit reached — kill switch active',
    );
    return {
      approved: false,
      adjustedSizeUsd: 0,
      reason: `daily loss ${lossPct.toFixed(1)}% >= ${config.dailyLossLimitPct}%`,
    };
  }

  // 3. open positions cap
  const openCount = await db.execute(dsql`
    SELECT COUNT(*)::int AS n FROM positions
    WHERE hypothesis_id = ${signal.hypothesisId}
      AND status = 'open'
      AND mode = ${config.executorMode}
  `);
  const n = Number((openCount as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  if (n >= 5) {
    return { approved: false, adjustedSizeUsd: 0, reason: `${n} open positions, cap=5` };
  }

  // 4. dedupe within 5 minutes for same (hypo, mint)
  const recent = await db.execute(dsql`
    SELECT 1 FROM positions
    WHERE hypothesis_id = ${signal.hypothesisId}
      AND base_mint = ${signal.baseMint}
      AND mode = ${config.executorMode}
      AND opened_at >= now() - INTERVAL '5 minutes'
    LIMIT 1
  `);
  if ((recent as unknown as unknown[]).length > 0) {
    return { approved: false, adjustedSizeUsd: 0, reason: 'duplicate within 5min' };
  }

  return { approved: true, adjustedSizeUsd: cappedSize };
}
