/**
 * Ensures DEX snapshot collectors also ingest pools for mints that are open in paper2 journals
 * or in the Live Oscar JSONL, so discovery / dashboard see pairs that trending feeds omit.
 *
 * Disable paper+live enrich: PAPER2_SNAPSHOT_OPENS=0
 * Disable live side only: PAPER2_SNAPSHOT_LIVE_OPENS=0
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PAPER2_DIR = '/opt/solana-alpha/data/paper2';
const DEFAULT_LIVE_JSONL = path.join(path.dirname(DEFAULT_PAPER2_DIR), 'live', 'pt1-oscar-live.jsonl');
const DEFAULT_WHITELIST_PATH = path.join(path.dirname(DEFAULT_PAPER2_DIR), 'live', 'live-oscar-mint-whitelist.txt');
const DEFAULT_DISCOVERY_PIN_PATH = path.join(
  path.dirname(DEFAULT_PAPER2_DIR),
  'live',
  'discovery-collector-pin-mints.txt',
);
const TOKEN_CHUNK = 10;
const DS_DELAY_MS = Number(process.env.PAPER2_SNAPSHOT_DS_DELAY_MS || 500);
/** Cap solo `/tokens/{mint}` calls per collector tick — rotate through queue across ticks. */
const SOLO_FETCH_MAX_PER_TICK = Number(process.env.PAPER2_SNAPSHOT_SOLO_FETCH_MAX_PER_TICK || 6);
/** Cap batch `/tokens/{m1,m2,…}` chunks per tick (10 mints each). */
const BATCH_CHUNKS_MAX_PER_TICK = Number(process.env.PAPER2_SNAPSHOT_BATCH_CHUNKS_MAX_PER_TICK || 8);

/** Per-component rotation cursor for capped solo-fetch queues. */
const _soloFetchRotation = new Map();
/**
 * Stream-read chunk size (~256 KB). Keeps memory constant regardless of file
 * size, which matters because the live JSONL grows past 300MB and previous
 * `readFileSync` of 5 collectors × 1 tick/min was producing ≈1.5GB heap churn,
 * blowing past pm2 max_memory_restart and looping crashes every ~30s.
 */
const STREAM_CHUNK_BYTES = 256 * 1024;
/**
 * In-process cache TTL for parsed open-mint sets. With 1-min collector tick
 * cycles, 30s TTL means each collector parses a 300MB JSONL at most twice
 * per minute instead of every tick. Set to `0` to disable caching.
 */
const OPEN_MINTS_CACHE_TTL_MS = Number(process.env.PAPER2_OPEN_MINTS_CACHE_TTL_MS || 30_000);

const _openMintsCache = new Map(); // key -> { ts, mtimeMs, size, value }

function isPlausibleMint(m) {
  return typeof m === 'string' && m.length >= 32 && m.length <= 64;
}

/**
 * Stream a file line-by-line via `fs.readSync` with a fixed-size buffer. Calls
 * `onLine(line)` for each parsed line (without the trailing `\n`). Memory is
 * bounded by the buffer size + the longest single line, never the file size.
 */
