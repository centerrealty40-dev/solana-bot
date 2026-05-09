/**
 * Диагностика: предаходная волатильность (Birdeye 1m OHLCV, USD) vs netPnlUsd по закрытым live-сделкам.
 *
 * Окно до входа: [entryTs - preMinutes, entryTs) в секундах UNIX (не включаем минуту входа).
 * Метрики на окне:
 * - vol_logret_1m: выборочное σ лог-доходностей по ценам закрытия подряд (нужно ≥3 свечей с валидным c).
 * - range_pct: (max(high) - min(low)) / median(close) на окне.
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *     npx tsx scripts-tmp/live-oscar-volatility-vs-pnl-diagnostic.ts data/live/pt1-oscar-live.jsonl
 *
 * Флаги: --strategy-id live-oscar --pre-minutes 120 --sleep-ms 320 --limit N
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const API_KEY = process.env.BIRDEYE_API_KEY?.trim() ?? '';

interface CloseRow {
  mint: string;
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

    out.push({ mint, entryTs, exitTs, netPnlUsd: net, exitReason, strategyId: sid });
  }

  return { rows: out, skippedAbsurd };
}

async function fetchOhlcv1m(params: {
  mint: string;
  timeFromSec: number;
  timeToSec: number;
  sleepMs: number;
}): Promise<Candle[]> {
  if (!API_KEY) throw new Error('BIRDEYE_API_KEY missing');
  const u = new URL('https://public-api.birdeye.so/defi/v3/ohlcv');
  u.searchParams.set('address', params.mint);
  u.searchParams.set('type', '1m');
  u.searchParams.set('currency', 'usd');
  u.searchParams.set('time_from', String(params.timeFromSec));
  u.searchParams.set('time_to', String(params.timeToSec));

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < 6; attempt++) {
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
      lastErr = new Error(`non-json ${r.status}`);
      await sleep(params.sleepMs * (attempt + 2));
      continue;
    }
    if (r.status === 429 || r.status === 503) {
      await sleep(params.sleepMs * (attempt + 3) * 5);
      continue;
    }
    if (!r.ok) {
      lastErr = new Error(String(json?.message ?? `${r.status}`));
      if (r.status >= 500) {
        await sleep(params.sleepMs * (attempt + 2));
        continue;
      }
      throw lastErr;
    }
    if (!json?.success) {
      throw new Error(String(json?.message ?? 'birdeye success=false'));
    }
    const items = json?.data as { items?: unknown } | undefined;
    const arr = items?.items;
    if (!Array.isArray(arr)) return [];
    const candles: Candle[] = [];
    for (const x of arr) {
      const it = x as Record<string, unknown>;
      const unix_time = Number(it.unix_time);
      const o = Number(it.o ?? it.open);
      const h = Number(it.h ?? it.high);
      const l = Number(it.l ?? it.low);
      const c = Number(it.c ?? it.close ?? it.o);
      if (
        Number.isFinite(unix_time) &&
        Number.isFinite(h) &&
        Number.isFinite(l) &&
        Number.isFinite(c) &&
        c > 0
      ) {
        candles.push({
          unix_time,
          o: Number.isFinite(o) && o > 0 ? o : c,
          h,
          l,
          c,
        });
      }
    }
    return candles.sort((a, b) => a.unix_time - b.unix_time);
  }
  throw lastErr ?? new Error('fetchOhlcv retries exhausted');
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
    const med = sorted.length % 2
      ? sorted[(sorted.length - 1) >> 1]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
    console.log(
      `${b.label.padEnd(14)} n=${String(b.rows.length).padStart(4)}  sumPnl=${sum.toFixed(2).padStart(10)}  medianPnl=${med.toFixed(4).padStart(10)}`,
    );
  }
}

async function main(): Promise<void> {
  const jsonlArg = process.argv[2]?.startsWith('--') ? undefined : process.argv[2];
  const jsonlPath = path.resolve(jsonlArg ?? 'data/live/pt1-oscar-live.jsonl');
  const strategyId = argStr('--strategy-id', 'live-oscar');
  const preMinutes = argNum('--pre-minutes', 120);
  const sleepMs = argNum('--sleep-ms', 320);
  const limit = argNum('--limit', 0);

  if (!fs.existsSync(jsonlPath)) {
    console.error('journal missing:', jsonlPath);
    process.exit(1);
  }
  if (!API_KEY) {
    console.error('BIRDEYE_API_KEY required in environment (.env)');
    process.exit(1);
  }

  const { rows: allRows, skippedAbsurd } = await loadCloses(jsonlPath, strategyId);
  const rows = limit > 0 ? allRows.slice(-limit) : allRows;

  console.log(
    JSON.stringify(
      {
        journal: jsonlPath,
        strategyId,
        closesLoaded: allRows.length,
        closesUsed: rows.length,
        skippedAbsurd,
        preEntryMinutes: preMinutes,
        birdeyeInterval: '1m',
      },
      null,
      2,
    ),
  );

  type RowDiag = CloseRow & {
    volLogret: number | null;
    rangePct: number | null;
    bars: number;
    err?: string;
  };

  const diags: RowDiag[] = [];
  let fetchOk = 0;
  let fetchFail = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const entrySec = Math.floor(r.entryTs / 1000);
    const fromSec = entrySec - preMinutes * 60 - 120;
    const toSec = entrySec + 60;

    try {
      const raw = await fetchOhlcv1m({
        mint: r.mint,
        timeFromSec: fromSec,
        timeToSec: toSec,
        sleepMs,
      });
      const pre = slicePreEntry(raw, r.entryTs, preMinutes);
      const closes = pre.map((c) => c.c);
      const vlr = volLogReturns(closes);
      const rp = rangePct(pre);
      diags.push({
        ...r,
        volLogret: vlr,
        rangePct: rp,
        bars: pre.length,
      });
      fetchOk++;
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
  const rhoRange =
    diags.filter((d) => d.rangePct != null).length >= 3
      ? spearman(
          diags.filter((d) => d.rangePct != null).map((d) => d.rangePct!),
          diags.filter((d) => d.rangePct != null).map((d) => d.netPnlUsd),
        )
      : null;

  const sumAllPnls = diags.reduce((s, d) => s + d.netPnlUsd, 0);

  console.log('\n=== Aggregate ===');
  console.log(`fetchOk=${fetchOk} fetchFail=${fetchFail} tradesWithVol=${withVol.length}`);
  console.log(`Spearman(vol_logret_pre, netPnlUsd)=${rho == null ? 'n/a' : rho.toFixed(4)}`);
  console.log(`Spearman(range_pct_pre, netPnlUsd)=${rhoRange == null ? 'n/a' : rhoRange.toFixed(4)}`);
  console.log(`sum netPnlUsd (all used closes)=${sumAllPnls.toFixed(4)}`);

  if (withVol.length >= 8) quartileMeans(vols, pnls);

  const hi = [...withVol].sort((a, b) => b.volLogret! - a.volLogret!).slice(0, 5);
  const lo = [...withVol].sort((a, b) => a.volLogret! - b.volLogret!).slice(0, 5);
  console.log('\n=== Top 5 highest pre-entry vol (logret 1m) ===');
  for (const d of hi) {
    console.log(
      `${d.mint.slice(0, 8)}… vol=${d.volLogret!.toFixed(6)} range%=${d.rangePct?.toFixed(4) ?? 'n/a'} pnl=${d.netPnlUsd.toFixed(2)} bars=${d.bars}`,
    );
  }
  console.log('\n=== Top 5 lowest pre-entry vol ===');
  for (const d of lo) {
    console.log(
      `${d.mint.slice(0, 8)}… vol=${d.volLogret!.toFixed(6)} range%=${d.rangePct?.toFixed(4) ?? 'n/a'} pnl=${d.netPnlUsd.toFixed(2)} bars=${d.bars}`,
    );
  }

  if (diags.some((d) => d.err)) {
    const errs = diags.filter((d) => d.err).length;
    console.log(`\n(note: ${errs} trades failed OHLCV fetch — see last errors sample)`);
    const sample = diags.find((d) => d.err);
    if (sample?.err) console.log('sample err:', sample.err.slice(0, 200));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
