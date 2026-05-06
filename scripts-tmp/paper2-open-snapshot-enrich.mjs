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

function mintsTouchedByRows(rows) {
  const s = new Set();
  for (const r of rows) {
    if (r?.base_mint) s.add(r.base_mint);
    if (r?.quote_mint) s.add(r.quote_mint);
  }
  return s;
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
  try {
    const paper = loadPaper2OpenMintsSync(dir);
    const live = loadLiveOscarOpenMintsSync();
    openMints = [...new Set([...paper, ...live])];
  } catch (e) {
    if (log) log('warn', 'paper2/live open mints load failed', { error: String(e), component });
    return rows;
  }
  if (openMints.length === 0) return rows;

  const covered = mintsTouchedByRows(rows);
  const missing = openMints.filter((m) => !covered.has(m));
  if (missing.length === 0) return rows;

  const extra = [];
  for (let i = 0; i < missing.length; i += TOKEN_CHUNK) {
    const chunk = missing.slice(i, i + TOKEN_CHUNK);
    const url = `https://api.dexscreener.com/latest/dex/tokens/${chunk.map((m) => encodeURIComponent(m)).join(',')}`;
    try {
      const json = await fetchJsonWithRetry(url, {}, 'dexscreener-tokens');
      const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
      for (const p of pairs) {
        const row = normalizeDexPair(p, bucketTs);
        if (row) extra.push(row);
      }
    } catch (e) {
      if (log) {
        log('warn', 'dexscreener tokens fetch failed', {
          error: String(e),
          chunkSize: chunk.length,
          component,
        });
      }
    }
    await sleep(DS_DELAY_MS);
  }

  if (extra.length === 0) {
    if (log) {
      log('info', 'paper2/live open mints: token lookup produced no rows for this dex', {
        component,
        openMintCount: openMints.length,
        missingFromPrimaryTick: missing.length,
      });
    }
    return rows;
  }

  const merged = dedupByPairAddress([...rows, ...extra]);
  if (log) {
    log('info', 'paper2/live open mint snapshots merged', {
      component,
      openMintCount: openMints.length,
      missingFromPrimaryTick: missing.length,
      extraPairsThisDex: extra.length,
      rowCountAfterMerge: merged.length,
    });
  }
  return merged;
}