function streamLinesSync(fp, onLine) {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(STREAM_CHUNK_BYTES);
    let leftover = '';
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, STREAM_CHUNK_BYTES, null)) > 0) {
      const text = leftover + buf.toString('utf-8', 0, bytesRead);
      const lines = text.split('\n');
      leftover = lines.pop() ?? '';
      for (const ln of lines) {
        if (ln) onLine(ln);
      }
    }
    if (leftover) onLine(leftover);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function getCachedOrCompute(cacheKey, fp, computeFn) {
  if (OPEN_MINTS_CACHE_TTL_MS <= 0) return computeFn();
  let stat;
  try { stat = fs.statSync(fp); } catch { return computeFn(); }
  const cached = _openMintsCache.get(cacheKey);
  const now = Date.now();
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    (now - cached.ts) < OPEN_MINTS_CACHE_TTL_MS
  ) {
    return cached.value;
  }
  const value = computeFn();
  _openMintsCache.set(cacheKey, { ts: now, mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}

/** Replay each strategy jsonl like store-restore: open adds mint, close removes. */
export function loadPaper2OpenMintsSync(paper2Dir) {
  const out = new Set();
  const dir = paper2Dir || process.env.PAPER2_DIR || DEFAULT_PAPER2_DIR;
  if (!dir || !fs.existsSync(dir)) return [];
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(dir, f);
    const cached = getCachedOrCompute(`paper2:${fp}`, fp, () => {
      const open = new Map();
      try {
        streamLinesSync(fp, (ln) => {
          if (!ln.trim()) return;
          try {
            const e = JSON.parse(ln);
            if (e.kind === 'open' && e.mint && typeof e.entryTs === 'number') {
              open.set(e.mint, true);
            } else if (e.kind === 'close' && e.mint) {
              open.delete(e.mint);
            }
          } catch { /* ignore bad line */ }
        });
      } catch { /* ignore file errors */ }
      const arr = [];
      for (const m of open.keys()) if (isPlausibleMint(m)) arr.push(m);
      return arr;
    });
    for (const m of cached) out.add(m);
  }
  return [...out];
}

/** Replay Live Oscar JSONL: open positions until `live_position_close`. */
export function loadLiveOscarOpenMintsSync() {
  if (process.env.PAPER2_SNAPSHOT_LIVE_OPENS === '0') return [];
  const fp = process.env.LIVE_TRADES_PATH || process.env.PAPER2_SNAPSHOT_LIVE_JSONL || DEFAULT_LIVE_JSONL;
  if (!fp || !fs.existsSync(fp)) return [];
  return getCachedOrCompute(`live:${fp}`, fp, () => {
    const open = new Map();
    try {
      streamLinesSync(fp, (ln) => {
        if (!ln.trim()) return;
        try {
          const e = JSON.parse(ln);
          if (e.channel && e.channel !== 'live') return;
          const mint = e.mint;
          if (!mint || typeof mint !== 'string') return;
          const k = e.kind;
          if (k === 'live_position_open' || k === 'live_position_scale_in' || k === 'live_position_dca') {
            open.set(mint, true);
          } else if (k === 'live_position_close') {
            open.delete(mint);
          }
        } catch { /* ignore bad line */ }
      });
    } catch { /* ignore file errors */ }
    const out = [];
    for (const m of open.keys()) if (isPlausibleMint(m)) out.push(m);
    return out;
  });
}

