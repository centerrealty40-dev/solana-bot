/**
 * W6.8 — Коллектор-оркестратор: Gecko → пулы по lane → QuickNode → `wallets`.
 *
 * Важно: глобальный Gecko `new_pools` на первых страницах почти весь pump/meteora — для raydium/orca/moonshot
 * берём `/networks/solana/dexes/{slug}/pools` (см. geckoDexPoolSlugsForLane). Иначе matchLaneDex давал пустой список → 0 кошельков.
 *
 * Расписание: после минуты `laneIdx*9` UTC в пределах того же часа lane может отработать new_pools (один раз на слот);
 * trending /6ч, extended /12ч, daily_deep раз/сутки. Тик планировщика по умолчанию 10s — не пропускать фазы.
 *
 * Usage:
 *   DATABASE_URL=... SA_ORCH_RPC_URL=... node scripts-tmp/sa-wallet-orchestrator.mjs --once
 *   node scripts-tmp/sa-wallet-orchestrator.mjs --daemon
 *   node scripts-tmp/sa-wallet-orchestrator.mjs --budget-report
 *
 * Normative: docs/Smart Lottery V2/W6.8_wallet_ingest_orchestrator_gecko_multi_source.md
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  matchLaneDex,
  pagesForLaneJob,
  geckoPathForJobType,
  geckoDexPoolSlugsForLane,
  fireSlotKey,
  isMinuteAlignedForJob,
} from './wallet-orchestrator-lib.mjs';

const { Pool } = pg;

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
  process.env.SA_ORCH_RPC_URL ||
  process.env.SA_GRWS_RPC_URL ||
  process.env.SA_RPC_HTTP_URL ||
  process.env.SOLANA_RPC_HTTP_URL ||
  process.env.SA_RPC_URL;

const COLLECTOR_ID = envStr('SA_ORCH_COLLECTOR_ID', 'sa-wallet-orch');
const COLLECTOR_SEMVER = envStr('SA_ORCH_COLLECTOR_SEMVER', '0.1.0');

const QN_CREDITS_PER_RPC = Math.max(1, envNum('QUICKNODE_CREDITS_PER_SOLANA_RPC', 30));
const MAX_QN_CREDITS_DAY = Math.max(10_000, envNum('SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY', 1_500_000));
const MAX_GECKO_HTTP_DAY = Math.max(100, envNum('SA_ORCH_MAX_GECKO_HTTP_PER_DAY', 40_000));
const GECKO_TARGET_CPM = Math.max(1, Math.min(60, envNum('SA_ORCH_GECKO_TARGET_CALLS_PER_MINUTE', 24)));
const GECKO_MIN_INTERVAL_MS = Math.max(0, envNum('SA_ORCH_GECKO_MIN_INTERVAL_MS', 0));
function geckoMinIntervalMs() {
  if (GECKO_MIN_INTERVAL_MS > 0) return GECKO_MIN_INTERVAL_MS;
  return Math.ceil(60000 / GECKO_TARGET_CPM);
}

const RESERVE_RPC_PCT = Math.min(0.2, Math.max(0, envNum('SA_ORCH_RESERVE_RPC_PCT', 5) / 100));
/** Бюджет QN: держим типичный job заметно ниже cap; см. также pools/tx/sig ниже. */
const ORCH_MAX_RPC_PER_JOB = Math.max(10, envNum('SA_ORCH_MAX_RPC_PER_JOB', 1200));
const ORCH_MAX_RPC_PER_POOL = Math.max(5, envNum('SA_ORCH_MAX_RPC_PER_POOL', 180));
/** Меньше пулов ≈ линейная экономия RPC без большого ущерба (хвост пулов часто даёт дубликаты). */
const ORCH_MAX_POOLS_PER_JOB = Math.max(1, envNum('SA_ORCH_MAX_POOLS_PER_JOB', 20));
const ORCH_SIG_PAGES_MAX = Math.max(1, envNum('SA_ORCH_SIG_PAGES_MAX', 4));
/** Узкая полоса по tx сильнее всего режет кредиты; верх ленты обычно даёт большую долю подписантов. */
const ORCH_TX_PER_POOL = Math.max(0, envNum('SA_ORCH_MAX_TX_FETCHES_PER_POOL', 18));
const ORCH_RPC_SLEEP_MS = Math.max(0, envNum('SA_ORCH_RPC_SLEEP_MS', 220));
/** Частый тик + «окно после фазы» в lib — иначе легко пропустить целый час по lane. */
const ORCH_SCHEDULER_MS = Math.max(5_000, envNum('SA_ORCH_SCHEDULER_TICK_MS', 10_000));
const PUMPSWAP_PAGE_BONUS = Math.max(0, envNum('SA_ORCH_PUMPSWAP_PAGE_BONUS', 2));
const DAILY_DEEP_HOUR_UTC = Math.max(0, Math.min(23, envNum('SA_ORCH_DAILY_DEEP_HOUR_UTC', 3)));
const HTTP_TIMEOUT_MS = Math.max(3000, envNum('SA_ORCH_HTTP_TIMEOUT_MS', 15_000));
const MAX_RETRIES = Math.max(0, envNum('SA_ORCH_HTTP_MAX_RETRIES', 4));
const DRY_RUN = process.env.SA_ORCH_DRY_RUN === '1';

