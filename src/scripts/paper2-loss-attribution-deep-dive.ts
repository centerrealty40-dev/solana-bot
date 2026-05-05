/**
 * Closed-trade attribution: worst losers, pre/post entry price path (~±48h PG),
 * snapshot liquidity/volume at entry, journal features, oracle peak PnL gap.
 *
 *   npx tsx src/scripts/paper2-loss-attribution-deep-dive.ts \
 *     --jsonl data/live/pt1-oscar-live.jsonl --since-hours 336 --path-hours 48
 *
 * Requires DATABASE_URL. Uses pm2 pt1-oscar env for oracle fee math (`oracleFullExitNetPnlUsd`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import { loadPaperTraderConfig } from '../papertrader/config.js';
import { sourceSnapshotTable } from '../papertrader/dip-detector.js';
import type { Anchor } from './paper2-strategy-backtest.js';
import { cloneOpenFromJournal, oracleFullExitNetPnlUsd } from './paper2-strategy-backtest.js';
import { pm2Pt1OscarEnv, withEnvPatch } from './paper2-scenario-tp-trail-optimize.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function collectJsonlPaths(): string[] {
  const i = process.argv.indexOf('--jsonl');
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < process.argv.length; k++) {
    const p = process.argv[k];
    if (p.startsWith('--')) break;
    out.push(p);
  }
  return out;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchAnchorsPg(args: {
  mint: string;
  source: string;
  t0Ms: number;
  t1Ms: number;
}): Promise<Anchor[]> {
  const table = sourceSnapshotTable(args.source);
  if (!table) return [];
  const mint = sqlQuote(args.mint);
  const t0 = args.t0Ms / 1000;
  const t1 = args.t1Ms / 1000;
  const q = `
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::double precision AS ts_ms,
           price_usd::double precision AS p
    FROM ${table}
    WHERE base_mint = ${mint}
      AND ts >= to_timestamp(${t0})
      AND ts <= to_timestamp(${t1})
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `;
  const r = await db.execute(dsql.raw(q));
  const rows = r as unknown as Array<{ ts_ms: unknown; p: unknown }>;
  const out: Anchor[] = [];
  for (const row of rows) {
    const ts = Number(row.ts_ms);
    const p = Number(row.p);
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) continue;
    out.push({ ts, p });
  }
  return out;
}

export async function fetchSnapshotNearTs(args: {
  mint: string;
  source: string;
  nearTsMs: number;
}): Promise<{
  liq: number | null;
  vol5m: number | null;
  vol1h: number | null;
  buys5m: number | null;
  sells5m: number | null;
  mc: number | null;
} | null> {
  const table = sourceSnapshotTable(args.source);
  if (!table) return null;
  const mint = sqlQuote(args.mint);
  const t = args.nearTsMs / 1000;
  const q = `
    SELECT liquidity_usd::double precision AS liq,
           volume_5m::double precision AS v5,
           volume_1h::double precision AS v1h,
           buys_5m::int AS b5,
           sells_5m::int AS s5,
           market_cap_usd::double precision AS mc
    FROM ${table}
    WHERE base_mint = ${mint}
      AND ts <= to_timestamp(${t})
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts DESC
    LIMIT 1
  `;
  const r = await db.execute(dsql.raw(q));
  const row = (r as unknown as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    liq: row.liq != null ? Number(row.liq) : null,
    vol5m: row.v5 != null ? Number(row.v5) : null,
    vol1h: row.v1h != null ? Number(row.v1h) : null,
    buys5m: row.b5 != null ? Number(row.b5) : null,
    sells5m: row.s5 != null ? Number(row.s5) : null,
    mc: row.mc != null ? Number(row.mc) : null,
  };
}

export type ClosedPair = {
  mint: string;
  symbol: string;
  entryTs: number;
  exitTs: number;
  netUsd: number;
  pnlPct: number;
  reason: string;
  openTrade: Record<string, unknown>;
  closedTrade: Record<string, unknown>;
  /**
   * Между открытием и закрытием было добавление экспозиции по падению:
   * paper `dca_add` / `scale_in_add`, live `live_position_dca` / `live_position_scale_in`.
   */
  hadAvgDown?: boolean;
};

type PendingSlot = {
  ot: Record<string, unknown>;
  hadAvgDown: boolean;
};

function extractFeatures(open: Record<string, unknown>): Record<string, unknown> {
  const f = open.features as Record<string, unknown> | undefined;
  return f && typeof f === 'object' ? f : {};
}

