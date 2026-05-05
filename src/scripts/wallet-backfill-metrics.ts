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
  DETECTIVE_DATA_PLANE_PILOT_PRESETS,
  pilotSlotCeilingCredits,
} from '../intel/wallet-backfill-cron-presets.js';
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

Оценка кредитов pilot — два слота из SSOT \`wallet-backfill-cron-presets.ts\` (синхронно с install-detective cron).

Опционально переопределить биллинг RPC:
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

    const pilotSlotRows = DETECTIVE_DATA_PLANE_PILOT_PRESETS.map((slot) => ({
      id: slot.id,
      cron_hint: slot.cronHint,
      max_wallets: slot.maxWallets,
      sig_pages_max: slot.sigPagesMax,
      max_tx_per_wallet: slot.maxTxPerWallet,
      ceiling_credits: pilotSlotCeilingCredits(slot, cp),
    }));
    const pilotDailyCeilingSum = pilotSlotRows.reduce((a, r) => a + r.ceiling_credits, 0);

    const swapsGrowing =
      swapsRes.rows.some((r: { rows_24h?: string | bigint }) => Number(r.rows_24h ?? 0) > 0) ||
      swapsRes.rows.some((r: { rows_7d?: string | bigint }) => Number(r.rows_7d ?? 0) > 0);

    const parserRow = swapsRes.rows.find((r: { source?: string }) => r.source === 'sa-parser') as
      | { rows_24h?: string | bigint; newest_swap_chain_time?: Date | string }
      | undefined;
    const parser24 = parserRow ? Number(parserRow.rows_24h ?? 0) : 0;
    const parserStale = Boolean(parserRow && parser24 === 0);

    const backfillRow = swapsRes.rows.find((r: { source?: string }) => r.source === 'wallet_backfill') as
      | { rows_24h?: string | bigint }
      | undefined;
    const backfill24 = backfillRow ? Number(backfillRow.rows_24h ?? 0) : 0;

    console.log(
      JSON.stringify(
        {
          ok: true,
          component: 'wallet-backfill-metrics',
          spec_ref: 'W6.12 S06',
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
          credits_upper_bound_pilot_slots: {
            credits_per_rpc: cp,
            ssot: 'src/intel/wallet-backfill-cron-presets.ts ↔ scripts/cron/install-detective-data-plane-salpha.sh',
            slots: pilotSlotRows,
            daily_sum_ceiling: pilotDailyCeilingSum,
            note: 'Сумма двух ежедневных pilot-прогонов; фактический RPC ниже при раннем выходе. Без учёта sigseed/scam-farm/orchestrator.',
          },
          interpretation: {
            base_swaps_growing: swapsGrowing
              ? 'За 24h/7d есть строки swaps — конвейер не мёртвый.'
              : 'Нет строк swaps за 24h/7d — проверить источники (sa-parser/stream, backfill pilot, sigseed) и очередь.',
            gate: gatePreview.skipped
              ? 'Enqueue при текущих порогах был бы пропущен или обнулён — см. gate_reason.'
              : `До ${gatePreview.effectiveN} адресов можно добавить за один enqueue при запросе ${previewRequested}.`,
            sa_parser_stream:
              parserStale && backfill24 > 0
                ? 'sa-parser без свежих строк за 24h — ожидаемо без стрима; свежесть тащит wallet_backfill/sigseed.'
                : parserStale && backfill24 === 0 && !swapsGrowing
                  ? 'Нет ни sa-parser 24h, ни wallet_backfill 24h — проверить очередь и cron pilot.'
                  : parserStale
                    ? 'sa-parser не обновляется за 24h; при необходимости свежего firehose — отдельный бюджетный контур.'
                    : 'sa-parser даёт строки за 24h (или нет таблицы источника в выборке).',
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
