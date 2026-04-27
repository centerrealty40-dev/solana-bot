/**
 * RPC Collector — гибрид free+QuickNode (Шаг 2).
 *
 * Берёт задачи из `rpc_tasks`, выполняет JSON-RPC.
 *  1) ОСНОВНОЙ путь — публичная нода (`PUBLIC_RPC_URL` или `mainnet-beta`).
 *  2) При HTTP 429 / 5xx / network error — fallback на QuickNode
 *     (`SOLANA_RPC_HTTP_URL` / `QUICKNODE_HTTP_URL`). Каждый успешный QN-вызов
 *     учитывается через `solana-rpc-meter` (lock-safe, Telegram 5/10/15…%).
 *  3) Жёсткий ежедневный cap по QN: `RPC_COLLECTOR_QN_DAILY_CREDIT_CAP`
 *     (default 500_000 ≈ 0.6% от 80M / мес).
 */
import 'dotenv/config';
import pg from 'pg';
import { creditsPerStandardSolanaRpc, recordSolanaRpcCredits } from '../src/core/rpc/solana-rpc-meter.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('[fatal] DATABASE_URL is required');
  process.exit(1);
}

const PUBLIC_URL = process.env.PUBLIC_RPC_URL || 'https://api.mainnet-beta.solana.com';
const QN_URL = (process.env.SOLANA_RPC_HTTP_URL || process.env.QUICKNODE_HTTP_URL || '').trim();
const POLL_MS = Number(process.env.RPC_COLLECTOR_POLL_MS || 1200);
const MAX_RPS = Number(process.env.RPC_COLLECTOR_MAX_RPS || 3);
const DAILY_CAP_QN = Number(process.env.RPC_COLLECTOR_QN_DAILY_CREDIT_CAP || 500_000);
const PER_CALL_CREDITS = creditsPerStandardSolanaRpc();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let tokens = MAX_RPS;
setInterval(() => {
  tokens = Math.min(MAX_RPS, tokens + 1);
}, 1000);

let qnUsedThisRun = 0;

async function rpcOn(url: string, method: string, params: unknown[]): Promise<unknown> {
  while (tokens <= 0) await new Promise((r) => setTimeout(r, 100));
  tokens--;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.status === 429 || r.status >= 500) throw new Error(`HTTP_${r.status}`);
  if (!r.ok) throw new Error(`HTTP_${r.status}`);
  const j = (await r.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message ?? 'rpc error'}`);
  return j.result;
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  try {
    return await rpcOn(PUBLIC_URL, method, params);
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const transient = /HTTP_429|HTTP_5\d\d|fetch failed|ENETUNREACH|ECONNRESET|ETIMEDOUT|aborted|timeout/i.test(msg);
    if (!transient) throw e;
    if (!QN_URL) throw e;
    if (qnUsedThisRun >= DAILY_CAP_QN) {
      throw new Error(`qn_daily_cap_reached:${qnUsedThisRun}`);
    }
    const out = await rpcOn(QN_URL, method, params);
    qnUsedThisRun += PER_CALL_CREDITS;
    await recordSolanaRpcCredits(PER_CALL_CREDITS);
    return out;
  }
}

interface TaskRow {
  id: number;
  mint: string;
  feature_type: string;
}

async function takeTask(): Promise<TaskRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(`
      WITH t AS (
        SELECT id FROM rpc_tasks
        WHERE status='queued' AND not_before <= NOW()
        ORDER BY priority ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE rpc_tasks rt
      SET status='processing', started_at=NOW(), attempts=attempts+1
      FROM t
      WHERE rt.id=t.id
      RETURNING rt.*`);
    await client.query('COMMIT');
    return (res.rows[0] as TaskRow | undefined) ?? null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function processTask(t: TaskRow): Promise<void> {
  let data: unknown;
  if (t.feature_type === 'largest_accounts') {
    data = await rpc('getTokenLargestAccounts', [t.mint]);
  } else if (t.feature_type === 'authorities') {
    data = await rpc('getAccountInfo', [t.mint, { encoding: 'jsonParsed' }]);
  } else if (t.feature_type === 'tx_burst') {
    data = await rpc('getSignaturesForAddress', [t.mint, { limit: 50 }]);
  } else if (t.feature_type === 'holders') {
    data = await rpc('getTokenSupply', [t.mint]);
  } else {
    throw new Error(`unknown feature_type: ${t.feature_type}`);
  }

  await pool.query(
    'INSERT INTO rpc_features (mint, feature_type, data) VALUES ($1, $2, $3)',
    [t.mint, t.feature_type, data],
  );
  await pool.query("UPDATE rpc_tasks SET status='done', finished_at=NOW() WHERE id=$1", [t.id]);
}

async function failTask(t: TaskRow, err: unknown): Promise<void> {
  const msg = String((err as Error)?.message || err).slice(0, 500);
  await pool.query(
    `UPDATE rpc_tasks
     SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'queued' END,
         not_before = CASE WHEN attempts >= 5 THEN not_before ELSE NOW() + INTERVAL '2 minutes' END,
         last_error = $2
     WHERE id=$1`,
    [t.id, msg],
  );
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      const t = await takeTask();
      if (!t) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      try {
        await processTask(t);
      } catch (e) {
        await failTask(t, e);
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

console.log(
  JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    component: 'rpc-collector',
    msg: 'start',
    publicUrl: PUBLIC_URL.replace(/(\?api-key=|\/v2\/|\.quiknode\.pro\/)[A-Za-z0-9_-]+/g, '$1<redacted>'),
    qnFallback: QN_URL ? 'enabled' : 'disabled',
    maxRps: MAX_RPS,
    dailyCapQn: DAILY_CAP_QN,
    perCallCredits: PER_CALL_CREDITS,
  }),
);

void loop();