export async function scanJournal(filePath: string, sinceCloseMs: number): Promise<ClosedPair[]> {
  const pending = new Map<string, PendingSlot>();
  const out: ClosedPair[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = String(e.kind ?? '');
    const mint = String(e.mint ?? '');

    if (kind === 'live_position_open') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (mint && ot) pending.set(mint, { ot, hadAvgDown: false });
      continue;
    }
    if (kind === 'live_position_scale_in' || kind === 'live_position_dca') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (mint && ot) {
        const prev = pending.get(mint);
        pending.set(mint, { ot, hadAvgDown: true || (prev?.hadAvgDown ?? false) });
      }
      continue;
    }
    if (kind === 'live_position_partial_sell') {
      const ot = e.openTrade as Record<string, unknown> | undefined;
      if (mint && ot) {
        const prev = pending.get(mint);
        pending.set(mint, { ot, hadAvgDown: prev?.hadAvgDown ?? false });
      }
      continue;
    }
    if (kind === 'live_position_close' && mint) {
      const ct = e.closedTrade as Record<string, unknown> | undefined;
      if (!ct) continue;
      const exitTs = typeof ct.exitTs === 'number' ? ct.exitTs : Number(e.ts ?? 0);
      const wallTs = typeof e.ts === 'number' ? e.ts : exitTs;
      const windowTs = Math.max(exitTs, wallTs);
      if (windowTs < sinceCloseMs) {
        pending.delete(mint);
        continue;
      }
      const slot = pending.get(mint);
      const ot = slot?.ot ?? (ct as Record<string, unknown>);
      const hadAvgDown = slot?.hadAvgDown ?? false;
      pending.delete(mint);
      out.push({
        mint,
        symbol: String(ct.symbol ?? ''),
        entryTs: Number(ot.entryTs ?? ct.entryTs ?? 0),
        exitTs,
        netUsd: Number(ct.netPnlUsd ?? 0),
        pnlPct: Number(ct.pnlPct ?? 0),
        reason: String(ct.exitReason ?? ''),
        openTrade: ot,
        closedTrade: ct,
        hadAvgDown,
      });
      continue;
    }

    if (kind === 'close' && mint) {
      const exitTs = typeof e.exitTs === 'number' ? e.exitTs : Number(e.ts ?? 0);
      const wallTs = typeof e.ts === 'number' ? e.ts : exitTs;
      const windowTs = Math.max(exitTs, wallTs);
      if (windowTs < sinceCloseMs) continue;
      const slot = pending.get(mint);
      if (!slot) continue;
      pending.delete(mint);
      const { ot, hadAvgDown } = slot;
      out.push({
        mint,
        symbol: String(e.symbol ?? ''),
        entryTs: Number(ot.entryTs ?? e.entryTs ?? 0),
        exitTs,
        netUsd: Number(e.netPnlUsd ?? 0),
        pnlPct: Number(e.pnlPct ?? 0),
        reason: String(e.exitReason ?? ''),
        openTrade: ot,
        closedTrade: e,
        hadAvgDown,
      });
      continue;
    }

    if (kind === 'dca_add' || kind === 'scale_in_add') {
      const slot = pending.get(mint);
      if (slot) slot.hadAvgDown = true;
      continue;
    }

    if (kind === 'open' && mint) {
      pending.set(mint, { ot: e, hadAvgDown: false });
    }
  }
  return out;
}

export function anchorsWindow(a: Anchor[], t0: number, t1: number): Anchor[] {
  return a.filter((x) => x.ts >= t0 && x.ts <= t1);
}

