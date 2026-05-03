/**
 * SA-GRWS — GeckoTerminal `new_pools` → Raydium filter → QuickNode RPC → `wallets`.
 * Normative spec: docs/Smart Lottery V2/W6.7_gecko_raydium_wallet_seed_collector_local.md
 *
 * Default: single tick and exit (safe pilot). Use `--daemon` for interval mode.
 *
 * Usage:
 *   DATABASE_URL=... SA_GRWS_RPC_URL=... node scripts-tmp/sa-grws-collector.mjs
 *   node scripts-tmp/sa-grws-collector.mjs --daemon
 *
 * Кредиты QuickNode: запросы идут напрямую в JSON-RPC; локальный **`quicknode-usage.json`**
 * и **`recordSolanaRpcCredits`** этим файлом не вызываются. В логе тика — **`rpcBillableCalls`**
 * и **`estimatedQuicknodeCredits`** (× **`QUICKNODE_CREDITS_PER_SOLANA_RPC`**). Сводка Admin API
 * «за несколько секунд» часто **0** из‑за агрегации; сравнивайте **UTC‑сутки** или дашборд QN.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const GECKO_PAGE_SLEEP_MS = Math.max(0, envNum('SA_GRWS_GECKO_PAGE_SLEEP_MS', 650));
/** Оценка для логов (как в .env торгового контура); реальный список QN — у провайдера. */
const QN_CREDITS_PER_RPC_CALL = Math.max(1, envNum('QUICKNODE_CREDITS_PER_SOLANA_RPC', 30));
const DAEMON = process.argv.includes('--daemon');
const INTERVAL_MS = Math.max(60_000, envNum('SA_GRWS_INTERVAL_MS', 600_000));

let rpcBillableCalls = 0;