/** Tracked mint allowlist — same file as `LIVE_MINT_WHITELIST_PATH` on live-oscar. */
export function loadLiveOscarWhitelistMintsSync() {
  if (process.env.PAPER2_SNAPSHOT_WHITELIST === '0') return [];
  const fp =
    process.env.LIVE_MINT_WHITELIST_PATH?.trim() ||
    process.env.LIVE_DISCOVERY_DEEP_AUDIT_WHITELIST_PATH?.trim() ||
    DEFAULT_WHITELIST_PATH;
  if (!fp || !fs.existsSync(fp)) return [];
  let buf;
  try {
    buf = fs.readFileSync(fp, 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const ln of buf.split('\n')) {
    const s = ln.split('#')[0].trim();
    if (isPlausibleMint(s)) out.push(s);
  }
  return out;
}

/** Mint'ы из live-oscar discovery SQL + priority tier (`discovery-collector-pin.mints`). */
export function loadDiscoveryCollectorPinMintsSync() {
  if (['0', 'false', 'no'].includes(String(process.env.PAPER2_SNAPSHOT_DISCOVERY_PIN ?? '1').toLowerCase())) {
    return [];
  }
  const fp = process.env.PAPER2_SNAPSHOT_DISCOVERY_PIN_PATH?.trim() || DEFAULT_DISCOVERY_PIN_PATH;
  if (!fp || !fs.existsSync(fp)) return [];
  let buf;
  try {
    buf = fs.readFileSync(fp, 'utf-8');
  } catch {
    return [];
  }
  const out = [];
  for (const ln of buf.split('\n')) {
    const s = ln.split('#')[0].trim();
    if (isPlausibleMint(s)) out.push(s);
  }
  return out;
}

function prioritizeSoloMints(missingSolo, { liveSet, paperSet, whitelistSet, discoverySet }) {
  const seen = new Set();
  const out = [];
  const tiers = [
    missingSolo.filter((m) => liveSet.has(m)),
    missingSolo.filter((m) => paperSet.has(m) && !liveSet.has(m)),
    missingSolo.filter((m) => whitelistSet.has(m) && !liveSet.has(m) && !paperSet.has(m)),
    missingSolo.filter(
      (m) => discoverySet.has(m) && !whitelistSet.has(m) && !liveSet.has(m) && !paperSet.has(m),
    ),
    missingSolo.filter(
      (m) => !liveSet.has(m) && !paperSet.has(m) && !whitelistSet.has(m) && !discoverySet.has(m),
    ),
  ];
  for (const tier of tiers) {
    for (const m of tier) {
      if (seen.has(m)) continue;
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

function selectRotatingBatch(list, component, max) {
  if (max <= 0 || list.length === 0) return [];
  if (list.length <= max) return list;
  const cursor = _soloFetchRotation.get(component) ?? 0;
  const selected = [];
  for (let i = 0; i < max; i += 1) {
    selected.push(list[(cursor + i) % list.length]);
  }
  _soloFetchRotation.set(component, (cursor + max) % list.length);
  return selected;
}

/** Discovery / dip eval keys on `base_mint` — quote-only presence must not skip enrich. */
function mintsWithBaseSnapshot(rows) {
  const s = new Set();
  for (const r of rows) {
    if (r?.base_mint) s.add(r.base_mint);
  }
  return s;
}

async function fetchDexPairsForMintChunk({
  chunk,
  bucketTs,
  fetchJsonWithRetry,
  normalizeDexPair,
  extra,
  log,
  component,
  retryTag,
}) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((m) => encodeURIComponent(m)).join(',')}`;
  try {
    const json = await fetchJsonWithRetry(url, {}, retryTag);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    for (const p of pairs) {
      const row = normalizeDexPair(p, bucketTs);
      if (row) extra.push(row);
    }
    return { ok: true, pairs: pairs.length };
  } catch (e) {
    if (log) {
      log('warn', 'dexscreener tokens fetch failed', {
        error: String(e),
        chunkSize: chunk.length,
        component,
      });
    }
    return { ok: false, pairs: 0 };
  }
}

/**
 * @param {object} opts
 * @param {object[]} opts.rows
 * @param {Date} opts.bucketTs
 * @param {string} [opts.paper2Dir]
 * @param {function} opts.fetchJsonWithRetry
 * @param {function} opts.sleep
 * @param {function} opts.normalizeDexPair (pair, bucketTs) => row | null
 * @param {function} opts.dedupByPairAddress
 * @param {function} [opts.log] (level, msg, meta?) — same shape as collectors
 * @param {string} [opts.component]
 */
export async function mergePaper2OpenMintSnapshots({
  rows,
  bucketTs,
  paper2Dir,
  fetchJsonWithRetry,
  sleep,
  normalizeDexPair,
  dedupByPairAddress,
  log,
  component = 'dex-collector',
}) {
  if (process.env.PAPER2_SNAPSHOT_OPENS === '0') return rows;
  const dir = paper2Dir || process.env.PAPER2_DIR || DEFAULT_PAPER2_DIR;
  let openMints;
  let whitelistMintCount = 0;
  let discoveryPinMintCount = 0;
  let soloFetchSet = new Set();
  let liveSet = new Set();
  let paperSet = new Set();
  let whitelistSet = new Set();
  let discoverySet = new Set();
  try {
    const paper = loadPaper2OpenMintsSync(dir);
    const live = loadLiveOscarOpenMintsSync();
    const whitelist = loadLiveOscarWhitelistMintsSync();
    const discoveryPin = loadDiscoveryCollectorPinMintsSync();
    whitelistMintCount = whitelist.length;
    discoveryPinMintCount = discoveryPin.length;
    paperSet = new Set(paper);
    liveSet = new Set(live);
    whitelistSet = new Set(whitelist);
    discoverySet = new Set(discoveryPin);
    soloFetchSet = new Set([...whitelist, ...discoveryPin]);
    openMints = [...new Set([...paper, ...live, ...whitelist, ...discoveryPin])];
  } catch (e) {
    if (log) log('warn', 'paper2/live open mints load failed', { error: String(e), component });
    return rows;
  }
  if (openMints.length === 0) return rows;

  const covered = mintsWithBaseSnapshot(rows);
  const missing = openMints.filter((m) => !covered.has(m));
  if (missing.length === 0) return rows;

  const missingSoloAll = missing.filter((m) => soloFetchSet.has(m));
  const missingBatchAll = missing.filter((m) => !soloFetchSet.has(m));
  const prioritizedSolo = prioritizeSoloMints(missingSoloAll, {
    liveSet,
    paperSet,
    whitelistSet,
    discoverySet,
  });
  const missingSolo = selectRotatingBatch(prioritizedSolo, component, SOLO_FETCH_MAX_PER_TICK);
  const batchChunkLimit = BATCH_CHUNKS_MAX_PER_TICK * TOKEN_CHUNK;
  const missingBatch = missingBatchAll.slice(0, batchChunkLimit);

  const extra = [];
  let whitelistSingleFetchOk = 0;
  const soloFetchDeferred = Math.max(0, prioritizedSolo.length - missingSolo.length);
  const batchFetchDeferred = Math.max(0, missingBatchAll.length - missingBatch.length);

  for (let i = 0; i < missingBatch.length; i += TOKEN_CHUNK) {
    const chunk = missingBatch.slice(i, i + TOKEN_CHUNK);
    await fetchDexPairsForMintChunk({
      chunk,
      bucketTs,
      fetchJsonWithRetry,
      normalizeDexPair,
      extra,
      log,
      component,
      retryTag: 'dexscreener-tokens',
    });
    await sleep(DS_DELAY_MS);
  }

  /**
   * DexScreener `/tokens/{m1,m2,…}` truncates pairs for later mints in the URL (observed: 4-mint chunk
   * returns 30 pairs but omits trailing whitelist runner). Whitelist mints always get a solo fetch.
   */
  for (const mint of missingSolo) {
    const res = await fetchDexPairsForMintChunk({
      chunk: [mint],
      bucketTs,
      fetchJsonWithRetry,
      normalizeDexPair,
      extra,
      log,
      component,
      retryTag: 'dexscreener-token-solo',
    });
    if (res.ok && res.pairs > 0) whitelistSingleFetchOk += 1;
    await sleep(DS_DELAY_MS);
  }

  const coveredAfterExtra = mintsWithBaseSnapshot(extra);
  const stillMissingSolo = missingSolo.filter((m) => !coveredAfterExtra.has(m));

  if (extra.length === 0) {
    if (log) {
      log('info', 'paper2/live open mints: token lookup produced no rows for this dex', {
        component,
        openMintCount: openMints.length,
        missingFromPrimaryTick: missing.length,
        missingSoloFetch: missingSolo.length,
        soloFetchDeferred,
        batchFetchDeferred,
        stillMissingSoloFetch: stillMissingSolo.length,
      });
    }
    return rows;
  }

  const merged = dedupByPairAddress([...rows, ...extra]);
  if (log) {
    log('info', 'paper2/live open mint snapshots merged', {
      component,
      openMintCount: openMints.length,
      whitelistMintCount,
      discoveryPinMintCount,
      missingFromPrimaryTick: missing.length,
      missingSoloFetch: missingSolo.length,
      soloFetchDeferred,
      batchFetchDeferred,
      soloFetchOk: whitelistSingleFetchOk,
      stillMissingSoloFetch: stillMissingSolo.length,
      extraPairsThisDex: extra.length,
      rowCountAfterMerge: merged.length,
    });
  }
  return merged;
}