export function pathStats(anchors: Anchor[], entryTs: number, entryPx: number, pathH: number): {
  preSlopeLogPerH: number | null;
  entryPctInPreRange: number | null;
  pre48hRet: number | null;
  postMaxDdPct: number | null;
  postMaxUpPct: number | null;
  postPeakTs: number | null;
  regime: string;
} {
  const ms = pathH * 3_600_000;
  const pre = anchorsWindow(anchors, entryTs - ms, entryTs);
  const post = anchorsWindow(anchors, entryTs, entryTs + ms);
  let regime = 'unknown';

  let preSlopeLogPerH: number | null = null;
  let entryPctInPreRange: number | null = null;
  let pre48hRet: number | null = null;

  if (pre.length >= 3 && entryPx > 0) {
    const ps = pre.map((x) => x.p).filter((p) => p > 0);
    const preMin = Math.min(...ps);
    const preMax = Math.max(...ps);
    const preStart = pre[0]!.p;
    pre48hRet = entryPx / preStart - 1;
    const denom = preMax - preMin;
    entryPctInPreRange = denom > 1e-12 ? (entryPx - preMin) / denom : null;

    const step = 12;
    const samples: { h: number; logp: number }[] = [];
    for (let hi = 0; hi < pathH; hi += step / 12) {
      const tgt = entryTs - ms + hi * 3_600_000;
      let best: Anchor | null = null;
      for (const an of pre) {
        if (an.ts <= tgt && (!best || an.ts > best.ts)) best = an;
      }
      if (best && best.p > 0) samples.push({ h: hi, logp: Math.log(best.p) });
    }
    if (samples.length >= 4) {
      const n = samples.length;
      const mh = samples.reduce((s, x) => s + x.h, 0) / n;
      const mp = samples.reduce((s, x) => s + x.logp, 0) / n;
      let num = 0;
      let den = 0;
      for (const x of samples) {
        num += (x.h - mh) * (x.logp - mp);
        den += (x.h - mh) ** 2;
      }
      preSlopeLogPerH = den > 1e-9 ? num / den : null;
    }

    const nearHigh = entryPctInPreRange != null && entryPctInPreRange >= 0.78;
    const dumping = pre48hRet != null && pre48hRet < -0.18;
    const chop =
      pre48hRet != null &&
      Math.abs(pre48hRet) < 0.06 &&
      preMin > 0 &&
      (preMax - preMin) / preMin < 0.22;
    const momo = pre48hRet != null && pre48hRet > 0.12;

    if (nearHigh) regime = 'entry_near_48h_range_high';
    else if (dumping) regime = 'price_falling_into_entry';
    else if (chop) regime = 'pre_entry_sideways';
    else if (momo) regime = 'pre_entry_uptrend';
    else regime = 'mixed_transition';
  }

  let postMaxDdPct: number | null = null;
  let postMaxUpPct: number | null = null;
  let postPeakTs: number | null = null;
  if (post.length >= 2 && entryPx > 0) {
    let minP = entryPx;
    let maxP = entryPx;
    let peakTs: number | null = null;
    for (const an of post) {
      if (an.p < minP) minP = an.p;
      if (an.p > maxP) {
        maxP = an.p;
        peakTs = an.ts;
      }
    }
    postMaxDdPct = minP / entryPx - 1;
    postMaxUpPct = maxP / entryPx - 1;
    postPeakTs = peakTs;
  }

  return {
    preSlopeLogPerH,
    entryPctInPreRange,
    pre48hRet,
    postMaxDdPct,
    postMaxUpPct,
    postPeakTs,
    regime,
  };
}

function spearman(xs: number[], ys: number[]): number | null {
  const pairs = xs
    .map((x, i) => ({ x, y: ys[i]! }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pairs.length;
  if (n < 8) return null;
  const rx = rank(pairs.map((p) => p.x));
  const ry = rank(pairs.map((p) => p.y));
  let s = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i]! - ry[i]!;
    s += dx * dx;
  }
  return 1 - (6 * s) / (n * (n * n - 1));
}

