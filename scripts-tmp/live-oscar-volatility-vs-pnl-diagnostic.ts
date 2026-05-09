/**
 * Диагностика: предаходная волатильность vs netPnlUsd по закрытым live-сделкам.
 *
 * Окно до входа: [entryTs - preMinutes, entryTs) — минутные свечи USD, не включаем минуту входа.
 * Метрики:
 * - vol_logret_1m: σ лог-доходностей по close подряд
 * - range_pct: (max(high)-min(low))/median(close)
 *
 * Источник цен:
 * - gecko: GeckoTerminal pool OHLCV (без API-ключа; нужен подбор пула по mint)
 * - birdeye: Birdeye v3 OHLCV по mint (нужен BIRDEYE_API_KEY)
 * - auto: birdeye при ключе; при пустом ответе / лимите CU → gecko
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *     npx tsx scripts-tmp/live-oscar-volatility-vs-pnl-diagnostic.ts data/live/pt1-oscar-live.jsonl \
 *       --price-source gecko --sleep-ms 400
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const API_KEY = process.env.BIRDEYE_API_KEY?.trim() ?? '';

type PriceSource = 'auto' | 'birdeye' | 'gecko';

interface CloseRow {
  mint: string;
  dex: string;
  entryTs: number;
  exitTs: number;
  netPnlUsd: number;
  exitReason: string;
  strategyId: string;
}

interface Candle {
  unix_time: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

interface GeckoPoolCand {
  poolAddress: string;
  dexId: string;
  reserveUsd: number;
}

interface DexPairRow {
  pairAddress: string;
  dexId: string;
  liquidityUsd: number;
  baseMint: string;
  quoteMint: string;
}

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || process.argv[i + 1] == null) return def;
  return String(process.argv[i + 1]);
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || process.argv[i + 1] == null) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadCloses(
  jsonlPath: string,
  strategyIdFilter: string,
): Promise<{ rows: CloseRow[]; skippedAbsurd: number }> {
  const out: CloseRow[] = [];
  let skippedAbsurd = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.kind !== 'live_position_close') continue;
    const sid = String(o.strategyId ?? '').trim();
    if (strategyIdFilter && sid !== strategyIdFilter) continue;

    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct) continue;

    const mint = String(ct.mint ?? '');
    let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
    if (!dex) dex = 'pumpswap';
    const entryTs = Number(ct.entryTs ?? 0);
    const exitTs = Number(ct.exitTs ?? 0);
    const net = ct.netPnlUsd;
    const totalInvestedUsd = Number(ct.totalInvestedUsd ?? 0);
    const exitReason = String(ct.exitReason ?? '');

    if (!mint || !(entryTs > 0) || !(exitTs > 0) || typeof net !== 'number' || !(totalInvestedUsd > 0))
      continue;

    const absurd =
      !Number.isFinite(net) ||
      Math.abs(net) > Math.max(500_000, totalInvestedUsd * 50) ||
      exitReason === 'PERIODIC_HEAL';
    if (absurd) {
      skippedAbsurd++;
      continue;
    }

    out.push({ mint, dex, entryTs, exitTs, netPnlUsd: net, exitReason, strategyId: sid });
  }

  return { rows: out, skippedAbsurd };
}

async function geckoHttpJson(url: string, sleepMs: number): Promise<{ ok: boolean; json: Record<string, unknown> }> {
  let backoff = Math.max(280, Math.min(sleepMs, 1200));
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(attempt === 0 ? Math.min(320, backoff) : backoff);
    const ac = AbortSignal.timeout(28_000);
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ac });
    const text = await r.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      backoff = Math.min(45_000, backoff * 2 + 1500);
      continue;
    }
    const st = json.status as Record<string, unknown> | undefined;
    const code = Number(st?.error_code ?? 0);
    if (r.status === 429 || code === 429) {
      backoff = Math.min(90_000, Math.max(5000, backoff * 3));
      continue;
    }
    return { ok: r.ok, json };
  }
  return { ok: false, json: {} };
}

function mintFromGeckoTokenRef(ref: string): string {
  const s = ref.trim().toLowerCase();
  return s.startsWith('solana_') ? s.slice('solana_'.length) : s;
}

function journalDexMatchesPool(journalDex: string, poolDexId: string): boolean {
  const j = journalDex.toLowerCase().trim();
  const p = poolDexId.toLowerCase().trim();
  if (!j || !p) return false;
  if (p === j || p.startsWith(`${j}-`) || p.startsWith(`${j}_`)) return true;
  if (j === 'raydium' && p.includes('raydium')) return true;
  if (j === 'meteora' && p.includes('meteora')) return true;
  return false;
}

async function fetchGeckoPoolsForMint(mint: string, sleepMs: number): Promise<GeckoPoolCand[]> {
  const mintLower = mint.toLowerCase();
  const out: GeckoPoolCand[] = [];
  for (let page = 1; page <= 3; page++) {
    const u = new URL(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${encodeURIComponent(mint)}/pools`);
    u.searchParams.set('page', String(page));
    const { ok, json } = await geckoHttpJson(u.toString(), sleepMs);
    if (!ok) break;
    const data = json.data as unknown;
    if (!Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      const rec = row as Record<string, unknown>;
      const attrs = rec.attributes as Record<string, unknown> | undefined;
      const rel = rec.relationships as Record<string, unknown> | undefined;
      const baseTok = rel?.base_token as Record<string, unknown> | undefined;
      const baseData = baseTok?.data as Record<string, unknown> | undefined;
      const baseId = String(baseData?.id ?? '');
      const dexWrap = rel?.dex as Record<string, unknown> | undefined;
      const dexData = dexWrap?.data as Record<string, unknown> | undefined;
      const dexId = String(dexData?.id ?? '').toLowerCase();
      const addr = String(attrs?.address ?? '').trim();
      const reserveUsd = Number(String(attrs?.reserve_in_usd ?? '0'));
      if (!addr || mintFromGeckoTokenRef(baseId) !== mintLower) continue;
      out.push({
        poolAddress: addr,
        dexId,
        reserveUsd: Number.isFinite(reserveUsd) ? reserveUsd : 0,
      });
    }
  }
  return out;
}

async function fetchDexscreenerPairs(mint: string): Promise<DexPairRow[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await r.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`dexscreener non-json ${r.status}`);
  }
  if (!r.ok) throw new Error(`dexscreener ${r.status}`);
  const pairs = json.pairs as unknown;
  if (!Array.isArray(pairs)) return [];
  const mintLower = mint.toLowerCase();
  const out: DexPairRow[] = [];
  for (const p of pairs) {
    const row = p as Record<string, unknown>;
    const pairAddress = String(row.pairAddress ?? '').trim();
    const dexId = String(row.dexId ?? '').toLowerCase().trim();
    const liq = Number((row.liquidity as Record<string, unknown> | undefined)?.usd ?? 0);
    const baseMint = String((row.baseToken as Record<string, unknown> | undefined)?.address ?? '').toLowerCase();
    const quoteMint = String((row.quoteToken as Record<string, unknown> | undefined)?.address ?? '').toLowerCase();
    if (!pairAddress || (!baseMint && !quoteMint)) continue;
    if (baseMint !== mintLower && quoteMint !== mintLower) continue;
    out.push({ pairAddress, dexId, liquidityUsd: Number.isFinite(liq) ? liq : 0, baseMint, quoteMint });
  }
  return out;
}

async function geckoOhlcvMetaBaseAddress(poolAddress: string, sleepMs: number): Promise<string | null> {
  const u = new URL(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(poolAddress)}/ohlcv/minute`,
  );
  u.searchParams.set('aggregate', '1');
  u.searchParams.set('limit', '1');
  u.searchParams.set('currency', 'usd');
  const { ok, json } = await geckoHttpJson(u.toString(), sleepMs);
  if (!ok) return null;
  const meta = json.meta as Record<string, unknown> | undefined;
  const base = meta?.base as Record<string, unknown> | undefined;
  const addr = String(base?.address ?? '').trim();
  return addr || null;
}

async function resolvePoolForMintOnGecko(
  mint: string,
  journalDex: string,
  sleepMs: number,
  poolsCache: Map<string, GeckoPoolCand[]>,
): Promise<{ poolAddress: string } | null> {
  const mintLower = mint.toLowerCase();

  let geckoPools = poolsCache.get(mintLower);
  if (!geckoPools) {
    geckoPools = await fetchGeckoPoolsForMint(mint, sleepMs);
    poolsCache.set(mintLower, geckoPools);
  }
  const dexPref = geckoPools.filter((p) => journalDexMatchesPool(journalDex, p.dexId));
  let ordered = dexPref.length ? dexPref : geckoPools;
  ordered = [...ordered].sort((a, b) => b.reserveUsd - a.reserveUsd);

  for (const c of ordered.slice(0, 10)) {
    const metaBase = await geckoOhlcvMetaBaseAddress(c.poolAddress, sleepMs);
    if (metaBase && metaBase.toLowerCase() === mintLower) {
      return { poolAddress: c.poolAddress };
    }
  }

  let rows: DexPairRow[];
  try {
    rows = await fetchDexscreenerPairs(mint);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const dexNorm = journalDex.toLowerCase().trim();
  const preferred = rows.filter((x) => x.dexId === dexNorm || journalDexMatchesPool(journalDex, x.dexId));
  const cand = preferred.length ? preferred : rows;
  cand.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  for (const c of cand.slice(0, 10)) {
    if (c.baseMint !== mintLower) continue;
    const metaBase = await geckoOhlcvMetaBaseAddress(c.pairAddress, sleepMs);
    if (metaBase && metaBase.toLowerCase() === mintLower) {
      return { poolAddress: c.pairAddress };
    }
  }
  return null;
}

async function fetchGeckoOhlcvUsdRange(params: {
  poolAddress: string;
  timeFromSec: number;
  timeToSec: number;
  sleepMs: number;
  maxPages: number;
}): Promise<Candle[]> {
  const seen = new Set<number>();
  const candles: Candle[] = [];
  let before = params.timeToSec + 120;
  const tMin = params.timeFromSec - 60;

  for (let page = 0; page < params.maxPages; page++) {
    const u = new URL(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(params.poolAddress)}/ohlcv/minute`,
    );
    u.searchParams.set('aggregate', '1');
    u.searchParams.set('limit', '1000');
    u.searchParams.set('currency', 'usd');
    u.searchParams.set('before_timestamp', String(before));

    const { ok, json } = await geckoHttpJson(u.toString(), params.sleepMs);
    if (!ok) break;
    const data = json.data as Record<string, unknown> | undefined;
    const attrs = data?.attributes as Record<string, unknown> | undefined;
    const list = attrs?.ohlcv_list as unknown;
    if (!Array.isArray(list) || list.length === 0) break;

    let oldestTs = Number.POSITIVE_INFINITY;
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const unix_time = Number(row[0]);
      const o = Number(row[1]);
      const hi = Number(row[2]);
      const lo = Number(row[3]);
      const cl = row.length > 4 ? Number(row[4]) : NaN;
      oldestTs = Math.min(oldestTs, unix_time);
      if (!Number.isFinite(unix_time) || !Number.isFinite(lo) || !Number.isFinite(hi)) continue;
      if (unix_time > params.timeToSec + 60 || unix_time < tMin) continue;
      const c =
        Number.isFinite(cl) && cl > 0 ? cl : Number.isFinite(o) && o > 0 ? o : (hi + lo) / 2;
      if (!(c > 0)) continue;
      const openPx = Number.isFinite(o) && o > 0 ? o : c;
      if (!seen.has(unix_time)) {
        seen.add(unix_time);
        candles.push({ unix_time, o: openPx, h: hi, l: lo, c });
      }
    }

    if (!Number.isFinite(oldestTs) || oldestTs <= tMin) break;
    before = oldestTs - 1;
    await sleep(params.sleepMs);
  }

  return candles.sort((a, b) => a.unix_time - b.unix_time);
}

async function fetchOhlcvBirdeye(params: {
  mint: string;
  timeFromSec: number;
  timeToSec: number;
  sleepMs: number;
}): Promise<{ candles: Candle[]; err?: string }> {
  if (!API_KEY) return { candles: [], err: 'no_birdeye_key' };
  const u = new URL('https://public-api.birdeye.so/defi/v3/ohlcv');
  u.searchParams.set('address', params.mint);
  u.searchParams.set('type', '1m');
  u.searchParams.set('currency', 'usd');
  u.searchParams.set('time_from', String(params.timeFromSec));
  u.searchParams.set('time_to', String(params.timeToSec));

  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(u.toString(), {
      headers: {
        'X-API-KEY': API_KEY,
        'x-chain': 'solana',
        Accept: 'application/json',
      },
    });
    const text = await r.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      await sleep(params.sleepMs * (attempt + 2));
      continue;
    }
    const msg = String(json?.message ?? '');
    if (!json?.success) {
      if (/compute units|cu limit|usage limit/i.test(msg)) {
        return { candles: [], err: msg };
      }
      return { candles: [], err: msg || 'birdeye success=false' };
    }
    if (r.status === 429 || r.status === 503) {
      await sleep(params.sleepMs * (attempt + 3) * 5);
      continue;
    }
    if (!r.ok) {
      await sleep(params.sleepMs * (attempt + 2));
      continue;
    }
    const items = json?.data as { items?: unknown } | undefined;
    const arr = items?.items;
    if (!Array.isArray(arr)) return { candles: [] };
    const candles: Candle[] = [];
    for (const x of arr) {
      const it = x as Record<string, unknown>;
      const unix_time = Number(it.unix_time);
      const o = Number(it.o ?? it.open);
      const h = Number(it.h ?? it.high);
      const l = Number(it.l ?? it.low);
      const c = Number(it.c ?? it.close ?? it.o);
      if (Number.isFinite(unix_time) && Number.isFinite(h) && Number.isFinite(l) && Number.isFinite(c) && c > 0) {
        candles.push({
          unix_time,
          o: Number.isFinite(o) && o > 0 ? o : c,
          h,
          l,
          c,
        });
      }
    }
    return { candles: candles.sort((a, b) => a.unix_time - b.unix_time) };
  }
  return { candles: [], err: 'birdeye_retries' };
}

async function fetchCandlesForTrade(args: {
  row: CloseRow;
  timeFromSec: number;
  timeToSec: number;
  sleepMs: number;
  source: PriceSource;
  poolsCache: Map<string, GeckoPoolCand[]>;
}): Promise<{ candles: Candle[]; used: 'birdeye' | 'gecko'; err?: string }> {
  const { row, timeFromSec, timeToSec, sleepMs, source, poolsCache } = args;

  if (source === 'gecko') {
    const pool = await resolvePoolForMintOnGecko(row.mint, row.dex, sleepMs, poolsCache);
    if (!pool) return { candles: [], used: 'gecko', err: 'gecko_pool_unresolved' };
    const candles = await fetchGeckoOhlcvUsdRange({
      poolAddress: pool.poolAddress,
      timeFromSec,
      timeToSec,
      sleepMs,
      maxPages: 8,
    });
    return { candles, used: 'gecko' };
  }

  if (source === 'birdeye') {
    const { candles, err } = await fetchOhlcvBirdeye({
      mint: row.mint,
      timeFromSec,
      timeToSec,
      sleepMs,
    });
    if (err && !candles.length) return { candles: [], used: 'birdeye', err };
    return { candles, used: 'birdeye' };
  }

  /** auto */
  if (API_KEY) {
    const b = await fetchOhlcvBirdeye({
      mint: row.mint,
      timeFromSec,
      timeToSec,
      sleepMs,
    });
    if (b.candles.length > 0) return { candles: b.candles, used: 'birdeye' };
    if (b.err && !/compute units|cu limit|usage limit/i.test(String(b.err))) {
      /* fall through to gecko */
    }
  }
  const pool = await resolvePoolForMintOnGecko(row.mint, row.dex, sleepMs, poolsCache);
  if (!pool) return { candles: [], used: 'gecko', err: 'gecko_pool_unresolved_after_birdeye' };
  const candles = await fetchGeckoOhlcvUsdRange({
    poolAddress: pool.poolAddress,
    timeFromSec,
    timeToSec,
    sleepMs,
    maxPages: 8,
  });
  return { candles, used: 'gecko' };
}