const DAEMON = process.argv.includes('--daemon');
const RUN_ONCE = process.argv.includes('--once');
const BUDGET_REPORT = process.argv.includes('--budget-report');

/** Стартовые веса §7.1 W6.8 (проценты назначаемого RPC‑пула после резерва). */
const DEFAULT_WEIGHTS = {
  pumpswap: 50,
  raydium: 22,
  meteora: 11,
  orca: 10,
  moonshot: 7,
};

const LANES = ['pumpswap', 'raydium', 'meteora', 'orca', 'moonshot'];
const JOB_TYPES = ['new_pools', 'trending_pools', 'extended', 'daily_deep'];

const SA_ORCH_BUILTIN_IGNORE_PROGRAMS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  '11111111111111111111111111111111',
]);

let rpcBillableJob = 0;
let geckoHttpJob = 0;
let tickRpcCapJob = Infinity;
let lastGeckoThrottleAtMs = 0;

function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    component: 'sa-wallet-orchestrator',
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

function statePath() {
  return envStr('SA_ORCH_STATE_PATH', path.join(process.cwd(), 'data', 'wallet-orchestrator-state.json'));
}

function weightsPath() {
  return envStr('SA_ORCH_WEIGHTS_PATH', path.join(process.cwd(), 'data', 'wallet-orchestrator-weights.json'));
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadWeights() {
  const p = weightsPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    const lc = j.lanePct || j;
    const out = {};
    for (const lane of LANES) {
      const n = Number(lc[lane]);
      if (Number.isFinite(n) && n > 0) out[lane] = n;
    }
    const sum = Object.values(out).reduce((a, b) => a + b, 0);
    if (sum <= 0) return { ...DEFAULT_WEIGHTS };
    if (Math.abs(sum - 100) > 0.01) {
      for (const k of Object.keys(out)) out[k] = (out[k] / sum) * 100;
    }
    return out;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

function readStateRaw() {
  const p = statePath();
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      day: typeof j.day === 'string' ? j.day : '',
      rpcCallsDay: Number(j.rpcCallsDay) || 0,
      geckoCallsDay: Number(j.geckoCallsDay) || 0,
      rpcByLane: typeof j.rpcByLane === 'object' && j.rpcByLane ? j.rpcByLane : {},
      firedSlots: typeof j.firedSlots === 'object' && j.firedSlots ? j.firedSlots : {},
      updatedAtMs: Number(j.updatedAtMs) || 0,
    };
  } catch {
    return {
      day: '',
      rpcCallsDay: 0,
      geckoCallsDay: 0,
      rpcByLane: {},
      firedSlots: {},
      updatedAtMs: 0,
    };
  }
}