function rank(vals: number[]): number[] {
  const idx = vals.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const r = new Array(vals.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[k]!.v) j++;
    const avgRank = (k + j + 2) / 2;
    for (let t = k; t <= j; t++) r[idx[t]!.i] = avgRank;
    k = j + 1;
  }
  return r;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 336);
  const pathH = Number(arg('--path-hours') ?? 48);
  const minNet = Number(arg('--min-net-usd') ?? ''); // optional filter

  let paths = collectJsonlPaths();
  const dir = arg('--dir');
  if (dir && fs.existsSync(dir)) {
    paths.push(
      ...fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f)),
    );
  }
  paths = [...new Set(paths.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
  if (paths.length === 0) {
    console.error('Provide --jsonl path(s) or --dir');
    process.exit(1);
  }

  const sinceCloseMs = Date.now() - sinceH * 3_600_000;
  const pairs: ClosedPair[] = [];
  for (const p of paths) {
    pairs.push(...(await scanJournal(p, sinceCloseMs)));
  }

  const oscarEnv = pm2Pt1OscarEnv();
  const cfg = withEnvPatch(oscarEnv, () => loadPaperTraderConfig());

  console.log(`\n=== Loss attribution deep dive ===`);
  console.log(`Journal files: ${paths.length}  closes in window: ${pairs.length} (since ${sinceH}h)`);
  console.log(`PG path window: ±${pathH}h around entry  |  Spearman needs n≥8 finite pairs\n`);

  const enriched: Array<
    ClosedPair & {
      source: string;
      regime: string;
      liq: number | null;
      vol5m: number | null;
      bs: number | null;
      dipPct: number | null;
      impulsePct: number | null;
      holdersNow: number | null;
      oraclePeakUsd: number | null;
      missedVsPeakUsd: number | null;
      postMaxDdPct: number | null;
      entryPctInPreRange: number | null;
    }
  > = [];

  for (const row of pairs) {
    const src = String(row.openTrade.source ?? '').trim();
    const legs = row.openTrade.legs as Array<{ marketPrice?: number; price?: number }> | undefined;
    const entryPx = Number(legs?.[0]?.marketPrice ?? legs?.[0]?.price ?? 0);
    const feat = extractFeatures(row.openTrade);
    const dipPct = feat.dip_pct != null ? Number(feat.dip_pct) : null;
    const impulsePct = feat.impulse_pct != null ? Number(feat.impulse_pct) : null;
    const holdersNow =
      feat.holders_now != null
        ? Number(feat.holders_now)
        : feat.holder_count != null
          ? Number(feat.holder_count)
          : null;

    const t0 = row.entryTs - pathH * 3_600_000;
    const t1 = row.entryTs + pathH * 3_600_000;
    let anchors: Anchor[] = [];
    if (sourceSnapshotTable(src) && entryPx > 0) {
      anchors = await fetchAnchorsPg({ mint: row.mint, source: src, t0Ms: t0, t1Ms: t1 });
    }
    const ps = pathStats(anchors, row.entryTs, entryPx, pathH);

    let snap = null as Awaited<ReturnType<typeof fetchSnapshotNearTs>>;
    if (sourceSnapshotTable(src)) {
      snap = await fetchSnapshotNearTs({ mint: row.mint, source: src, nearTsMs: row.entryTs });
    }
    const bs =
      snap && snap.buys5m != null && snap.sells5m != null && snap.sells5m + snap.buys5m > 0
        ? snap.buys5m / (snap.buys5m + snap.sells5m)
        : null;

    let oraclePeakUsd: number | null = null;
    let missedVsPeakUsd: number | null = null;
    if (anchors.length >= 2 && entryPx > 0) {
      const post = anchorsWindow(anchors, row.entryTs, row.entryTs + pathH * 3_600_000);
      let peakPx = entryPx;
      for (const an of post) {
        if (an.p > peakPx) peakPx = an.p;
      }
      try {
        const ot = cloneOpenFromJournal(row.openTrade);
        oraclePeakUsd = oracleFullExitNetPnlUsd(cfg, ot, peakPx);
        missedVsPeakUsd = oraclePeakUsd - row.netUsd;
      } catch {
        oraclePeakUsd = null;
        missedVsPeakUsd = null;
      }
    }

    enriched.push({
      ...row,
      source: src,
      regime: ps.regime,
      liq: snap?.liq ?? (feat.liq_usd != null ? Number(feat.liq_usd) : null),
      vol5m: snap?.vol5m ?? (feat.vol5m_usd != null ? Number(feat.vol5m_usd) : null),
      bs,
      dipPct,
      impulsePct,
      holdersNow,
      oraclePeakUsd,
      missedVsPeakUsd,
      postMaxDdPct: ps.postMaxDdPct,
      entryPctInPreRange: ps.entryPctInPreRange,
    });
  }

  let rows = enriched;
  if (Number.isFinite(minNet)) rows = rows.filter((r) => r.netUsd <= minNet);

  const losers = rows.filter((r) => r.netUsd < 0).sort((a, b) => a.netUsd - b.netUsd);
  const winners = rows.filter((r) => r.netUsd >= 0);

  console.log(`Losers: ${losers.length}  Winners: ${winners.length}  total net: $${rows.reduce((s, r) => s + r.netUsd, 0).toFixed(2)}`);

  const byMint = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const x = byMint.get(r.mint) ?? { sum: 0, n: 0 };
    x.sum += r.netUsd;
    x.n++;
    byMint.set(r.mint, x);
  }
  const repeatLosers = [...byMint.entries()]
    .filter(([, v]) => v.n >= 2 && v.sum < 0)
    .sort((a, b) => a[1].sum - b[1].sum)
    .slice(0, 15);
  if (repeatLosers.length) {
    console.log(`\n--- Mints with 2+ trades & negative total ---`);
    for (const [m, v] of repeatLosers) {
      console.log(`  ${m.slice(0, 8)}…  n=${v.n}  sum=$${v.sum.toFixed(2)}`);
    }
  }

  const regimeAgg = new Map<string, { n: number; sum: number }>();
  for (const r of losers) {
    const x = regimeAgg.get(r.regime) ?? { n: 0, sum: 0 };
    x.n++;
    x.sum += r.netUsd;
    regimeAgg.set(r.regime, x);
  }
  console.log(`\n--- Losers by pre-entry regime (±${pathH}h PG) ---`);
  const regSort = [...regimeAgg.entries()].sort((a, b) => a[1].sum - b[1].sum);
  for (const [k, v] of regSort) {
    console.log(`  ${k.padEnd(28)} n=${String(v.n).padStart(3)}  sum=$${v.sum.toFixed(2)}  avg=$${(v.sum / v.n).toFixed(2)}`);
  }

  function corrBlock(label: string, xs: (r: (typeof rows)[0]) => number | null): void {
    const xv: number[] = [];
    const yv: number[] = [];
    for (const r of rows) {
      const x = xs(r);
      if (x == null || !Number.isFinite(x)) continue;
      xv.push(x);
      yv.push(r.netUsd);
    }
    const rho = spearman(xv, yv);
    console.log(`  ${label}: n=${xv.length}  Spearman ρ=${rho == null ? 'n/a' : rho.toFixed(3)}`);
  }

  console.log(`\n--- Spearman ρ(netUsd, feature) full sample ---`);
  corrBlock('liquidity_usd', (r) => r.liq);
  corrBlock('volume_5m', (r) => r.vol5m);
  corrBlock('buy_share_5m', (r) => r.bs);
  corrBlock('dip_pct(journal)', (r) => r.dipPct);
  corrBlock('impulse_pct(journal)', (r) => r.impulsePct);
  corrBlock('holders_now', (r) => r.holdersNow);
  corrBlock('entry_hi_in_pre_range [0..1]', (r) => r.entryPctInPreRange);
  corrBlock('post_max_dd_pct', (r) => r.postMaxDdPct);

  function bucketMean(label: string, get: (r: (typeof losers)[0]) => number | null): void {
    const vals = losers.map(get).filter((x): x is number => x != null && Number.isFinite(x));
    if (vals.length < 6) {
      console.log(`  ${label}: insufficient`);
      return;
    }
    const sorted = [...vals].sort((a, b) => a - b);
    const t1 = sorted[Math.floor((sorted.length - 1) / 3)]!;
    const t2 = sorted[Math.floor((2 * (sorted.length - 1)) / 3)]!;
    console.log(`  ${label} (losers only, tertiles):`);
    const buckets = [
      { name: 'low', test: (x: number) => x <= t1 },
      { name: 'mid', test: (x: number) => x > t1 && x <= t2 },
      { name: 'high', test: (x: number) => x > t2 },
    ];
    for (const b of buckets) {
      const sub = losers.filter((r) => {
        const x = get(r);
        return x != null && Number.isFinite(x) && b.test(x);
      });
      const s = sub.reduce((u, r) => u + r.netUsd, 0);
      console.log(`    ${b.name.padEnd(5)} n=${sub.length}  sum=$${s.toFixed(2)}  avg=$${sub.length ? (s / sub.length).toFixed(2) : '0'}`);
    }
  }

  console.log(`\n--- Loser PnL sum by liquidity / vol tertiles ---`);
  bucketMean('liquidity', (r) => r.liq);
  bucketMean('volume_5m', (r) => r.vol5m);

  console.log(`\n--- Worst 18 closes (detail) ---`);
  for (const r of losers.slice(0, 18)) {
    const pk = r.oraclePeakUsd != null ? r.oraclePeakUsd.toFixed(1) : '?';
    const miss = r.missedVsPeakUsd != null ? r.missedVsPeakUsd.toFixed(1) : '?';
    const hi = r.entryPctInPreRange != null ? (r.entryPctInPreRange * 100).toFixed(0) : '?';
    const dd = r.postMaxDdPct != null ? (r.postMaxDdPct * 100).toFixed(1) : '?';
    console.log(
      `  $${r.netUsd.toFixed(2).padStart(7)}  ${r.reason.padEnd(10)}  ${r.symbol.slice(0, 10).padEnd(10)}  regime=${r.regime.slice(0, 22).padEnd(22)}  entry_hi%=${hi}%  post_dd%=${dd}%  oracle_peak_net≈$${pk}  missed_vs_peak≈$${miss}  liq=${r.liq?.toFixed(0) ?? '?'} vol5m=${r.vol5m?.toFixed(0) ?? '?'}`,
    );
  }

  console.log(
    `\nInterpretation: high entry_hi% → bought near top of ±48h range; large negative post_dd → continued dump after entry; positive oracle_peak_net with bad actual → path had upside but exits/strategy gave back.`,
  );
}

function lossAttributionInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (lossAttributionInvokedDirectly()) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
