import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { config } from '../core/config.js';
import { notifyDailyReport, type DailyHypothesisRow } from '../runner/telegram.js';
import { ALL_HYPOTHESES } from '../runner/registry.js';

/**
 * Manually trigger the daily report (same payload as the runner cron at 21:00 UTC).
 * Optional CLI arg: ISO date "YYYY-MM-DD" (defaults to today, UTC).
 *
 * Usage:
 *   npm run report:daily              # today
 *   npm run report:daily 2026-04-19   # specific day
 */
async function main(): Promise<void> {
  const day = process.argv[2] ?? new Date().toISOString().slice(0, 10);
  const rows = await db.execute(dsql`
    SELECT hypothesis_id,
           COALESCE(SUM(trades_count), 0)::int AS trades,
           COALESCE(SUM(wins_count), 0)::int   AS wins,
           COALESCE(SUM(realized_pnl_usd), 0)::float AS pnl
    FROM daily_pnl
    WHERE day = ${day} AND mode = ${config.executorMode}
    GROUP BY hypothesis_id
  `);
  const m = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const r of rows as unknown as Array<{
    hypothesis_id: string;
    trades: number;
    wins: number;
    pnl: number;
  }>) {
    m.set(r.hypothesis_id, { trades: r.trades, wins: r.wins, pnl: r.pnl });
  }
  const reportRows: DailyHypothesisRow[] = ALL_HYPOTHESES.map((h) => ({
    hypothesisId: h.id,
    trades: m.get(h.id)?.trades ?? 0,
    wins: m.get(h.id)?.wins ?? 0,
    realizedPnlUsd: m.get(h.id)?.pnl ?? 0,
  }));
  const openRows = await db.execute(dsql`
    SELECT COUNT(*)::int AS n FROM positions WHERE mode = ${config.executorMode} AND status = 'open'
  `);
  const openCount = Number((openRows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  await notifyDailyReport({ day, rows: reportRows, openPositionsCount: openCount });
  console.log(`Daily report for ${day} sent (mode=${config.executorMode}).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
