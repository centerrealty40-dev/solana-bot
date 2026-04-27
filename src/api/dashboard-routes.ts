import type { FastifyInstance } from 'fastify';
import { sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { z } from 'zod';

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  /** Per-hypothesis P&L summary across all closed positions. */
  app.get('/api/hypotheses/summary', async () => {
    const rows = await db.execute(dsql`
      SELECT
        hypothesis_id,
        mode,
        count(*) FILTER (WHERE status = 'closed') AS trades,
        count(*) FILTER (WHERE status = 'closed' AND realized_pnl_usd > 0) AS wins,
        coalesce(sum(realized_pnl_usd), 0) AS total_pnl,
        coalesce(avg(realized_pnl_usd) FILTER (WHERE status = 'closed'), 0) AS avg_pnl,
        coalesce(sum(cost_usd), 0) AS total_cost
      FROM positions
      GROUP BY hypothesis_id, mode
      ORDER BY hypothesis_id, mode
    `);
    return { rows };
  });

  /** Recent signals list — for live debugging. */
  app.get('/api/signals/recent', async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        hypothesisId: z.string().optional(),
      })
      .parse(req.query);
    const where = q.hypothesisId
      ? dsql`hypothesis_id = ${q.hypothesisId}`
      : dsql`true`;
    const rows = await db.execute(dsql`
      SELECT id, hypothesis_id, ts, base_mint, side, size_usd, accepted, reject_reason, reason
      FROM signals
      WHERE ${where}
      ORDER BY ts DESC
      LIMIT ${q.limit}
    `);
    return { rows };
  });

  /** Open positions across all hypotheses. */
  app.get('/api/positions/open', async () => {
    const rows = await db
      .select()
      .from(schema.positions)
      .where(dsql`${schema.positions.status} = 'open'`)
      .limit(500);
    return { rows };
  });

  /** Top wallet scores. */
  app.get('/api/wallets/top', async (req) => {
    const q = z
      .object({
        metric: z
          .enum(['realized_pnl_30d', 'early_entry_score', 'consistency_score'])
          .default('realized_pnl_30d'),
        limit: z.coerce.number().int().min(1).max(500).default(50),
      })
      .parse(req.query);
    const rows = await db.execute(dsql`
      SELECT *
      FROM wallet_scores
      WHERE ${dsql.raw(q.metric)} > 0
      ORDER BY ${dsql.raw(q.metric)} DESC
      LIMIT ${q.limit}
    `);
    return { rows };
  });
}
