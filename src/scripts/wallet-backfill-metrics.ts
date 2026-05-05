/**
 * W6.12 S06 — операторская сводка без RPC: очередь backfill, свежесть swaps, превью enqueue gate, оценка потолка кредитов за прогон.
 *
 *   npm run wallet-backfill:metrics
 *   SA_BACKFILL_METRICS_ENQUEUE_PREVIEW=500 npm run wallet-backfill:metrics
 *
 * Не вызывает QuickNode — безопасно для частых проверок.
 */
import 'dotenv/config';
import pg from 'pg';
import {
  computeEnqueueBatchSize,
  parseOptionalPositiveIntEnv,
} from '../intel/wallet-backfill-enqueue-gate.js';

const { Pool } = pg;

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function help(): void {
  console.log(`wallet-backfill:metrics — DB-only (zero RPC)

Env:
  SA_BACKFILL_METRICS_ENQUEUE_PREVIEW   запрошенный размер enqueue для превью gate (default 500)
  SA_BACKFILL_ENQUEUE_GATE_PENDING_MAX  как в cron / .env
  SA_BACKFILL_ENQUEUE_SOFT_CAP

Оценка кредитов — из текущих env (задайте те же, что в cron pilot, перед запуском):
  SA_BACKFILL_MAX_WALLETS_PER_RUN, SA_BACKFILL_SIG_PAGES_MAX, SA_BACKFILL_MAX_TX_PER_WALLET
  QUICKNODE_CREDITS_PER_SOLANA_RPC (default 30)
`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    help();
    process.exit(0);
  }

  const databaseUrl = process.env.DATABASE_URL || process.env.SA_PG_DSN;
  if (!databaseUrl) {
    console.error('[fatal] DATABASE_URL or SA_PG_DSN required');
    process.exit(1);
  }

  const previewRequested = Math.max(1, envNum('SA_BACKFILL_METRICS_ENQUEUE_PREVIEW', 500));
  const gatePendingMax = parseOptionalPositiveIntEnv(process.env.SA_BACKFILL_ENQUEUE_GATE_PENDING_MAX);
  const softCap = parseOptionalPositiveIntEnv(process.env.SA_BACKFILL_ENQUEUE_SOFT_CAP);

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const pendingRes = await pool.query(`SELECT count(*)::int AS c FROM wallet_backfill_queue WHERE status = 'pending'`);
    const pendingCount = (pendingRes.rows[0] as { c?: number }).c ?? 0;

    const statusRes = await pool.query(
      `SELECT status, count(*)::int AS n FROM wallet_backfill_queue GROUP BY status ORDER BY status`,
    );

    const swapsRes = await pool.query(`
      SELECT coalesce(source, '(null)') AS source,
             count(*) FILTER (WHERE block_time > now() - interval '24 hours')::bigint AS rows_24h,
             count(*) FILTER (WHERE block_time > now() - interval '7 days')::bigint AS rows_7d,
             max(block_time) AS newest_swap_chain_time
      FROM swaps
      GROUP BY source
      ORDER BY rows_7d DESC
    `);

    const gatePreview = computeEnqueueBatchSize({
      pendingCount,
      requested: previewRequested,
      gatePendingMax,
      softCap,
    });

    const cp = envNum('QUICKNODE_CREDITS_PER_SOLANA_RPC', 30);
    const w = envNum('SA_BACKFILL_MAX_WALLETS_PER_RUN', 500);
    const sig = envNum('SA_BACKFILL_SIG_PAGES_MAX', 3);
    const tx = envNum('SA_BACKFILL_MAX_TX_PER_WALLET', 40);
    const ceilingOneRun = w * (sig + tx) * cp;

    const swapsGrowing =
      swapsRes.rows.some((r: { rows_24h?: string | bigint }) => Number(r.rows_24h ?? 0) > 0) ||
      swapsRes.rows.some((r: { rows_7d?: string | bigint }) => Number(r.rows_7d ?? 0) > 0);

    console.log(
      JSON.stringify(
        {
          ok: true,
          component: 'wallet-backfill-metrics',
          rpc_calls: 0,
          queue: {
            pending_count: pendingCount,
            by_status: Object.fromEntries(statusRes.rows.map((r: { status: string; n: number }) => [r.status, r.n])),
          },
          swaps_by_source: swapsRes.rows,
          swaps_recent_activity: swapsGrowing,
          enqueue_gate_preview: {
            requested: previewRequested,
            pending_count: pendingCount,
            gate_pending_max: gatePendingMax,
            soft_cap: softCap,
            effective_n: gatePreview.effectiveN,
            skipped: gatePreview.skipped,
            reason: gatePreview.reason,
          },
          credits_upper_bound_one_backfill_run: {
            formula: 'MAX_WALLETS * (SIG_PAGES_MAX + MAX_TX_PER_WALLET) * CREDITS_PER_RPC',
            values: { wallets: w, sig_pages: sig, max_tx: tx, credits_per_rpc: cp },
            ceiling: ceilingOneRun,
            note: 'Верхняя граница; фактические RPC часто ниже (ранний выход по очереди sig). Задайте env как в cron перед сравнением.',
          },
          interpretation: {
            base_swaps_growing: swapsGrowing
              ? 'За 24h/7d есть строки swaps — конвейер не мёртвый.'
              : 'Нет строк swaps за 24h/7d — проверить источники (sa-parser/stream, backfill pilot, sigseed) и очередь.',
            gate: gatePreview.skipped
              ? 'Enqueue при текущих порогах был бы пропущен или обнулён — см. gate_reason.'
              : `До ${gatePreview.effectiveN} адресов можно добавить за один enqueue при запросе ${previewRequested}.`,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
