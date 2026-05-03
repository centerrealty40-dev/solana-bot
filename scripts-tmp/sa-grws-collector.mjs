/**
 * SA-GRWS — GeckoTerminal `new_pools` → Raydium filter → QuickNode RPC → `wallets`.
 * Normative spec: docs/Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md
 *
 * Default: single tick and exit (safe pilot). Use `--daemon` for interval mode.
 *
 * Usage:
 *   DATABASE_URL=... SA_GRWS_RPC_URL=... node scripts-tmp/sa-grws-collector.mjs
 *   node scripts-tmp/sa-grws-collector.mjs --daemon
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

/** @type {ReadonlySet<string>} Raydium + infra program IDs — never store as user wallets (PI-7). */
const SA_GRWS_BUILTIN_IGNORE_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CP swap (common mainnet deployment)
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
  '11111111111111111111111111111111', // System Program
]);

function envNum(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envStr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const DATABASE_URL = process.env.DATABASE_URL || process.env.SA_PG_DSN;
const RPC_URL =
  process.env.SA_GRWS_RPC_URL ||
  process.env.SA_RPC_HTTP_URL ||
  process.env.SOLANA_RPC_HTTP_URL ||
  process.env.SA_RPC_URL;

const MODE = envStr('SA_GRWS_MODE', 'v1b').toLowerCase() === 'v1a' ? 'v1a' : 'v1b';
const COLLECTOR_ID = envStr('SA_GRWS_COLLECTOR_ID', 'sa-grws');
const COLLECTOR_SEMVER = envStr('SA_GRWS_COLLECTOR_SEMVER', '0.1.0');
const GECKO_PAGES_MAX = Math.max(1, envNum('SA_GRWS_GECKO_PAGES_MAX', 2));
const SIG_PAGES_MAX = Math.max(1, envNum('SA_GRWS_SIG_PAGES_MAX', 5));
const MAX_POOLS_PER_RUN = Math.max(1, envNum('SA_GRWS_MAX_POOLS_PER_RUN', 10));
const MAX_TX_PER_POOL = Math.max(0, envNum('SA_GRWS_MAX_TX_FETCHES_PER_POOL', 30));
const RPC_SLEEP_MS = Math.max(0, envNum('SA_GRWS_RPC_SLEEP_MS', 250));
const DRY_RUN = process.env.SA_GRWS_DRY_RUN === '1';
const MAX_RETRIES = Math.max(0, envNum('SA_GRWS_HTTP_MAX_RETRIES', 4));
const HTTP_TIMEOUT_MS = Math.max(1000, envNum('SA_GRWS_HTTP_TIMEOUT_MS', 15_000));
const SIG_LIMIT = Math.min(1000, Math.max(10, envNum('SA_GRWS_SIG_PAGE_LIMIT', 100)));
const DAEMON = process.argv.includes('--daemon');
const INTERVAL_MS = Math.max(60_000, envNum('SA_GRWS_INTERVAL_MS', 600_000));

const EXTRA_IGNORE = new Set(
  (process.env.SA_GRWS_IGNORE_PROGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function ignoreProgramIds() {
  return new Set([...SA_GRWS_BUILTIN_IGNORE_PROGRAMS, ...EXTRA_IGNORE]);
}

if (!DATABASE_URL) {
  console.error('[fatal] DATABASE_URL or SA_PG_DSN is required');
  process.exit(1);
}
if (!RPC_URL) {
  console.error('[fatal] SA_GRWS_RPC_URL (or SA_RPC_HTTP_URL / SOLANA_RPC_HTTP_URL / SA_RPC_URL) is required');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

let isTickRunning = false;
let isShuttingDown = false;
let ticksTotal = 0;

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'sa-grws-collector',
    msg: message,
    ...meta,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeBatchId() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  const hex = crypto.randomBytes(4).toString('hex');
  return `${y}${mo}${d}T${h}${mi}${s}Z_${hex}`;
}

function looksLikeSolanaPubkey(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function looksLikeRaydiumGeckoPool(poolData) {
  const attrs = poolData?.attributes ?? {};
  const dexId = String(poolData?.relationships?.dex?.data?.id ?? '').toLowerCase();
  const blob = [
    attrs.dex_name,
    attrs.name,
    attrs.address,
    poolData?.id,
    attrs.pool_name,
    dexId,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return blob.includes('raydium');
}

function parseGeckoRaydiumPool(poolData) {
  const attrs = poolData?.attributes ?? {};
  const rel = poolData?.relationships ?? {};
  if (!looksLikeRaydiumGeckoPool(poolData)) return null;
  const pairAddress = attrs?.address ?? attrs?.pool_address ?? null;
  const baseMint = rel?.base_token?.data?.id?.split('_').pop() ?? null;
  const quoteMint = rel?.quote_token?.data?.id?.split('_').pop() ?? null;
  if (!pairAddress || !baseMint || !quoteMint) return null;
  return { pool_address: pairAddress, base_mint: baseMint, quote_mint: quoteMint };
}

async function fetchJsonWithRetry(url, retryTag = 'http') {
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) return await res.json();
      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error(`${retryTag} status=${res.status}`);
      }
      await sleep(Math.min(10_000, 500 * 2 ** attempt));
      attempt += 1;
    } catch (e) {
      clearTimeout(timeout);
      if (attempt === MAX_RETRIES) throw e;
      await sleep(Math.min(10_000, 500 * 2 ** attempt));
      attempt += 1;
    }
  }
  throw new Error(`${retryTag} exhausted retries`);
}

async function fetchGeckoNewPoolsRaydium() {
  const out = [];
  for (let page = 1; page <= GECKO_PAGES_MAX; page += 1) {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`;
    const json = await fetchJsonWithRetry(url, 'gecko-new_pools');
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const p = parseGeckoRaydiumPool(row);
      if (p) out.push(p);
    }
    await sleep(250);
  }
  const dedup = new Map();
  for (const p of out) {
    if (!dedup.has(p.pool_address)) dedup.set(p.pool_address, p);
  }
  return [...dedup.values()].slice(0, MAX_POOLS_PER_RUN);
}

async function rpcCall(method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (j.error) throw new Error(j.error.message || String(j.error));
    return j.result;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {unknown} txJson - getTransaction result
 * @returns {string[]}
 */
function extractSignerPubkeys(txJson) {
  const set = new Set();
  const tx = txJson?.transaction;
  if (!tx) return [];

  const msg = tx.message;
  const keys = msg?.accountKeys;
  if (Array.isArray(keys)) {
    for (const k of keys) {
      if (typeof k === 'string') {
        /* legacy non-parsed */
      } else if (k && typeof k.pubkey === 'string' && k.signer === true) {
        set.add(k.pubkey);
      }
    }
  }

  const meta = txJson?.meta;
  if (meta && typeof meta.feePayer === 'string') {
    set.add(meta.feePayer);
  }

  if (set.size === 0 && Array.isArray(keys) && keys.length > 0 && typeof keys[0] === 'string') {
    set.add(keys[0]);
  }

  return [...set];
}

async function collectSignaturesForPool(poolAddress) {
  const signatures = [];
  let before = undefined;
  let pageCount = 0;
  for (let page = 0; page < SIG_PAGES_MAX; page += 1) {
    const opts = { limit: SIG_LIMIT };
    if (before) opts.before = before;
    const params = [poolAddress, opts];
    const chunk = await rpcCall('getSignaturesForAddress', params);
    pageCount += 1;
    await sleep(RPC_SLEEP_MS);
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    for (const row of chunk) {
      if (row?.signature && !row.err) signatures.push(row.signature);
    }
    before = chunk[chunk.length - 1]?.signature;
    if (chunk.length < SIG_LIMIT) break;
  }
  return { signatures, pageCount };
}

async function collectWalletsFromPool(poolRow, batchId, ignorePrograms) {
  const { pool_address, base_mint, quote_mint } = poolRow;
  const seedTs = new Date().toISOString();
  const metaBase = {
    gecko_raydium_seed: true,
    seed_pool: pool_address,
    seed_base_mint: base_mint,
    seed_quote_mint: quote_mint,
    seed_ts: seedTs,
    collector_id: COLLECTOR_ID,
    collector_semver: COLLECTOR_SEMVER,
    batch_id: batchId,
    sa_grws_mode: MODE,
  };

  const { signatures: sigs, pageCount: sigPages } = await collectSignaturesForPool(pool_address);
  /** @type {{ address: string, metadata: object }[]} */
  const walletRows = [];

  if (MODE === 'v1a') {
    log('info', 'v1a mode: signatures only', {
      pool: pool_address.slice(0, 8),
      signatures: sigs.length,
    });
    return { walletRows, signaturesPages: sigPages, txFetched: 0 };
  }

  let txFetched = 0;
  const lim = Math.min(sigs.length, MAX_TX_PER_POOL);
  for (let i = 0; i < lim; i += 1) {
    const sig = sigs[i];
    try {
      const txJson = await rpcCall('getTransaction', [
        sig,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]);
      txFetched += 1;
      await sleep(RPC_SLEEP_MS);
      if (!txJson) continue;
      const pubs = extractSignerPubkeys(txJson);
      for (const pk of pubs) {
        if (!looksLikeSolanaPubkey(pk)) continue;
        if (ignorePrograms.has(pk)) continue;
        walletRows.push({ address: pk, metadata: { ...metaBase } });
      }
    } catch (e) {
      log('warn', 'getTransaction failed', { sig: sig?.slice(0, 16), err: String(e) });
    }
  }

  const dedup = new Map();
  for (const w of walletRows) {
    if (!dedup.has(w.address)) dedup.set(w.address, w);
  }
  return {
    walletRows: [...dedup.values()],
    signaturesPages: sigs.length > 0 ? SIG_PAGES_MAX : 0,
    txFetched,
  };
}

async function insertWalletBatch(client, rows) {
  if (rows.length === 0) return 0;
  const placeholders = rows
    .map((_, i) => `($${i * 2 + 1}, now(), $${i * 2 + 2}::jsonb)`)
    .join(', ');
  const flat = rows.flatMap((r) => [r.address, JSON.stringify(r.metadata)]);
  const res = await client.query(
    `INSERT INTO wallets (address, first_seen_at, metadata) VALUES ${placeholders}
     ON CONFLICT (address) DO NOTHING`,
    flat,
  );
  return res.rowCount ?? 0;
}

/** @param {string} batchId PI-5: один batch_id на жизнь процесса (не на каждый тик daemon). */
async function collectOneTick(batchId) {
  const tickStartedAt = Date.now();
  const ignorePrograms = ignoreProgramIds();

  let poolsRaydium = 0;
  let walletsInserted = 0;
  let signaturesPagesApprox = 0;
  let txFetchedTotal = 0;
  let errorsTotal = 0;

  try {
    const pools = await fetchGeckoNewPoolsRaydium();
    poolsRaydium = pools.length;

    /** @type {{ address: string, metadata: object }[]} */
    const allWalletRows = [];

    for (const p of pools) {
      try {
        const { walletRows, signaturesPages, txFetched } = await collectWalletsFromPool(
          p,
          batchId,
          ignorePrograms,
        );
        signaturesPagesApprox += signaturesPages;
        txFetchedTotal += txFetched;
        allWalletRows.push(...walletRows);
      } catch (e) {
        errorsTotal += 1;
        log('warn', 'pool processing failed', {
          pool: p.pool_address?.slice(0, 8),
          err: String(e),
        });
      }
    }

    const globalDedup = new Map();
    for (const w of allWalletRows) {
      if (!globalDedup.has(w.address)) globalDedup.set(w.address, w);
    }
    const uniqueRows = [...globalDedup.values()];

    if (!DRY_RUN && uniqueRows.length > 0) {
      const client = await pool.connect();
      try {
        const chunkSize = 500;
        for (let i = 0; i < uniqueRows.length; i += chunkSize) {
          const chunk = uniqueRows.slice(i, i + chunkSize);
          const n = await insertWalletBatch(client, chunk);
          walletsInserted += n;
        }
      } finally {
        client.release();
      }
    }

    ticksTotal += 1;
    log('info', 'tick completed', {
      batchId,
      mode: MODE,
      dryRun: DRY_RUN,
      poolsRaydium,
      signaturesPages: signaturesPagesApprox,
      walletsUnique: uniqueRows.length,
      walletsInserted,
      txFetchedTotal,
      errorsTotal,
      elapsedMs: Date.now() - tickStartedAt,
      ticksTotal,
    });
  } catch (e) {
    errorsTotal += 1;
    log('error', 'tick failed', { err: String(e), elapsedMs: Date.now() - tickStartedAt });
  }
}

async function runTickGuarded(batchId) {
  if (isTickRunning) {
    log('warn', 'skipping tick, previous run still active');
    return;
  }
  isTickRunning = true;
  try {
    await collectOneTick(batchId);
  } finally {
    isTickRunning = false;
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log('info', 'shutdown requested', { signal });
  try {
    await pool.end();
  } catch (e) {
    log('warn', 'pool shutdown warning', { err: String(e) });
  } finally {
    process.exit(0);
  }
}

async function main() {
  const batchId = makeBatchId();
  log('info', 'collector start', {
    mode: MODE,
    dryRun: DRY_RUN,
    daemon: DAEMON,
    rpcHost: RPC_URL.replace(/\?.*/, '').slice(0, 48),
    batchId,
    collectorId: COLLECTOR_ID,
    collectorSemver: COLLECTOR_SEMVER,
    geckoPagesMax: GECKO_PAGES_MAX,
    maxPoolsPerRun: MAX_POOLS_PER_RUN,
    sigPagesMax: SIG_PAGES_MAX,
    maxTxPerPool: MAX_TX_PER_POOL,
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await runTickGuarded(batchId);

  if (!DAEMON) {
    await shutdown('once');
    return;
  }

  setInterval(() => void runTickGuarded(batchId), INTERVAL_MS);
}

main().catch((e) => {
  log('error', 'fatal', { err: String(e) });
  process.exit(1);
});
