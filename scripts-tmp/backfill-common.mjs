import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export const DEFAULT_TARGET_DAYS = 60;
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
export const POSTGRES_MAX_BIGINT = 9223372036854775807n;

export const DEFAULT_PROGRAMS = [
  { name: 'pumpfun', address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', dex: 'pumpfun' },
  { name: 'raydium_amm_v4', address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', dex: 'raydium' },
  { name: 'raydium_clmm', address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', dex: 'raydium' },
  { name: 'meteora_dlmm', address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', dex: 'meteora' },
  { name: 'orca_whirlpool', address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', dex: 'orca' },
];

const PUBLIC_ENDPOINTS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
  'https://rpc.ankr.com/solana',
  'https://solana.drpc.org',
];

export function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    console.error('[fatal] DATABASE_URL is required; keep it in .env or process env, not in code.');
    process.exit(1);
  }
}

requireDatabaseUrl();

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(level, msg, meta = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
}

export function targetDays() {
  const n = Number(process.env.BACKFILL_TARGET_DAYS || DEFAULT_TARGET_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TARGET_DAYS;
}

export function cutoffUnix(days = targetDays()) {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

export function cutoffDate(days = targetDays()) {
  return new Date(cutoffUnix(days) * 1000);
}

export async function ensureBackfillSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backfill_runs (
      id bigserial PRIMARY KEY,
      name text,
      target_days int,
      started_at timestamptz DEFAULT now(),
      finished_at timestamptz,
      status text,
      meta jsonb
    );

    CREATE TABLE IF NOT EXISTS backfill_signatures (
      signature text PRIMARY KEY,
      program text,
      slot bigint,
      block_time timestamptz,
      status text DEFAULT 'queued',
      attempts int DEFAULT 0,
      last_error text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS backfill_signatures_status_block_time_idx
      ON backfill_signatures (status, block_time);

    CREATE INDEX IF NOT EXISTS backfill_signatures_program_block_time_idx
      ON backfill_signatures (program, block_time);
  `);
}

export async function startRun(name, days) {
  const { rows } = await pool.query(
    `INSERT INTO backfill_runs (name, target_days, status, meta)
     VALUES ($1, $2, 'running', '{}'::jsonb)
     RETURNING id`,
    [name, days],
  );
  return rows[0].id;
}

export async function finishRun(id, status, meta = {}) {
  await pool.query(
    `UPDATE backfill_runs
     SET status=$2, finished_at=now(), meta=$3::jsonb
     WHERE id=$1`,
    [id, status, JSON.stringify(meta)],
  );
}

export function rpcEndpoints() {
  const explicit = (process.env.BACKFILL_RPC_ENDPOINTS || '')
    .split(',')
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];

  const configured = [process.env.PUBLIC_RPC_URL, process.env.RPC_URL, ...PUBLIC_ENDPOINTS]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return [...new Set(configured)];
}

export class RotatingRpc {
  constructor({ endpoints = rpcEndpoints(), minIntervalMs, retries } = {}) {
    if (!endpoints.length) throw new Error('no RPC endpoints configured');
    this.endpoints = endpoints;
    this.index = 0;
    this.lastRequestAt = 0;
    this.minIntervalMs = Number(minIntervalMs || process.env.BACKFILL_RPC_INTERVAL_MS || 750);
    this.retries = Number(retries || process.env.BACKFILL_RPC_RETRIES || Math.max(6, endpoints.length * 2));
    // 429-метрика: считаем 429 в скользящем окне.
    this.windowMs = Number(process.env.BACKFILL_RPC_429_WINDOW_MS || 5 * 60_000);
    this.threshold = Number(process.env.BACKFILL_RPC_429_THRESHOLD || 25);
    this.cooldownMs = Number(process.env.BACKFILL_RPC_429_COOLDOWN_MS || 30 * 60_000);
    this.events429 = [];
    this.last429Alert = 0;
  }

  async _maybeAlert429() {
    const now = Date.now();
    this.events429 = this.events429.filter((t) => now - t <= this.windowMs);
    if (this.events429.length < this.threshold) return;
    if (now - this.last429Alert < this.cooldownMs) return;
    this.last429Alert = now;
    const msg = `Public Solana RPC: ${this.events429.length} HTTP-429 за ${(this.windowMs / 60_000).toFixed(0)} мин. ` +
      `Сборщики тормозят (RotatingRpc). Перепроверь BACKFILL_RPC_INTERVAL_MS / endpoints.`;
    try {
      const { sendTagged } = await import('../scripts/lib/telegram.mjs');
      await sendTagged('ALERT', 'rpc-429', msg);
    } catch {
      /* ignore */
    }
  }

  current() {
    return this.endpoints[this.index % this.endpoints.length];
  }

  rotate() {
    this.index = (this.index + 1) % this.endpoints.length;
  }

  async throttle() {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request(method, params = []) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      await this.throttle();
      const endpoint = this.current();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${attempt}`, method, params }),
        });
        if (response.status === 429 || response.status >= 500) {
          if (response.status === 429) {
            this.events429.push(Date.now());
            await this._maybeAlert429();
          }
          throw new Error(`HTTP ${response.status}`);
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const body = await response.json();
        if (!body.error) return body.result;
        const message = body.error?.message || JSON.stringify(body.error);
        const retryable = /rate|limit|too many|timeout|unavailable|try again/i.test(message);
        if (!retryable) throw new NonRetryableRpcError(`${method}: ${message}`);
        throw new Error(`${method}: ${message}`);
      } catch (err) {
        if (err instanceof NonRetryableRpcError) throw err;
        lastError = err;
        log('warn', 'rpc request failed; rotating endpoint', {
          method,
          endpoint,
          attempt,
          error: String(err?.message || err).slice(0, 300),
        });
        this.rotate();
        await sleep(Math.min(30_000, 500 * attempt));
      }
    }
    throw lastError || new Error(`${method}: retry budget exhausted`);
  }
}

class NonRetryableRpcError extends Error {}

export function shortError(err) {
  return String(err?.stack || err?.message || err).slice(0, 1000);
}
