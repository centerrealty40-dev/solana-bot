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
const TOKEN_CHUNK = 10;
const DS_DELAY_MS = 350;

function isPlausibleMint(m) {
  return typeof m === 'string' && m.length >= 32 && m.length <= 64;
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
    let buf;
    try {
      buf = fs.readFileSync(fp, 'utf-8');
    } catch {
      continue;
    }
    const open = new Map();
    for (const ln of buf.split('\n')) {
      if (!ln.trim()) continue;
      try {
        const e = JSON.parse(ln);
        if (e.kind === 'open' && e.mint && typeof e.entryTs === 'number') {
          open.set(e.mint, true);
        } else if (e.kind === 'close' && e.mint) {
          open.delete(e.mint);
        }
      } catch {
        /* ignore bad line */
      }
    }
    for (const m of open.keys()) {
      if (isPlausibleMint(m)) out.add(m);
    }
  }
  return [...out];
}

/** Replay Live Oscar JSONL: open positions until `live_position_close`. */
export function loadLiveOscarOpenMintsSync() {
  if (process.env.PAPER2_SNAPSHOT_LIVE_OPENS === '0') return [];
  const fp = process.env.LIVE_TRADES_PATH || process.env.PAPER2_SNAPSHOT_LIVE_JSONL || DEFAULT_LIVE_JSONL;
  if (!fp || !fs.existsSync(fp)) return [];
  let buf;
  try {
    buf = fs.readFileSync(fp, 'utf-8');
  } catch {
    return [];
  }
  const open = new Map();
  for (const ln of buf.split('\n')) {
    if (!ln.trim()) continue;
    try {
      const e = JSON.parse(ln);
      if (e.channel && e.channel !== 'live') continue;
      const mint = e.mint;
      if (!mint || typeof mint !== 'string') continue;
      const k = e.kind;
      if (k === 'live_position_open' || k === 'live_position_scale_in' || k === 'live_position_dca') {
        open.set(mint, true);
      } else if (k === 'live_position_close') {
        open.delete(mint);
      }
    } catch {
      /* ignore bad line */
    }
  }
  const out = [];
  for (const m of open.keys()) {
    if (isPlausibleMint(m)) out.push(m);
  }
  return out;
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
  let whitelistSet = new Set();
  try {
    const paper = loadPaper2OpenMintsSync(dir);
    const live = loadLiveOscarOpenMintsSync();
    const whitelist = loadLiveOscarWhitelistMintsSync();
    whitelistMintCount = whitelist.length;
    whitelistSet = new Set(whitelist);
    openMints = [...new Set([...paper, ...live, ...whitelist])];
  } catch (e) {
    if (log) log('warn', 'paper2/live open mints load failed', { error: String(e), component });
    return rows;
  }
  if (openMints.length === 0) return rows;

  const covered = mintsWithBaseSnapshot(rows);
  const missing = openMints.filter((m) => !covered.has(m));
  if (missing.length === 0) return rows;

  const missingWhitelist = missing.filter((m) => whitelistSet.has(m));
  const missingBatch = missing.filter((m) => !whitelistSet.has(m));

  const extra = [];
  let whitelistSingleFetchOk = 0;

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
  for (const mint of missingWhitelist) {
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
  const stillMissingWl = missingWhitelist.filter((m) => !coveredAfterExtra.has(m));

  if (extra.length === 0) {
    if (log) {
      log('info', 'paper2/live open mints: token lookup produced no rows for this dex', {
        component,
        openMintCount: openMints.length,
        missingFromPrimaryTick: missing.length,
        missingWhitelist: missingWhitelist.length,
        stillMissingWhitelist: stillMissingWl.length,
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
      missingFromPrimaryTick: missing.length,
      missingWhitelist: missingWhitelist.length,
      whitelistSingleFetchOk,
      stillMissingWhitelist: stillMissingWl.length,
      extraPairsThisDex: extra.length,
      rowCountAfterMerge: merged.length,
    });
  }
  return merged;
}