function writeStateRaw(s) {
  const p = statePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s), 'utf8');
  } catch (e) {
    log('warn', 'orch state write failed', { err: String(e) });
  }
}

function getState() {
  const key = utcDayKey();
  let s = readStateRaw();
  if (s.day !== key) {
    s = {
      day: key,
      rpcCallsDay: 0,
      geckoCallsDay: 0,
      rpcByLane: Object.fromEntries(LANES.map((l) => [l, 0])),
      firedSlots: {},
      updatedAtMs: Date.now(),
    };
    writeStateRaw(s);
  }
  if (!s.rpcByLane || typeof s.rpcByLane !== 'object') s.rpcByLane = {};
  for (const l of LANES) {
    if (typeof s.rpcByLane[l] !== 'number') s.rpcByLane[l] = 0;
  }
  return s;
}

function persistSpend(state, rpcDelta, geckoDelta, laneId) {
  const key = utcDayKey();
  let s = readStateRaw();
  if (s.day !== key) return;
  s.rpcCallsDay += rpcDelta;
  s.geckoCallsDay += geckoDelta;
  s.rpcByLane[laneId] = (s.rpcByLane[laneId] || 0) + rpcDelta;
  s.updatedAtMs = Date.now();
  writeStateRaw(s);
}

function maxRpcPerDayEffective() {
  return Math.floor((MAX_QN_CREDITS_DAY / QN_CREDITS_PER_RPC) * (1 - RESERVE_RPC_PCT));
}

function laneDailyBudgetRpc(weights, laneId) {
  const w = weights[laneId] ?? 10;
  return Math.floor((maxRpcPerDayEffective() * w) / 100);
}

function printBudgetReport() {
  const maxRpc = Math.floor(MAX_QN_CREDITS_DAY / QN_CREDITS_PER_RPC);
  const eff = maxRpcPerDayEffective();
  const w = loadWeights();
  console.log(
    JSON.stringify(
      {
        component: 'sa-wallet-orchestrator-budget-report',
        maxQuicknodeCreditsPerDay: MAX_QN_CREDITS_DAY,
        quicknodeCreditsPerRpcAssumed: QN_CREDITS_PER_RPC,
        maxBillableRpcPerDayHard: maxRpc,
        reserveRpcPct: RESERVE_RPC_PCT,
        assignableBillableRpcPerDayApprox: eff,
        geckoTargetCpm: GECKO_TARGET_CPM,
        geckoMinIntervalMs: geckoMinIntervalMs(),
        geckoMaxHttpPerDaySoft: MAX_GECKO_HTTP_DAY,
        laneDailyRpcBudgetApprox: Object.fromEntries(
          LANES.map((l) => [l, laneDailyBudgetRpc(w, l)]),
        ),
        weightsEffective: w,
      },
      null,
      2,
    ),
  );
}

if (BUDGET_REPORT) {
  printBudgetReport();
  process.exit(0);
}

if (!DATABASE_URL) {
  console.error('[fatal] DATABASE_URL or SA_PG_DSN required');
  process.exit(1);
}
if (!RPC_URL) {
  console.error('[fatal] SA_ORCH_RPC_URL (or SA_GRWS_RPC_URL / SA_RPC_HTTP_URL / SA_RPC_URL) required');
  process.exit(1);
}

const poolPg = new Pool({ connectionString: DATABASE_URL });

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

function geckoMintFromTokenRefId(refId) {
  if (typeof refId !== 'string' || refId.length < 8) return null;
  if (refId.startsWith('solana_')) return refId.slice('solana_'.length);
  const parts = refId.split('_');
  return parts.length >= 2 ? parts[parts.length - 1] : refId;
}

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
 * @param {unknown} poolData
 * @param {string} laneId
 * @param {boolean} trustDexScoped ответ уже с `/dexes/{slug}/pools` — не отсекаем по matchLaneDex (иначе риск нулей при нестандартном dex.id)
 */
