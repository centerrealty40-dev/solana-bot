/**
 * Birdeye REST enrich for DEX snapshot collectors (pumpswap / raydium / meteora).
 * When BIRDEYE_COLLECTOR_ENABLED=1: fetch market-data for open/pin mints missing from the
 * primary tick, overlay fresh price/mcap on existing rows, then DexScreener fallback for gaps.
 */
import { acquireDexScreenerSlot } from './dexscreener-api-gate.mjs';
import { sendTagged } from '../scripts/lib/telegram.mjs';
import {
  loadPaper2OpenMintsSync,
  loadLiveOscarOpenMintsSync,
  loadLiveOscarWhitelistMintsSync,
  loadDiscoveryCollectorPinMintsSync,
} from './paper2-open-snapshot-enrich.mjs';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const BIRDEYE_TTL_MS = Number(process.env.BIRDEYE_MARKET_TTL_MS || 12_000);
const BIRDEYE_TIMEOUT_MS = Number(process.env.BIRDEYE_COLLECTOR_TIMEOUT_MS || 4_000);
const BIRDEYE_BATCH_ENABLED =
  process.env.BIRDEYE_USE_BATCH === '1' || process.env.BIRDEYE_BATCH_ENABLED === '1';
const BIRDEYE_BATCH_CHUNK = Number(process.env.BIRDEYE_BATCH_CHUNK_SIZE || 20);
const BIRDEYE_PER_MINT_DELAY_MS = Number(process.env.BIRDEYE_COLLECTOR_INTER_MINT_DELAY_MS || 120);
const MAX_MINTS_PER_TICK = Number(process.env.BIRDEYE_COLLECTOR_MAX_MINTS_PER_TICK || 12);

const _cache = new Map();

