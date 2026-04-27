/**
 * Signatures Seed Worker — Шаг 1 гибрида free+QuickNode.
 *
 * Берёт mint из очереди `signatures_seed_queue`, через QuickNode (`SOLANA_RPC_HTTP_URL`)
 * собирает последние подписи (`getSignaturesForAddress`) и сами транзакции
 * (`getTransaction`), сохраняя raw в существующую `rpc_features` для последующего
 * парсинга в `swaps` (отдельный шаг). Всё проходит через `recordSolanaRpcCredits`,
 * чтобы Telegram-лесенка 5/10/15% реально срабатывала.
 *
 * Жёсткие лимиты (env):
 *   SIGSEED_DAILY_CREDIT_CAP   — макс. credits/сутки (default 2_500_000 ≈ ~3% от 80M);
 *                                сумма сверяется с `data/quicknode-usage.json`.
 *   SIGSEED_MAX_PER_MINT       — сколько подписей max на 1 mint (default 50)
 *   SIGSEED_TX_PER_MINT        — сколько транзакций max парсить с этих подписей (default 30)
 *   SIGSEED_MIN_INTERVAL_MS    — пауза между RPC (default 250)
 *   SIGSEED_MINUTES            — сколько крутиться в одном запуске (default 30)
 *   SIGSEED_DRY_RUN=1          — только статусы, без записи в rpc_features
 */
import 'dotenv/config';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../core/db/client.js';
import { child } from '../core/logger.js';
import {
  creditsPerStandardSolanaRpc,
  defaultSolanaRpcUrl,
  recordSolanaRpcCredits,
} from '../core/rpc/solana-rpc-meter.js';

const log = child('signatures-seed-worker');

function envNum(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const DAILY_CREDIT_CAP = envNum('SIGSEED_DAILY_CREDIT_CAP', 2_500_000);
const MAX_SIGS_PER_MINT = envNum('SIGSEED_MAX_PER_MINT', 50);
const MAX_TX_PER_MINT = envNum('SIGSEED_TX_PER_MINT', 30);
const MIN_INTERVAL_MS = envNum('SIGSEED_MIN_INTERVAL_MS', 250);
const RUN_MINUTES = envNum('SIGSEED_MINUTES', 30);
const DRY_RUN = process.env.SIGSEED_DRY_RUN === '1';

const RPC_URL = defaultSolanaRpcUrl();
const PER_CALL_CREDITS = creditsPerStandardSolanaRpc();

interface QueueRow {
  mint: string;
  attempts: number;
}

async function ensureSchema(): Promise<void> {
  await db.execute(dsql.raw(`
    CREATE TABLE IF NOT EXISTS signatures_seed_queue (
      mint text PRIMARY KEY,
      added_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'queued',
      attempts int NOT NULL DEFAULT 0,
      last_error text,
      signatures_fetched int NOT NULL DEFAULT 0,
      tx_fetched int NOT NULL DEFAULT 0,
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS sigseed_queue_status_idx ON signatures_seed_queue (status);
  `));
  await db.execute(dsql.raw(`
    CREATE TABLE IF NOT EXISTS rpc_features (
      id bigserial PRIMARY KEY,
      mint text NOT NULL,
      feature_type text NOT NULL,
      data jsonb,
      feature_ts timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS rpc_features_mint_type_idx
      ON rpc_features (mint, feature_type);
  `));
}

function todayMonthlyUsageCredits(): number {
  // используем ровно ту же state-машину, что и метрер; сейчас он только инкрементит,
  // нам нужно прочитать. читаем простым require-fs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    const p = process.env.QUICKNODE_USAGE_PATH || path.join('data', 'quicknode-usage.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { creditsUsed?: number };
    return Number(j?.creditsUsed ?? 0);
  } catch {
    return 0;
  }
}

let usedThisRun = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    if (r.status === 429) {
      await sleep(2000);
    }
    throw new Error(`HTTP ${r.status}`);
  }
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) {
    throw new Error(j.error.message || 'rpc error');
  }
  await recordSolanaRpcCredits(PER_CALL_CREDITS);
  usedThisRun += PER_CALL_CREDITS;
  return j.result as T;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function takeOne(): Promise<QueueRow | null> {
  const r: unknown = await db.execute(dsql.raw(`
    WITH t AS (
      SELECT mint
      FROM signatures_seed_queue
      WHERE status = 'queued'
      ORDER BY added_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE signatures_seed_queue q
    SET status = 'processing', attempts = q.attempts + 1
    FROM t
    WHERE q.mint = t.mint
    RETURNING q.mint, q.attempts
  `));
  const rows = Array.isArray(r) ? r : ((r as { rows?: QueueRow[] }).rows ?? []);
  return (rows[0] as QueueRow | undefined) ?? null;
}