function parsePoolRow(poolData, laneId, trustDexScoped = false) {
  if (!trustDexScoped && !matchLaneDex(poolData, laneId)) return null;
  const rel = poolData?.relationships ?? {};
  const pairAddress = geckoPoolPubkey(poolData);
  const baseMint = geckoMintFromTokenRefId(rel?.base_token?.data?.id);
  const quoteMint = geckoMintFromTokenRefId(rel?.quote_token?.data?.id);
  if (!pairAddress || !baseMint || !quoteMint) return null;
  return { pool_address: pairAddress, base_mint: baseMint, quote_mint: quoteMint };
}

function ignorePrograms() {
  const extra = new Set(
    (process.env.SA_ORCH_IGNORE_PROGRAM_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return new Set([...SA_ORCH_BUILTIN_IGNORE_PROGRAMS, ...extra]);
}

async function geckoThrottle() {
  const minI = geckoMinIntervalMs();
  const now = Date.now();
  const wait = lastGeckoThrottleAtMs + minI - now;
  if (wait > 0) await sleep(wait);
  lastGeckoThrottleAtMs = Date.now();
}

const GECKO_HEADERS = {
  accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (compatible; sa-wallet-orchestrator/0.1; +https://github.com/centerrealty40-dev/solana-bot)',
};

async function fetchGeckoAbsolute(url, state) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    await geckoThrottle();
    if (state.geckoCallsDay + geckoHttpJob >= MAX_GECKO_HTTP_DAY) {
      throw Object.assign(new Error('ORCH_GECKO_DAY_CAP'), { code: 'ORCH_GECKO_DAY_CAP' });
    }
    geckoHttpJob += 1;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
      const res = await fetch(url, { headers: GECKO_HEADERS, signal: controller.signal });
      clearTimeout(timeout);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = new Error(`gecko ${res.status}`);
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          await sleep(Math.min(10_000, 700 * 2 ** attempt));
          continue;
        }
        throw lastErr;
      }
      if (!Array.isArray(json?.data)) {
        lastErr = new Error(`gecko missing data[]`);
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
  throw lastErr ?? new Error('gecko exhausted');
}

async function fetchGeckoPage(pathSegment, page, state) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/${pathSegment}?page=${page}`;
  return fetchGeckoAbsolute(url, state);
}

async function fetchGeckoDexPoolsPage(dexSlug, page, state) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/dexes/${encodeURIComponent(dexSlug)}/pools?page=${page}`;
  return fetchGeckoAbsolute(url, state);
}

async function rpcCall(method, params, state) {
  const maxRpc = Math.floor(MAX_QN_CREDITS_DAY / QN_CREDITS_PER_RPC);
  if (state.rpcCallsDay + rpcBillableJob >= maxRpc) {
    throw Object.assign(new Error('ORCH_QN_DAY_CAP'), { code: 'ORCH_QN_DAY_CAP' });
  }
  if (rpcBillableJob >= tickRpcCapJob) {
    throw Object.assign(new Error('ORCH_JOB_RPC_CAP'), { code: 'ORCH_JOB_RPC_CAP' });
  }
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
    rpcBillableJob += 1;
    return j.result;
  } finally {
    clearTimeout(timeout);
  }
}

function extractSignerPubkeys(txJson) {
  const set = new Set();
  const tx = txJson?.transaction;
  if (!tx) return [];
  const msg = tx.message;
  const keys = msg?.accountKeys;
  if (Array.isArray(keys)) {
    for (const k of keys) {
      if (typeof k === 'object' && k?.pubkey && k.signer === true) set.add(k.pubkey);
    }
  }
  const meta = txJson?.meta;
  if (meta && typeof meta.feePayer === 'string') set.add(meta.feePayer);
  if (set.size === 0 && Array.isArray(keys) && keys.length > 0 && typeof keys[0] === 'string') {
    set.add(keys[0]);
  }
  return [...set];
}