function isEnabled() {
  return process.env.BIRDEYE_COLLECTOR_ENABLED === '1' && Boolean(process.env.BIRDEYE_API_KEY?.trim());
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function classifyError(status, message) {
  const msg = String(message ?? '').toLowerCase();
  if (status === 429 || msg.includes('rate limit')) return 'rate_limit';
  if (/compute units|cu limit|quota|usage limit|exceeded/i.test(msg)) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  return 'network';
}

function isTierInsufficient(kind) {
  return kind === 'rate_limit' || kind === 'quota';
}

function isBatchUnavailable(status, message) {
  const msg = String(message ?? '').toLowerCase();
  return status === 403 || /not available|feature not|upgrade|business tier|multiple endpoint/i.test(msg);
}

function parseMarketData(json) {
  if (json?.success === false) return null;
  const d = json?.data;
  if (!d || typeof d !== 'object') return null;
  const priceUsd = positive(d.price);
  const marketCapUsd = positive(d.market_cap ?? d.marketCap);
  const liquidityUsd = positive(d.liquidity);
  const fdv = positive(d.fdv);
  const mcap = marketCapUsd ?? fdv;
  if (priceUsd == null && mcap == null && liquidityUsd == null) return null;
  return { priceUsd, marketCapUsd: mcap, liquidityUsd, fetchedAtMs: Date.now() };
}

function parseTradeDataVolumes(json) {
  if (json?.success === false) return { volume5mUsd: null, volume1hUsd: null };
  const d = json?.data;
  if (!d || typeof d !== 'object') return { volume5mUsd: null, volume1hUsd: null };
  return {
    volume5mUsd: positive(d.volume_5m_usd ?? d.volume_5m),
    volume1hUsd: positive(d.volume_1h_usd ?? d.volume_1h),
  };
}

const BIRDEYE_COLLECTOR_VOLUME_OVERLAY =
  process.env.BIRDEYE_COLLECTOR_VOLUME_OVERLAY !== '0';

function parseBatchMarketData(json) {
  const out = new Map();
  if (json?.success === false || !json?.data || typeof json.data !== 'object') return out;
  for (const [mint, row] of Object.entries(json.data)) {
    const parsed = parseMarketData({ success: true, data: row });
    if (parsed) out.set(mint, parsed);
  }
  return out;
}

async function birdeyeGet(path, fetchImpl) {
  const apiKey = process.env.BIRDEYE_API_KEY?.trim();
  if (!apiKey) return { ok: false, status: 0, json: null, message: 'no_key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BIRDEYE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${BIRDEYE_BASE}${path}`, {
      headers: {
        accept: 'application/json',
        'X-API-KEY': apiKey,
        'x-chain': 'solana',
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const message = String(json?.message ?? text.slice(0, 200));
    return { ok: res.ok, status: res.status, json, message };
  } catch {
    return { ok: false, status: 0, json: null, message: 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBirdeyeForMint(mint, fetchImpl) {
  const now = Date.now();
  const cached = _cache.get(mint);
  if (cached && now - cached.at < BIRDEYE_TTL_MS) return cached.val;

  const path = `/defi/v3/token/market-data?address=${encodeURIComponent(mint)}`;
  const res = await birdeyeGet(path, fetchImpl);
  let parsed = res.ok ? parseMarketData(res.json) : null;
  const kind = res.ok ? undefined : classifyError(res.status, res.message);
  const tierInsufficient = kind != null && isTierInsufficient(kind);

  let volume5mUsd = null;
  let volume1hUsd = null;
  if (BIRDEYE_COLLECTOR_VOLUME_OVERLAY && !tierInsufficient) {
    const tradePath = `/defi/v3/token/trade-data/single?address=${encodeURIComponent(mint)}&frames=5m,1h`;
    const tradeRes = await birdeyeGet(tradePath, fetchImpl);
    if (tradeRes.ok) {
      const vols = parseTradeDataVolumes(tradeRes.json);
      volume5mUsd = vols.volume5mUsd;
      volume1hUsd = vols.volume1hUsd;
    }
  }

  const val = parsed
    ? {
        ...parsed,
        volume5mUsd,
        volume1hUsd,
        tierInsufficient: tierInsufficient || undefined,
        errorKind: kind,
      }
    : tierInsufficient
      ? {
          priceUsd: null,
          marketCapUsd: null,
          liquidityUsd: null,
          volume5mUsd,
          volume1hUsd,
          fetchedAtMs: now,
          tierInsufficient: true,
          errorKind: kind,
        }
      : null;
  _cache.set(mint, { at: now, val });
  return val;
}

async function fetchBirdeyeBatch(mints, fetchImpl, log, component) {
  const quotes = new Map();
  let batchUnavailable = false;
  let tierInsufficient = false;
  let errorKind;

  if (BIRDEYE_BATCH_ENABLED && mints.length > 1) {
    for (let i = 0; i < mints.length; i += BIRDEYE_BATCH_CHUNK) {
      const chunk = mints.slice(i, i + BIRDEYE_BATCH_CHUNK);
      const list = chunk.map((m) => encodeURIComponent(m)).join(',');
      const res = await birdeyeGet(`/defi/v3/token/market-data/multiple?list_address=${list}`, fetchImpl);
      if (res.ok) {
        const parsed = parseBatchMarketData(res.json);
        for (const mint of chunk) {
          const row = parsed.get(mint);
          if (row) quotes.set(mint, row);
        }
      } else if (isBatchUnavailable(res.status, res.message)) {
        batchUnavailable = true;
        if (log) {
          log('warn', 'birdeye batch endpoint unavailable; per-mint fallback', {
            component,
            status: res.status,
            message: res.message?.slice?.(0, 120),
          });
        }
        break;
      } else {
        const kind = classifyError(res.status, res.message);
        if (isTierInsufficient(kind)) {
          tierInsufficient = true;
          errorKind = kind;
        }
      }
    }
  }

  const missing = mints.filter((m) => !quotes.has(m));
  for (let i = 0; i < missing.length; i += 1) {
    const mint = missing[i];
    const row = await fetchBirdeyeForMint(mint, fetchImpl);
    if (row) {
      quotes.set(mint, row);
      if (row.tierInsufficient) {
        tierInsufficient = true;
        errorKind = row.errorKind;
      }
    }
    if (BIRDEYE_PER_MINT_DELAY_MS > 0 && i + 1 < missing.length) {
      await new Promise((r) => setTimeout(r, BIRDEYE_PER_MINT_DELAY_MS));
    }
  }

  return { quotes, batchUnavailable, tierInsufficient, errorKind };
}

function mintsWithBaseSnapshot(rows) {
  const s = new Set();
  for (const r of rows) {
    if (r?.base_mint) s.add(r.base_mint);
  }
  return s;
}

const _tierTelegramLastMs = new Map();

function birdeyeTelegramEnabled() {
  return process.env.BIRDEYE_TELEGRAM_ENABLED === '1';
}

function tierTelegramCooldownMs() {
  return Math.max(0, Number(process.env.BIRDEYE_TELEGRAM_TIER_COOLDOWN_MS ?? 30 * 60_000));
}

function notifyCollectorBirdeyeTierInsufficient({ errorKind, component }) {
  const key = `collector:${errorKind ?? 'quota'}`;
  const now = Date.now();
  const prev = _tierTelegramLastMs.get(key) ?? 0;
  const cooldown = tierTelegramCooldownMs();
  if (cooldown > 0 && now - prev < cooldown) return;
  _tierTelegramLastMs.set(key, now);

  const kindRu =
    errorKind === 'rate_limit'
      ? 'rate limit (429)'
      : errorKind === 'quota'
        ? 'CU / quota'
        : 'лимит API';
  const text =
    `<b>Birdeye Lite — лимит тарифа</b>\n` +
    `<i>Birdeye Lite tier limit — upgrade recommended</i>\n\n` +
    `Причина: <b>${kindRu}</b>\n` +
    `Контекст: коллектор snapshots (${component})\n` +
    `→ Нужен апгрейд Birdeye (Business+) или снизить частоту запросов.`;

  if (birdeyeTelegramEnabled()) {
    void sendTagged('ALERT', 'birdeye_tier_insufficient', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken:
        process.env.BIRDEYE_TELEGRAM_BOT_TOKEN?.trim() ||
        process.env.TELEGRAM_BOT_TOKEN?.trim() ||
        undefined,
      telegramChatId:
        process.env.BIRDEYE_TELEGRAM_CHAT_ID?.trim() ||
        process.env.TELEGRAM_CHAT_ID?.trim() ||
        '-1003878024799',
    }).catch(() => {
      /* best-effort */
    });
  }
}

function overlayRowFromQuote(row, quote) {
  if (!quote || quote.tierInsufficient) return false;
  let changed = false;
  if (quote.priceUsd != null) {
    row.price_usd = quote.priceUsd;
    changed = true;
  }
  if (quote.marketCapUsd != null) {
    row.market_cap_usd = quote.marketCapUsd;
    row.fdv_usd = quote.marketCapUsd;
    changed = true;
  }
  if (quote.liquidityUsd != null) {
    row.liquidity_usd = quote.liquidityUsd;
    changed = true;
  }
  if (quote.volume5mUsd != null) {
    row.volume_5m = quote.volume5mUsd;
    changed = true;
  }
  if (quote.volume1hUsd != null) {
    row.volume_1h = quote.volume1hUsd;
    changed = true;
  }
  if (changed) row._birdeyeEnriched = true;
  return changed;
}

function rowFromBirdeye(mint, quote, bucketTs, sourceTag) {
  if (!quote || (quote.priceUsd == null && quote.marketCapUsd == null && quote.liquidityUsd == null)) {
    return null;
  }
  return {
    ts: bucketTs,
    source: sourceTag,
    pair_address: `birdeye:${mint}`,
    base_mint: mint,
    quote_mint: SOL_MINT,
    price_usd: quote.priceUsd,
    liquidity_usd: quote.liquidityUsd,
    volume_5m: null,
    volume_1h: null,
    buys_5m: null,
    sells_5m: null,
    fdv_usd: quote.marketCapUsd,
    market_cap_usd: quote.marketCapUsd,
    launch_ts: null,
    _birdeyeEnriched: true,
  };
}


async function fetchDexFallbackForMint(mint, bucketTs, fetchJsonWithRetry, normalizeDexPair, extra, log, component) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  try {
    await acquireDexScreenerSlot();
    const json = await fetchJsonWithRetry(url, {}, 'dexscreener-birdeye-fallback');
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    for (const p of pairs) {
      const row = normalizeDexPair(p, bucketTs);
      if (row) extra.push(row);
    }
    return pairs.length > 0;
  } catch (e) {
    if (log) {
      log('warn', 'dexscreener fallback after birdeye miss failed', {
        component,
        mint: mint.slice(0, 8),
        error: String(e),
      });
    }
    return false;
  }
}

/**
 * @param {object} opts
 * @param {object[]} opts.rows
 * @param {Date} opts.bucketTs
 * @param {string} opts.sourceTag — e.g. 'pumpswap'
 * @param {function} opts.fetchImpl — global fetch
 * @param {function} opts.fetchJsonWithRetry
 * @param {function} opts.normalizeDexPair
 * @param {function} opts.dedupByPairAddress
 * @param {function} [opts.log]
 * @param {string} [opts.component]
 */
export async function enrichCollectorRowsWithBirdeye({
  rows,
  bucketTs,
  sourceTag,
  fetchImpl,
  fetchJsonWithRetry,
  normalizeDexPair,
  dedupByPairAddress,
  log,
  component = 'dex-collector',
}) {
  if (!isEnabled()) return { rows, stats: null };

  const paper = loadPaper2OpenMintsSync();
  const live = loadLiveOscarOpenMintsSync();
  const whitelist = loadLiveOscarWhitelistMintsSync();
  const pin = loadDiscoveryCollectorPinMintsSync();
  const openMintSet = new Set([...paper, ...live, ...whitelist, ...pin]);
  if (openMintSet.size === 0) return { rows, stats: null };

  const covered = mintsWithBaseSnapshot(rows);
  const missingAll = [...openMintSet].filter((m) => !covered.has(m));
  const overlayCandidates = rows.filter((r) => r?.base_mint && openMintSet.has(r.base_mint));
  const overlayMints = overlayCandidates.map((r) => r.base_mint);
  const fetchMints = [...new Set([...missingAll, ...overlayMints])].slice(0, MAX_MINTS_PER_TICK);
  const deferred = Math.max(0, missingAll.length + overlayMints.length - fetchMints.length);

  if (fetchMints.length === 0) return { rows, stats: { skipped: true } };

  const missing = missingAll.filter((m) => fetchMints.includes(m));

  const { quotes, batchUnavailable, tierInsufficient, errorKind } = await fetchBirdeyeBatch(
    fetchMints,
    fetchImpl,
    log,
    component,
  );

  if (tierInsufficient) {
    if (log) {
      log('warn', 'birdeye_tier_insufficient', {
        component,
        kind: 'birdeye_tier_insufficient',
        errorKind,
        batchUnavailable,
      });
    }
    notifyCollectorBirdeyeTierInsufficient({ errorKind, component });
  }

  let overlayUpdated = 0;
  for (const row of overlayCandidates) {
    const q = quotes.get(row.base_mint);
    if (overlayRowFromQuote(row, q)) overlayUpdated += 1;
  }

  const extra = [];
  let birdeyeRows = 0;
  let dexFallback = 0;
  for (const mint of missing) {
    const q = quotes.get(mint);
    const row = rowFromBirdeye(mint, q, bucketTs, sourceTag);
    if (row) {
      extra.push(row);
      birdeyeRows += 1;
      continue;
    }
    const ok = await fetchDexFallbackForMint(
      mint,
      bucketTs,
      fetchJsonWithRetry,
      normalizeDexPair,
      extra,
      log,
      component,
    );
    if (ok) dexFallback += 1;
  }

  const changed = overlayUpdated > 0 || extra.length > 0;
  if (!changed) {
    if (log) {
      log('info', 'birdeye collector enrich: no rows produced', {
        component,
        missing: missing.length,
        deferred,
        overlayUpdated,
        tierInsufficient,
        batchUnavailable,
      });
    }
    return {
      rows,
      stats: {
        missing: missing.length,
        deferred,
        overlayUpdated,
        tierInsufficient,
        batchUnavailable,
        errorKind,
        changed: false,
      },
    };
  }

  const merged = extra.length > 0 ? dedupByPairAddress([...rows, ...extra]) : rows;
  if (log) {
    log('info', 'birdeye collector enrich merged', {
      component,
      missing: missing.length,
      deferred,
      birdeyeRows,
      dexFallback,
      overlayUpdated,
      extraTotal: extra.length,
      batchUnavailable,
      tierInsufficient,
    });
  }
  return {
    rows: merged,
    stats: {
      missing: missing.length,
      deferred,
      birdeyeRows,
      dexFallback,
      overlayUpdated,
      tierInsufficient,
      batchUnavailable,
      errorKind,
      changed: true,
    },
  };
}

/** Test-only cache reset. */
export function __resetBirdeyeCollectorCacheForTests() {
  _cache.clear();
}
