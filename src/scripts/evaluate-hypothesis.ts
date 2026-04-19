import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('evaluate-hypothesis');

/**
 * Stage-5 readiness check: did the given hypothesis pass the plan's gate?
 *
 * Gate (paper, last 100+ trades):
 *   - expectancy_pct >= 0.5%
 *   - sharpe_per_trade >= 1.0
 *   - max consecutive losses <= 8
 *   - max equity drawdown <= 25%
 *   - distinct_tokens >= 10
 *
 * Usage:
 *   npm run hypothesis:evaluate -- h1
 */
async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    log.error('usage: evaluate-hypothesis <hypothesis_id>');
    process.exit(1);
  }
  const stats = await loadStats(id);
  if (!stats) {
    log.warn({ id }, 'no closed paper trades for this hypothesis yet');
    process.exit(2);
  }
  const checks = [
    {
      name: 'trades >= 100',
      pass: stats.trades >= 100,
      value: stats.trades,
    },
    {
      name: 'expectancy_pct >= 0.5%',
      pass: stats.expectancy_pct >= 0.005,
      value: `${(stats.expectancy_pct * 100).toFixed(2)}%`,
    },
    {
      name: 'sharpe_per_trade >= 1.0',
      pass: stats.sharpe_per_trade >= 1.0,
      value: stats.sharpe_per_trade.toFixed(2),
    },
    {
      name: 'max_consecutive_losses <= 8',
      pass: stats.max_consec_loss <= 8,
      value: stats.max_consec_loss,
    },
    {
      name: 'max_drawdown <= 25%',
      pass: stats.max_drawdown <= 0.25,
      value: `${(stats.max_drawdown * 100).toFixed(1)}%`,
    },
    {
      name: 'distinct_tokens >= 10',
      pass: stats.distinct_tokens >= 10,
      value: stats.distinct_tokens,
    },
  ];

  const allPass = checks.every((c) => c.pass);
  process.stdout.write(`Hypothesis ${id} — paper readiness report\n`);
  process.stdout.write('-----------------------------------------\n');
  for (const c of checks) {
    process.stdout.write(`  ${c.pass ? '[PASS]' : '[FAIL]'}  ${c.name.padEnd(32)}  ${c.value}\n`);
  }
  process.stdout.write('-----------------------------------------\n');
  process.stdout.write(
    allPass
      ? `RESULT: READY for live pilot. To go live, manually:\n` +
          `  1. Set EXECUTOR_MODE=live in .env\n` +
          `  2. Set WALLET_KEYPAIR_PATH and fund the hot wallet with no more than $500 USDC\n` +
          `  3. Implement the Stage-5 live executor (see src/runner/live-executor.ts header)\n` +
          `  4. Restart runner with: npm run dev:runner -- --only=${id}\n`
      : `RESULT: NOT READY for live. Continue paper trading.\n`,
  );
  process.exit(allPass ? 0 : 3);
}

interface Stats {
  trades: number;
  distinct_tokens: number;
  expectancy_pct: number;
  sharpe_per_trade: number;
  max_consec_loss: number;
  max_drawdown: number;
}

async function loadStats(hypothesisId: string): Promise<Stats | null> {
  const rows = await db.execute(dsql`
    WITH closed AS (
      SELECT
        realized_pnl_usd,
        size_usd,
        closed_at,
        base_mint,
        realized_pnl_usd / NULLIF(size_usd, 0) AS pct_return
      FROM positions
      WHERE status = 'closed' AND mode = 'paper' AND hypothesis_id = ${hypothesisId}
      ORDER BY closed_at
    ),
    eq AS (
      SELECT
        closed_at,
        SUM(realized_pnl_usd) OVER (ORDER BY closed_at) AS equity
      FROM closed
    ),
    dd AS (
      SELECT
        closed_at,
        equity,
        MAX(equity) OVER (ORDER BY closed_at) AS peak,
        (MAX(equity) OVER (ORDER BY closed_at) - equity) / NULLIF(MAX(equity) OVER (ORDER BY closed_at), 0) AS dd
      FROM eq
    ),
    runs AS (
      SELECT
        realized_pnl_usd,
        SUM(CASE WHEN realized_pnl_usd >= 0 THEN 1 ELSE 0 END)
          OVER (ORDER BY closed_at) AS reset_marker
      FROM closed
    )
    SELECT
      (SELECT COUNT(*) FROM closed) AS trades,
      (SELECT COUNT(DISTINCT base_mint) FROM closed) AS distinct_tokens,
      (SELECT AVG(pct_return) FROM closed) AS expectancy_pct,
      (SELECT
        CASE WHEN STDDEV_POP(pct_return) > 0
             THEN AVG(pct_return) / STDDEV_POP(pct_return)
             ELSE 0 END
       FROM closed) AS sharpe_per_trade,
      (SELECT COALESCE(MAX(c), 0) FROM (
        SELECT COUNT(*) AS c FROM runs WHERE realized_pnl_usd < 0 GROUP BY reset_marker
      ) sub) AS max_consec_loss,
      (SELECT COALESCE(MAX(dd), 0) FROM dd) AS max_drawdown
  `);
  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!r || Number(r.trades ?? 0) === 0) return null;
  return {
    trades: Number(r.trades),
    distinct_tokens: Number(r.distinct_tokens),
    expectancy_pct: Number(r.expectancy_pct ?? 0),
    sharpe_per_trade: Number(r.sharpe_per_trade ?? 0),
    max_consec_loss: Number(r.max_consec_loss ?? 0),
    max_drawdown: Number(r.max_drawdown ?? 0),
  };
}

main().catch((err) => {
  log.error({ err }, 'evaluate failed');
  process.exit(1);
});