const EXTRA_IGNORE = new Set(
  (process.env.SA_GRWS_IGNORE_PROGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function ignoreProgramIds() {
  return new Set([...SA_GRWS_BUILTIN_IGNORE_PROGRAMS, ...EXTRA_IGNORE]);
}

/**
 * Опционально: фиксированные пулы для бенчмарка RPC/БД без Gecko (замер QuickNode и т.п.).
 * Задаётся **`SA_GRWS_SEED_POOLS_JSON`** или файлом **`SA_GRWS_SEED_POOLS_PATH`** (JSON-массив объектов с pool_address, base_mint, quote_mint).
 */
function loadSeedPools() {
  const path = process.env.SA_GRWS_SEED_POOLS_PATH?.trim();
  let raw = (process.env.SA_GRWS_SEED_POOLS_JSON || '').trim();
  if (path) {
    try {
      raw = fs.readFileSync(path, 'utf8').trim();
    } catch {
      return null;
    }
  }
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    /** @type {{ pool_address: string, base_mint: string, quote_mint: string }[]} */
    const out = [];
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      const pool_address = x.pool_address;
      const base_mint = x.base_mint;
      const quote_mint = x.quote_mint;
      if (
        typeof pool_address === 'string' &&
        typeof base_mint === 'string' &&
        typeof quote_mint === 'string'
      ) {
        out.push({ pool_address, base_mint, quote_mint });
      }
    }
    return out.length ? out.slice(0, MAX_POOLS_PER_RUN) : null;
  } catch {
    return null;
  }
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

/** Mint из Gecko token ref id вида `solana_<pubkey>`. */
function geckoMintFromTokenRefId(refId) {
  if (typeof refId !== 'string' || refId.length < 8) return null;
  if (refId.startsWith('solana_')) return refId.slice('solana_'.length);
  const parts = refId.split('_');
  return parts.length >= 2 ? parts[parts.length - 1] : refId;
}

/** Адрес пула: атрибуты или JSON:API id `solana_<pool>`. */
function geckoPoolPubkey(poolData) {
  const attrs = poolData?.attributes ?? {};
  const a = attrs?.address ?? attrs?.pool_address ?? null;
  if (typeof a === 'string' && looksLikeSolanaPubkey(a)) return a;
  const rawId = poolData?.id;
  if (typeof rawId === 'string' && rawId.startsWith('solana_')) {
    const p = rawId.slice('solana_'.length);
    if (looksLikeSolanaPubkey(p)) return p;
  }
  return typeof a === 'string' ? a : null;
}

/**
 * Raydium на Gecko v2: признак в **`relationships.dex.data.id`** (`raydium`, `raydium-clmm`, …).
 * В **`new_pools`** часто нет `attributes.dex_name` — только id DEX (см. raydium-collector `trending_pools`, там ещё бывает legacy dex_name).
 */
function isRaydiumDexGeckoPool(poolData) {
  const dexId = String(poolData?.relationships?.dex?.data?.id ?? '').toLowerCase();
  if (dexId === 'raydium' || dexId.startsWith('raydium-')) return true;
  const attrs = poolData?.attributes ?? {};
  const legacy = String(attrs.dex_name ?? attrs.dex ?? '').toLowerCase();
  return legacy.includes('raydium');
}

function parseGeckoRaydiumPool(poolData) {
  const rel = poolData?.relationships ?? {};
  if (!isRaydiumDexGeckoPool(poolData)) return null;
  const pairAddress = geckoPoolPubkey(poolData);
  const baseMint = geckoMintFromTokenRefId(rel?.base_token?.data?.id);
  const quoteMint = geckoMintFromTokenRefId(rel?.quote_token?.data?.id);
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

const GECKO_HTTP_HEADERS = {
  accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (compatible; sa-grws-collector/0.1; +https://github.com/centerrealty40-dev/solana-bot)',
};

/**
 * Gecko иногда отвечает HTTP 200 с телом без `data[]` (лимиты / антибот). Тогда ретраим.
 */
async function fetchGeckoPoolsPage(page) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=${page}`;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: GECKO_HTTP_HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        lastErr = new Error(`gecko status=${res.status}`);
        const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (!retryable) throw lastErr;
        await sleep(Math.min(10_000, 700 * 2 ** attempt));
        continue;
      }

      if (!Array.isArray(json?.data)) {
        lastErr = new Error(
          `gecko-new_pools missing data[] keys=${Object.keys(json || {}).join(',')}`,
        );
        await sleep(Math.min(10_000, 700 * 2 ** attempt));
        continue;
      }

      return json.data;
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_RETRIES) break;
      await sleep(Math.min(10_000, 700 * 2 ** attempt));
    }
  }
  throw lastErr ?? new Error(`gecko page ${page} exhausted`);
}

async function fetchGeckoNewPoolsRaydium() {
  const out = [];
  for (let page = 1; page <= GECKO_PAGES_MAX; page += 1) {
    const rows = await fetchGeckoPoolsPage(page);
    for (const row of rows) {
      const p = parseGeckoRaydiumPool(row);
      if (p) out.push(p);
    }
    await sleep(GECKO_PAGE_SLEEP_MS);
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
    rpcBillableCalls += 1;
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
    signaturesPages: sigPages,
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
  rpcBillableCalls = 0;
  const ignorePrograms = ignoreProgramIds();

  let poolsRaydium = 0;
  let walletsInserted = 0;
  let signaturesPagesApprox = 0;
  let txFetchedTotal = 0;
  let errorsTotal = 0;

  try {
    const seedPools = loadSeedPools();
    const pools = seedPools ?? (await fetchGeckoNewPoolsRaydium());
    if (seedPools) {
      log('info', 'using seed pools (SA_GRWS_SEED_POOLS_JSON or SA_GRWS_SEED_POOLS_PATH)', {
        count: pools.length,
      });
    }
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
      rpcBillableCalls,
      estimatedQuicknodeCredits: rpcBillableCalls * QN_CREDITS_PER_RPC_CALL,
      quicknodeCreditsPerCallAssumed: QN_CREDITS_PER_RPC_CALL,
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