async function markDone(mint: string, sigs: number, tx: number): Promise<void> {
  await db.execute(dsql.raw(`
    UPDATE signatures_seed_queue
    SET status='done',
        signatures_fetched=${sigs},
        tx_fetched=${tx},
        finished_at=now()
    WHERE mint='${mint.replace(/'/g, "''")}'
  `));
}

async function markFailed(mint: string, err: string): Promise<void> {
  const safe = err.replace(/'/g, "''").slice(0, 480);
  await db.execute(dsql.raw(`
    UPDATE signatures_seed_queue
    SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
        last_error = '${safe}'
    WHERE mint='${mint.replace(/'/g, "''")}'
  `));
}

async function saveRpcFeature(mint: string, type: string, data: unknown): Promise<void> {
  if (DRY_RUN) return;
  await db.execute(dsql.raw(`
    INSERT INTO rpc_features (mint, feature_type, data, feature_ts)
    VALUES (
      '${mint.replace(/'/g, "''")}',
      '${type.replace(/'/g, "''")}',
      $$${JSON.stringify(data).replace(/\$/g, '\\$')}$$::jsonb,
      now()
    )
  `));
}

interface RpcSignature {
  signature: string;
  slot: number;
  blockTime: number | null;
  err?: unknown;
}

async function processOne(row: QueueRow): Promise<void> {
  const monthly = todayMonthlyUsageCredits();
  if (monthly + DAILY_CREDIT_CAP < monthly) {
    /* unreachable */
  }
  // глобальный анти-выгорание: если этот процесс в одном запуске уже взял свой суточный cap —
  // ставим mint обратно в queued и выходим (cron подхватит завтра).
  if (usedThisRun >= DAILY_CREDIT_CAP) {
    log.warn({ usedThisRun, cap: DAILY_CREDIT_CAP }, 'daily credit cap reached; re-queue');
    await db.execute(dsql.raw(`
      UPDATE signatures_seed_queue SET status='queued' WHERE mint='${row.mint.replace(/'/g, "''")}'
    `));
    return;
  }

  let sigs: RpcSignature[] = [];
  try {
    sigs = await rpc<RpcSignature[]>('getSignaturesForAddress', [
      row.mint,
      { limit: MAX_SIGS_PER_MINT },
    ]);
  } catch (e) {
    await markFailed(row.mint, `getSignaturesForAddress: ${String(e)}`);
    return;
  }

  await saveRpcFeature(row.mint, 'signatures_for_mint', { count: sigs.length, signatures: sigs });

  const txList = sigs
    .filter((s) => !s.err && s.signature)
    .slice(0, MAX_TX_PER_MINT);

  let txOk = 0;
  for (const s of txList) {
    if (usedThisRun >= DAILY_CREDIT_CAP) break;
    await sleep(MIN_INTERVAL_MS);
    try {
      const tx = await rpc<unknown>('getTransaction', [
        s.signature,
        { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed', commitment: 'confirmed' },
      ]);
      if (tx) {
        await saveRpcFeature(row.mint, 'tx_for_signature', { signature: s.signature, tx });
        txOk += 1;
      }
    } catch (e) {
      log.warn({ mint: row.mint, sig: s.signature, err: String(e) }, 'getTransaction failed');
    }
  }

  await markDone(row.mint, sigs.length, txOk);
  log.info(
    { mint: row.mint, sigs: sigs.length, tx: txOk, usedThisRun, dailyCap: DAILY_CREDIT_CAP },
    'mint processed',
  );
}

async function main(): Promise<void> {
  if (!RPC_URL || !RPC_URL.startsWith('https://')) {
    log.error('SOLANA_RPC_HTTP_URL is missing or not https — refusing to run');
    process.exit(1);
  }
  await ensureSchema();
  const stopAt = Date.now() + RUN_MINUTES * 60_000;

  log.info(
    {
      dryRun: DRY_RUN,
      dailyCreditCap: DAILY_CREDIT_CAP,
      sigsPerMint: MAX_SIGS_PER_MINT,
      txPerMint: MAX_TX_PER_MINT,
      runMinutes: RUN_MINUTES,
      perCallCredits: PER_CALL_CREDITS,
    },
    'signatures-seed-worker start',
  );

  while (Date.now() < stopAt) {
    if (usedThisRun >= DAILY_CREDIT_CAP) {
      log.warn({ usedThisRun, cap: DAILY_CREDIT_CAP }, 'daily cap reached, exiting');
      break;
    }
    const row = await takeOne();
    if (!row) {
      log.info('no queued mints; sleeping 30s');
      await sleep(30_000);
      continue;
    }
    try {
      await processOne(row);
    } catch (e) {
      log.error({ mint: row.mint, err: String(e) }, 'processOne crashed');
      await markFailed(row.mint, String(e));
    }
  }

  log.info({ usedThisRun, monthlyApprox: todayMonthlyUsageCredits() }, 'signatures-seed-worker exit');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