async function collectPoolWallets(poolRow, batchId, ignoreProgs, metaBase, laneRpcBudgetPool, state) {
  const { pool_address } = poolRow;
  let rpcPool = 0;
  const walletRows = [];
  let sigPages = 0;

  const signatures = [];
  let before = undefined;
  for (let page = 0; page < ORCH_SIG_PAGES_MAX; page += 1) {
    if (rpcPool >= laneRpcBudgetPool || rpcBillableJob >= tickRpcCapJob) break;
    const opts = { limit: 100 };
    if (before) opts.before = before;
    try {
      const chunk = await rpcCall('getSignaturesForAddress', [pool_address, opts], state);
      rpcPool += 1;
      sigPages += 1;
      await sleep(ORCH_RPC_SLEEP_MS);
      if (!Array.isArray(chunk) || chunk.length === 0) break;
      for (const row of chunk) {
        if (row?.signature && !row.err) signatures.push(row.signature);
      }
      before = chunk[chunk.length - 1]?.signature;
      if (chunk.length < 100) break;
    } catch (e) {
      if (e?.code === 'ORCH_JOB_RPC_CAP' || e?.code === 'ORCH_QN_DAY_CAP') throw e;
      log('warn', 'getSignaturesForAddress failed', { pool: pool_address.slice(0, 8), err: String(e) });
      break;
    }
  }

  const lim = Math.min(signatures.length, ORCH_TX_PER_POOL);
  for (let i = 0; i < lim; i += 1) {
    if (rpcPool >= laneRpcBudgetPool || rpcBillableJob >= tickRpcCapJob) break;
    const sig = signatures[i];
    try {
      const txJson = await rpcCall(
        'getTransaction',
        [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        state,
      );
      rpcPool += 1;
      await sleep(ORCH_RPC_SLEEP_MS);
      if (!txJson) continue;
      for (const pk of extractSignerPubkeys(txJson)) {
        if (!looksLikeSolanaPubkey(pk)) continue;
        if (ignoreProgs.has(pk)) continue;
        walletRows.push({ address: pk, metadata: { ...metaBase } });
      }
    } catch (e) {
      if (e?.code === 'ORCH_JOB_RPC_CAP' || e?.code === 'ORCH_QN_DAY_CAP') throw e;
      log('warn', 'getTransaction failed', { sig: sig?.slice(0, 12), err: String(e) });
    }
  }

  const dedup = new Map();
  for (const w of walletRows) {
    if (!dedup.has(w.address)) dedup.set(w.address, w);
  }
  return { walletRows: [...dedup.values()], rpcUsed: rpcPool, sigPages };
}

async function insertWalletBatch(client, rows) {
  if (rows.length === 0) return 0;
  const placeholders = rows.map((_, i) => `($${i * 2 + 1}, now(), $${i * 2 + 2}::jsonb)`).join(', ');
  const flat = rows.flatMap((r) => [r.address, JSON.stringify(r.metadata)]);
  const res = await client.query(
    `INSERT INTO wallets (address, first_seen_at, metadata) VALUES ${placeholders}
     ON CONFLICT (address) DO NOTHING`,
    flat,
  );
  return res.rowCount ?? 0;
}

function computeJobRpcCap(state, weights, laneId) {
  const maxHard = Math.floor(MAX_QN_CREDITS_DAY / QN_CREDITS_PER_RPC);
  const globalLeft = Math.max(0, maxHard - state.rpcCallsDay);
  const laneBudget = laneDailyBudgetRpc(weights, laneId);
  const laneUsed = state.rpcByLane[laneId] || 0;
  const laneLeft = Math.max(0, laneBudget - laneUsed);
  return Math.min(ORCH_MAX_RPC_PER_JOB, globalLeft, laneLeft);
}

/** @returns {Promise<boolean>} true — job реально отработал (можно помечать слот); false — пропуск без траты слота */
async function runJob(laneId, laneIdx, jobType, weights, batchId) {
  const state = getState();
  rpcBillableJob = 0;
  geckoHttpJob = 0;
  tickRpcCapJob = computeJobRpcCap(state, weights, laneId);
  if (tickRpcCapJob <= 0) {
    log('warn', 'job skipped zero rpc budget', { laneId, jobType });
    return false;
  }

  const pathSeg = geckoPathForJobType(jobType);
  const pages = pagesForLaneJob(jobType, laneId, PUMPSWAP_PAGE_BONUS);
  const dexSlugs = geckoDexPoolSlugsForLane(laneId);
  /** У dex нет `/trending_pools` — только глобальный чарт. */
  const useDexEndpoints = dexSlugs && jobType !== 'trending_pools';
  const dedup = new Map();
  try {
    if (useDexEndpoints) {
      for (const slug of dexSlugs) {
        for (let pg = 1; pg <= pages; pg += 1) {
          const rows = await fetchGeckoDexPoolsPage(slug, pg, state);
          for (const row of rows) {
            const p = parsePoolRow(row, laneId, true);
            if (p && !dedup.has(p.pool_address)) dedup.set(p.pool_address, p);
          }
          await sleep(envNum('SA_ORCH_GECKO_PAGE_SLEEP_MS', 400));
        }
      }
    } else {
      for (let pg = 1; pg <= pages; pg += 1) {
        const rows = await fetchGeckoPage(pathSeg, pg, state);
        for (const row of rows) {
          const p = parsePoolRow(row, laneId);
          if (p && !dedup.has(p.pool_address)) dedup.set(p.pool_address, p);
        }
        await sleep(envNum('SA_ORCH_GECKO_PAGE_SLEEP_MS', 400));
      }
    }
  } catch (e) {
    if (e?.code === 'ORCH_GECKO_DAY_CAP') {
      log('warn', 'gecko daily soft cap', { laneId, jobType });
    } else {
      log('warn', 'gecko fetch failed', { laneId, jobType, err: String(e) });
    }
  }

  const pools = [...dedup.values()].slice(0, ORCH_MAX_POOLS_PER_JOB);
  const ignoreProgs = ignorePrograms();
  const seedTs = new Date().toISOString();
  const metaBase = {
    gecko_multi_seed: true,
    seed_lane: laneId,
    job_type: jobType,
    seed_ts: seedTs,
    collector_id: COLLECTOR_ID,
    collector_semver: COLLECTOR_SEMVER,
    batch_id: batchId,
    orch_semver: COLLECTOR_SEMVER,
  };

  let walletsInserted = 0;
  let walletsUnique = 0;
  let txRpcApprox = 0;
  const allRows = [];

  for (const pr of pools) {
    if (rpcBillableJob >= tickRpcCapJob) break;
    const remainJob = tickRpcCapJob - rpcBillableJob;
    const perPoolCap = Math.min(ORCH_MAX_RPC_PER_POOL, remainJob);
    metaBase.seed_pool = pr.pool_address;
    metaBase.seed_base_mint = pr.base_mint;
    metaBase.seed_quote_mint = pr.quote_mint;
    try {
      const { walletRows, rpcUsed } = await collectPoolWallets(
        pr,
        batchId,
        ignoreProgs,
        metaBase,
        perPoolCap,
        state,
      );
      txRpcApprox += rpcUsed;
      walletsUnique += walletRows.length;
      allRows.push(...walletRows);
    } catch (e) {
      if (e?.code === 'ORCH_JOB_RPC_CAP' || e?.code === 'ORCH_QN_DAY_CAP') break;
      log('warn', 'pool harvest failed', { pool: pr.pool_address.slice(0, 8), err: String(e) });
    }
  }

  const globalDedup = new Map();
  for (const w of allRows) {
    if (!globalDedup.has(w.address)) globalDedup.set(w.address, w);
  }
  const uniqueRows = [...globalDedup.values()];

  if (!DRY_RUN && uniqueRows.length > 0) {
    const client = await poolPg.connect();
    try {
      const chunkSize = 400;
      for (let i = 0; i < uniqueRows.length; i += chunkSize) {
        const chunk = uniqueRows.slice(i, i + chunkSize);
        walletsInserted += await insertWalletBatch(client, chunk);
      }
    } finally {
      client.release();
    }
  }

  persistSpend(state, rpcBillableJob, geckoHttpJob, laneId);

  if (pools.length > 0 && uniqueRows.length === 0) {
    log('info', 'orch job zero unique wallets', {
      laneId,
      jobType,
      poolsProcessed: pools.length,
      hint: 'RPC ok but no signer rows or all duplicates vs DB',
    });
  }

  log('info', 'orch job completed', {
    laneId,
    jobType,
    geckoPages: pages,
    geckoHttpCalls: geckoHttpJob,
    poolsProcessed: pools.length,
    walletsUnique: uniqueRows.length,
    walletsInserted: DRY_RUN ? 0 : walletsInserted,
    rpcBillableCalls: rpcBillableJob,
    estimatedQuicknodeCredits: rpcBillableJob * QN_CREDITS_PER_RPC,
    rpcCapJob: tickRpcCapJob,
    batchId,
    dryRun: DRY_RUN,
  });
  return true;
}

function markSlotFired(state, laneId, jobType, hourUtc, utcDay) {
  const slot = fireSlotKey(utcDay, jobType, laneId, hourUtc);
  let s = readStateRaw();
  if (s.day !== utcDay) return;
  s.firedSlots[slot] = Date.now();
  writeStateRaw(s);
}

function alreadyFired(state, laneId, jobType, hourUtc, utcDay) {
  const slot = fireSlotKey(utcDay, jobType, laneId, hourUtc);
  return Boolean(state.firedSlots[slot]);
}

async function schedulerWaveBody(batchId) {
  const weights = loadWeights();

  for (let li = 0; li < LANES.length; li += 1) {
    const laneId = LANES[li];
    for (const jobType of JOB_TYPES) {
      const now = new Date();
      const utcDay = utcDayKey();
      const hourUtc = now.getUTCHours();
      if (!isMinuteAlignedForJob({ laneIdx: li, jobType, now, dailyDeepHourUtc: DAILY_DEEP_HOUR_UTC })) {
        continue;
      }
      if (alreadyFired(getState(), laneId, jobType, hourUtc, utcDay)) continue;
      log('info', 'orch job start', { laneId, jobType, hourUtc, minuteUtc: now.getUTCMinutes() });
      try {
        const committed = await runJob(laneId, li, jobType, weights, batchId);
        if (committed) markSlotFired(getState(), laneId, jobType, hourUtc, utcDay);
      } catch (e) {
        log('error', 'orch job failed', { laneId, jobType, err: String(e) });
      }
    }
  }
}

/** Цепочка волн: без параллельных schedulerWave (гонки по state и двойные job в ту же минуту). */
let schedulerWaveChain = Promise.resolve();

function enqueueSchedulerWave(batchId) {
  schedulerWaveChain = schedulerWaveChain
    .then(() => schedulerWaveBody(batchId))
    .catch((e) => log('error', 'scheduler wave', { err: String(e) }));
  return schedulerWaveChain;
}

let batchIdProcess = makeBatchId();

async function shutdown(signal) {
  log('info', 'shutdown', { signal });
  try {
    await poolPg.end();
  } catch {
    /* */
  }
  process.exit(0);
}

async function main() {
  log('info', 'sa-wallet-orchestrator start', {
    daemon: DAEMON,
    rpcHost: RPC_URL.replace(/\?.*/, '').slice(0, 52),
    collectorId: COLLECTOR_ID,
    statePath: statePath(),
    weightsPath: weightsPath(),
    dryRun: DRY_RUN,
    maxQnCreditsDay: MAX_QN_CREDITS_DAY,
    reserveRpcPct: RESERVE_RPC_PCT,
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  batchIdProcess = makeBatchId();

  if (RUN_ONCE || !DAEMON) {
    await enqueueSchedulerWave(batchIdProcess);
    await shutdown('once');
    return;
  }

  await enqueueSchedulerWave(batchIdProcess);
  setInterval(() => {
    enqueueSchedulerWave(batchIdProcess);
  }, ORCH_SCHEDULER_MS);
}

main().catch((e) => {
  log('error', 'fatal', { err: String(e) });
  process.exit(1);
});