function slicePreEntry(candles: Candle[], entryMs: number, preMin: number): Candle[] {
  const entrySec = Math.floor(entryMs / 1000);
  const fromSec = entrySec - preMin * 60;
  return candles.filter((x) => x.unix_time >= fromSec && x.unix_time < entrySec);
}

function median(xs: number[]): number | null {
  const a = xs.filter((x) => Number.isFinite(x) && x > 0).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function volLogReturns(closes: number[]): number | null {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (!(a > 0) || !(b > 0)) continue;
    rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  let ss = 0;
  for (const r of rets) ss += (r - mean) ** 2;
  const variance = ss / (rets.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function rangePct(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  let hi = -Infinity;
  let lo = Infinity;
  const closes: number[] = [];
  for (const c of candles) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    closes.push(c.c);
  }
  const med = median(closes);
  if (med == null || !(hi > lo) || !(med > 0)) return null;
  return (hi - lo) / med;
}

function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v || a.i - b.i);
  const r = new Array(xs.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[k]!.v) j++;
    const avgRank = ((k + 1 + (j + 1)) / 2) as number;
    for (let t = k; t <= j; t++) r[idx[t]!.i] = avgRank;
    k = j + 1;
  }
  return r;
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  for (let i = 0; i < n; i++) {
    const vx = rx[i]! - mx;
    const vy = ry[i]! - my;
    num += vx * vy;
    dx += vx * vx;
    dy += vy * vy;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

function quartileMeans(values: number[], pnls: number[]): void {
  const pairs = values.map((v, i) => ({ v, p: pnls[i]! })).filter((x) => Number.isFinite(x.v));
  pairs.sort((a, b) => a.v - b.v);
  const n = pairs.length;
  if (n < 8) {
    console.log('too few points for quartiles:', n);
    return;
  }
  const buckets = [
    { label: 'Q1_low_vol', rows: [] as typeof pairs },
    { label: 'Q2', rows: [] as typeof pairs },
    { label: 'Q3', rows: [] as typeof pairs },
    { label: 'Q4_high_vol', rows: [] as typeof pairs },
  ];
  for (let i = 0; i < n; i++) {
    const b = Math.min(3, Math.floor((4 * i) / n));
    buckets[b]!.rows.push(pairs[i]!);
  }
  console.log('\n=== Quartiles by vol_logret (pre-entry) ===');
  for (const b of buckets) {
    const ps = b.rows.map((r) => r.p);
    const sum = ps.reduce((a, x) => a + x, 0);
    const sorted = [...ps].sort((x, y) => x - y);
    const med =
      sorted.length % 2
        ? sorted[(sorted.length - 1) >> 1]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    console.log(
      `${b.label.padEnd(14)} n=${String(b.rows.length).padStart(4)}  sumPnl=${sum.toFixed(2).padStart(10)}  medianPnl=${med.toFixed(4).padStart(10)}`,
    );
  }
}

function parsePriceSource(s: string): PriceSource {
  if (s === 'birdeye' || s === 'gecko' || s === 'auto') return s;
  return 'auto';
}

async function main(): Promise<void> {
  const jsonlArg = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
  const jsonlPath = path.resolve(jsonlArg ?? 'data/live/pt1-oscar-live.jsonl');
  const strategyId = argStr('--strategy-id', 'live-oscar');
  const preMinutes = argNum('--pre-minutes', 120);
  const sleepMs = argNum('--sleep-ms', 400);
  const limit = argNum('--limit', 0);
  const priceSource = parsePriceSource(argStr('--price-source', 'gecko'));

  if (!fs.existsSync(jsonlPath)) {
    console.error('journal missing:', jsonlPath);
    process.exit(1);
  }
  if (priceSource === 'birdeye' && !API_KEY) {
    console.error('BIRDEYE_API_KEY required for --price-source birdeye');
    process.exit(1);
  }

  const { rows: allRows, skippedAbsurd } = await loadCloses(jsonlPath, strategyId);
  const rows = limit > 0 ? allRows.slice(-limit) : allRows;

  console.log(
    JSON.stringify(
      {
        journal: jsonlPath,
        strategyId,
        priceSource,
        closesLoaded: allRows.length,
        closesUsed: rows.length,
        skippedAbsurd,
        preEntryMinutes: preMinutes,
      },
      null,
      2,
    ),
  );

  type RowDiag = CloseRow & {
    volLogret: number | null;
    rangePct: number | null;
    bars: number;
    priceUsed?: string;
    err?: string;
  };

  const diags: RowDiag[] = [];
  let fetchOk = 0;
  let fetchFail = 0;
  const poolsCache = new Map<string, GeckoPoolCand[]>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const entrySec = Math.floor(r.entryTs / 1000);
    const fromSec = entrySec - preMinutes * 60 - 120;
    const toSec = entrySec + 60;

    try {
      const { candles: raw, used, err } = await fetchCandlesForTrade({
        row: r,
        timeFromSec: fromSec,
        timeToSec: toSec,
        sleepMs,
        source: priceSource,
        poolsCache,
      });
      const pre = slicePreEntry(raw, r.entryTs, preMinutes);
      const closes = pre.map((c) => c.c);
      const vlr = volLogReturns(closes);
      const rp = rangePct(pre);
      if (vlr == null && pre.length < 3) {
        fetchFail++;
        diags.push({
          ...r,
          volLogret: null,
          rangePct: rp,
          bars: pre.length,
          priceUsed: used,
          err: err ?? `insufficient_bars_${pre.length}`,
        });
      } else {
        fetchOk++;
        diags.push({
          ...r,
          volLogret: vlr,
          rangePct: rp,
          bars: pre.length,
          priceUsed: used,
          ...(err ? { err } : {}),
        });
      }
    } catch (e) {
      fetchFail++;
      diags.push({
        ...r,
        volLogret: null,
        rangePct: null,
        bars: 0,
        err: String((e as Error).message ?? e),
      });
    }

    if (i + 1 < rows.length) await sleep(sleepMs);
  }

  const withVol = diags.filter((d) => d.volLogret != null && Number.isFinite(d.volLogret));
  const vols = withVol.map((d) => d.volLogret!);
  const pnls = withVol.map((d) => d.netPnlUsd);
  const rho = spearman(vols, pnls);
  const withRange = diags.filter((d) => d.rangePct != null && Number.isFinite(d.rangePct));
  const rhoRange =
    withRange.length >= 3
      ? spearman(
          withRange.map((d) => d.rangePct!),
          withRange.map((d) => d.netPnlUsd),
        )
      : null;

  const sumAllPnls = rows.reduce((s, d) => s + d.netPnlUsd, 0);

  console.log('\n=== Aggregate ===');
  console.log(`fetchOk=${fetchOk} fetchFail=${fetchFail} tradesWithVol=${withVol.length}`);
  console.log(`Spearman(vol_logret_pre, netPnlUsd)=${rho == null ? 'n/a' : rho.toFixed(4)}`);
  console.log(`Spearman(range_pct_pre, netPnlUsd)=${rhoRange == null ? 'n/a' : rhoRange.toFixed(4)}`);
  console.log(`sum netPnlUsd (cohort used)=${sumAllPnls.toFixed(4)}`);

  if (withVol.length >= 8) quartileMeans(vols, pnls);

  const hi = [...withVol].sort((a, b) => b.volLogret! - a.volLogret!).slice(0, 5);
  const lo = [...withVol].sort((a, b) => a.volLogret! - b.volLogret!).slice(0, 5);
  console.log('\n=== Top 5 highest pre-entry vol (logret 1m) ===');
  for (const d of hi) {
    console.log(
      `${d.mint.slice(0, 8)}… vol=${d.volLogret!.toFixed(6)} range%=${d.rangePct?.toFixed(4) ?? 'n/a'} pnl=${d.netPnlUsd.toFixed(2)} bars=${d.bars} src=${d.priceUsed ?? '?'}`,
    );
  }
  console.log('\n=== Top 5 lowest pre-entry vol ===');
  for (const d of lo) {
    console.log(
      `${d.mint.slice(0, 8)}… vol=${d.volLogret!.toFixed(6)} range%=${d.rangePct?.toFixed(4) ?? 'n/a'} pnl=${d.netPnlUsd.toFixed(2)} bars=${d.bars} src=${d.priceUsed ?? '?'}`,
    );
  }

  const failed = diags.filter((d) => d.volLogret == null && d.err);
  if (failed.length) {
    console.log(`\n(note: ${failed.length} rows missing vol — see err counts)`);
    const by = new Map<string, number>();
    for (const d of failed) {
      const k = (d.err ?? 'unknown').slice(0, 80);
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${v}x ${k}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
