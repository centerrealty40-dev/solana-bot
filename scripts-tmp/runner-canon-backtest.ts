/**
 * Runner-canon backtest, last 14 days (configurable via WINDOW_DAYS).
 *
 * Goal: estimate PnL of the runner-canon entry path (PAPER_RUNNER_*) when paired
 * with the current live-oscar exit canon (Wave B v1 / TP-ladder / killstop / trail).
 *
 * Method:
 *   1. Enumerate runner candidates from PG over the window using the same
 *      thresholds the production runner-mode applies (`evaluateRunner` with
 *      windowed aggregates per candidate ts).
 *   2. Deduplicate per mint with a 30-min cooldown between consecutive passes.
 *   3. Optional Policy A+ filter (bounce_from_min_30m, price_change_1h, vol_1h_max,
 *      price_change_30m). Two passes — `with_a_plus` and `without_a_plus`.
 *   4. For each candidate, build a price-anchor path from PG snapshots from
 *      entryTs to entryTs + 48h.
 *   5. Synthesize an `OpenTrade` via `cloneOpenFromJournal` and run
 *      `simulateLifecycle` with prod-loaded `loadPaperTraderConfig()`.
 *
 * Limitations (documented up-front):
 *   - Static Wave B parameters: `tpGridSellFractionProfile`, `tpGridStepPnl`,
 *     `dcaKillstop` come from env. Per-trade `tpGridOverrides` and
 *     `dynamicKillstopShadow` (computed at live entry from support cluster) are
 *     NOT applied — simulation uses the same exit profile for every candidate.
 *   - Slippage and entry costs use prod cfg (papertrader/costs.ts) but not
 *     real-time depth — same approximation as paper2-strategy-backtest.
 *   - Anchors come from 5-min snapshot ticks (interpolated linearly between).
 */
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../src/papertrader/config.js';
import {
  cloneOpenFromJournal,
  simulateLifecycle,
  type Anchor,
} from '../src/scripts/paper2-strategy-backtest.js';

interface CandidateRow {
  mint: string;
  ts: number;
  source: string;
  pair_address: string | null;
  price_usd: number;
  liquidity_usd: number;
  market_cap_usd: number | null;
  symbol?: string;
  vol1hUsd: number;
  vol12hUsd: number;
  vol24hUsd: number;
  vol1hVelocity: number | null;
  bs1h: number | null;
  bs12h: number | null;
  vol5mPeak1hUsd: number;
  liqP25_24hUsd: number | null;
  priceMax24hUsd: number | null;
  pgSamples24h: number;
}

interface PolicyAPlusInputs {
  mint: string;
  ts: number;
  bounceFromMin30mPct: number | null;
  priceChange1hPct: number | null;
  vol1hUsd: number;
  priceChangeWindowPct: number | null;
}

const RUNNER_DEX_TABLES = [
  'pumpswap_pair_snapshots',
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'moonshot_pair_snapshots',
  'orca_pair_snapshots',
];

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

const WINDOW_DAYS = Number(arg('--days', String(process.env.WINDOW_DAYS ?? 14)));
const STEP_MIN = Number(arg('--step-min', '30'));
const COOLDOWN_MIN = Number(arg('--cooldown-min', '30'));
const HOLD_HOURS = Number(arg('--hold-hours', '48'));
const SIM_STEP_MS = Number(arg('--sim-step-ms', '120000'));
const POLICY_A_PLUS = arg('--policy-a-plus', 'both'); // 'on' | 'off' | 'both'
const NOTIONAL_USD = Number(arg('--notional', '500'));

async function fetchActiveMints(cutoffTs: number): Promise<string[]> {
  const cutoff = new Date(cutoffTs).toISOString();
  const unionAll = RUNNER_DEX_TABLES.map(
    (t) => `SELECT base_mint FROM ${t} WHERE ts >= '${cutoff}'::timestamptz AND volume_5m > 0`,
  ).join(' UNION ALL ');
  const sqlText = `SELECT base_mint, COUNT(*)::int n FROM (${unionAll}) u GROUP BY base_mint HAVING COUNT(*) >= 36`;
  const r = (await db.execute(dsql.raw(sqlText))) as unknown as { base_mint: string; n: number }[];
  return r.map((x) => x.base_mint);
}

async function fetchSnapshotAtTs(mints: string[], ts: number): Promise<CandidateRow[]> {
  const tsIso = new Date(ts).toISOString();
  const tsLow = new Date(ts - 5 * 60_000).toISOString();
  if (mints.length === 0) return [];
  const mintsList = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
  const unionAll = RUNNER_DEX_TABLES.map(
    (t) => `
    SELECT base_mint AS mint, ts, '${t}' AS table_name, source, pair_address,
      price_usd::float AS price_usd, liquidity_usd::float AS liquidity_usd,
      GREATEST(COALESCE(market_cap_usd,0), COALESCE(fdv_usd,0))::float AS mcap_usd,
      ROW_NUMBER() OVER (PARTITION BY base_mint ORDER BY ABS(EXTRACT(EPOCH FROM (ts - '${tsIso}'::timestamptz)))) AS rn
    FROM ${t}
    WHERE base_mint IN (${mintsList})
      AND ts BETWEEN '${tsLow}'::timestamptz AND '${tsIso}'::timestamptz + INTERVAL '5 minutes'
      AND price_usd > 0
  `,
  ).join(' UNION ALL ');
  const sqlText = `
    WITH all_rows AS (${unionAll})
    SELECT mint, ts, table_name, source, pair_address, price_usd, liquidity_usd, mcap_usd
    FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY mint ORDER BY ABS(EXTRACT(EPOCH FROM (ts - '${tsIso}'::timestamptz)))) AS rk
      FROM all_rows
    ) f WHERE rk = 1
  `;
  const rows = (await db.execute(dsql.raw(sqlText))) as unknown as Array<{
    mint: string;
    ts: Date;
    table_name: string;
    source: string;
    pair_address: string | null;
    price_usd: number;
    liquidity_usd: number;
    mcap_usd: number;
  }>;
  return rows.map((r) => ({
    mint: r.mint,
    ts,
    source: r.source ?? r.table_name.replace('_pair_snapshots', ''),
    pair_address: r.pair_address,
    price_usd: Number(r.price_usd),
    liquidity_usd: Number(r.liquidity_usd ?? 0),
    market_cap_usd: r.mcap_usd != null ? Number(r.mcap_usd) : null,
    vol1hUsd: 0,
    vol12hUsd: 0,
    vol24hUsd: 0,
    vol1hVelocity: null,
    bs1h: null,
    bs12h: null,
    vol5mPeak1hUsd: 0,
    liqP25_24hUsd: null,
    priceMax24hUsd: null,
    pgSamples24h: 0,
  }));
}

async function fetchRunnerAggregatesAtTs(
  mints: string[],
  ts: number,
): Promise<Map<string, Partial<CandidateRow>>> {
  const map = new Map<string, Partial<CandidateRow>>();
  if (mints.length === 0) return map;
  const tsIso = new Date(ts).toISOString();
  const mintsList = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
  const unionAll = RUNNER_DEX_TABLES.map(
    (t) => `
    SELECT base_mint AS mint, ts,
      COALESCE(price_usd, 0)::float AS price_usd,
      COALESCE(liquidity_usd, 0)::float AS liquidity_usd,
      COALESCE(volume_5m, 0)::float AS volume_5m,
      COALESCE(buys_5m, 0)::int AS buys_5m,
      COALESCE(sells_5m, 0)::int AS sells_5m,
      GREATEST(COALESCE(market_cap_usd, 0), COALESCE(fdv_usd, 0))::float AS mcap_usd
    FROM ${t}
    WHERE base_mint IN (${mintsList})
      AND ts >= '${tsIso}'::timestamptz - INTERVAL '24 hours'
      AND ts <= '${tsIso}'::timestamptz
  `,
  ).join(' UNION ALL ');

  const sqlText = `
    WITH rows AS (${unionAll})
    SELECT
      mint,
      SUM(volume_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '1 hour')::float AS vol_1h,
      SUM(volume_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '12 hours')::float AS vol_12h,
      SUM(volume_5m)::float AS vol_24h,
      SUM(buys_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '1 hour')::int AS buys_1h,
      SUM(sells_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '1 hour')::int AS sells_1h,
      SUM(buys_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '12 hours')::int AS buys_12h,
      SUM(sells_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '12 hours')::int AS sells_12h,
      MAX(volume_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '1 hour')::float AS vol_5m_peak_1h,
      MAX(price_usd) FILTER (WHERE price_usd > 0)::float AS price_max_24h,
      percentile_disc(0.25) WITHIN GROUP (ORDER BY liquidity_usd) FILTER (WHERE liquidity_usd > 0)::float AS liq_p25_24h,
      COUNT(*)::int AS sample_rows
    FROM rows GROUP BY mint
  `;

  const r = (await db.execute(dsql.raw(sqlText))) as unknown as Array<{
    mint: string;
    vol_1h: number | null;
    vol_12h: number | null;
    vol_24h: number | null;
    buys_1h: number | null;
    sells_1h: number | null;
    buys_12h: number | null;
    sells_12h: number | null;
    vol_5m_peak_1h: number | null;
    price_max_24h: number | null;
    liq_p25_24h: number | null;
    sample_rows: number | null;
  }>;
  for (const a of r) {
    const vol1h = Number(a.vol_1h ?? 0);
    const vol12h = Number(a.vol_12h ?? 0);
    const vol24h = Number(a.vol_24h ?? 0);
    const vol1hAvg = vol24h / 24;
    const buys1h = Number(a.buys_1h ?? 0);
    const sells1h = Number(a.sells_1h ?? 0);
    const buys12h = Number(a.buys_12h ?? 0);
    const sells12h = Number(a.sells_12h ?? 0);
    map.set(a.mint, {
      vol1hUsd: vol1h,
      vol12hUsd: vol12h,
      vol24hUsd: vol24h,
      vol1hVelocity: vol1hAvg > 0 ? vol1h / vol1hAvg : null,
      bs1h: sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? Infinity : null,
      bs12h: sells12h > 0 ? buys12h / sells12h : buys12h > 0 ? Infinity : null,
      vol5mPeak1hUsd: Number(a.vol_5m_peak_1h ?? 0),
      priceMax24hUsd: a.price_max_24h != null ? Number(a.price_max_24h) : null,
      liqP25_24hUsd: a.liq_p25_24h != null ? Number(a.liq_p25_24h) : null,
      pgSamples24h: Number(a.sample_rows ?? 0),
    });
  }
  return map;
}

interface RunnerCfg {
  enabled: boolean;
  minPgSamples24h: number;
  minMcapUsd: number;
  maxMcapUsd: number;
  minLiqUsd: number;
  minVol1hUsd: number;
  minVol12hUsd: number;
  velocityMinX: number;
  minVol5mPeak1hUsd: number;
  bs1hMin: number;
  bs12hMin: number;
  liqVsP25Min: number;
  priceHoldMin: number;
  staleVolRatioMax: number;
}

function buildRunnerCfgFromEnv(): RunnerCfg {
  return {
    enabled: process.env.PAPER_RUNNER_MODE_ENABLED === '1',
    minPgSamples24h: Number(process.env.PAPER_RUNNER_MIN_PG_SAMPLES_24H ?? 36),
    minMcapUsd: Number(process.env.PAPER_RUNNER_MIN_MCAP_USD ?? 1_000_000),
    maxMcapUsd: Number(process.env.PAPER_RUNNER_MAX_MCAP_USD ?? 30_000_000),
    minLiqUsd: Number(process.env.PAPER_RUNNER_MIN_LIQ_USD ?? 80_000),
    minVol1hUsd: Number(process.env.PAPER_RUNNER_MIN_VOL_1H_USD ?? 80_000),
    minVol12hUsd: Number(process.env.PAPER_RUNNER_MIN_VOL_12H_USD ?? 400_000),
    velocityMinX: Number(process.env.PAPER_RUNNER_VELOCITY_MIN_X ?? 1.5),
    minVol5mPeak1hUsd: Number(process.env.PAPER_RUNNER_MIN_VOL_5M_PEAK_1H_USD ?? 20_000),
    bs1hMin: Number(process.env.PAPER_RUNNER_BS_1H_MIN ?? 0.95),
    bs12hMin: Number(process.env.PAPER_RUNNER_BS_12H_MIN ?? 1.0),
    liqVsP25Min: Number(process.env.PAPER_RUNNER_LIQ_VS_P25_MIN ?? 0.85),
    priceHoldMin: Number(process.env.PAPER_RUNNER_PRICE_HOLD_MIN ?? 0.6),
    staleVolRatioMax: Number(process.env.PAPER_RUNNER_STALE_VOL_RATIO_MAX ?? 0.5),
  };
}

function passesRunner(c: CandidateRow, rcfg: RunnerCfg): boolean {
  if (!rcfg.enabled) return false;
  if (c.pgSamples24h < rcfg.minPgSamples24h) return false;
  const mcap = c.market_cap_usd ?? 0;
  if (rcfg.minMcapUsd > 0 && mcap < rcfg.minMcapUsd) return false;
  if (rcfg.maxMcapUsd > 0 && mcap > rcfg.maxMcapUsd) return false;
  if (rcfg.minLiqUsd > 0 && c.liquidity_usd < rcfg.minLiqUsd) return false;
  if (rcfg.minVol1hUsd > 0 && c.vol1hUsd < rcfg.minVol1hUsd) return false;
  if (rcfg.minVol12hUsd > 0 && c.vol12hUsd < rcfg.minVol12hUsd) return false;
  if (rcfg.velocityMinX > 0 && c.vol1hVelocity != null && c.vol1hVelocity < rcfg.velocityMinX) return false;
  if (rcfg.minVol5mPeak1hUsd > 0 && c.vol5mPeak1hUsd < rcfg.minVol5mPeak1hUsd) return false;
  if (rcfg.bs1hMin > 0 && c.bs1h != null && Number.isFinite(c.bs1h) && c.bs1h < rcfg.bs1hMin) return false;
  if (rcfg.bs12hMin > 0 && c.bs12h != null && Number.isFinite(c.bs12h) && c.bs12h < rcfg.bs12hMin) return false;
  if (rcfg.liqVsP25Min > 0 && c.liqP25_24hUsd != null && c.liqP25_24hUsd > 0 && c.liquidity_usd < c.liqP25_24hUsd * rcfg.liqVsP25Min) return false;
  if (rcfg.priceHoldMin > 0 && c.priceMax24hUsd != null && c.priceMax24hUsd > 0 && c.price_usd / c.priceMax24hUsd < rcfg.priceHoldMin) return false;
  const vol1hAvg = c.vol24hUsd / 24;
  if (rcfg.staleVolRatioMax > 0 && vol1hAvg > 0 && c.vol1hUsd < vol1hAvg * rcfg.staleVolRatioMax) return false;
  return true;
}

async function fetchPolicyAPlusInputsAtTs(mints: string[], ts: number): Promise<Map<string, PolicyAPlusInputs>> {
  const map = new Map<string, PolicyAPlusInputs>();
  if (mints.length === 0) return map;
  const tsIso = new Date(ts).toISOString();
  const window = Number(process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_WINDOW_MIN ?? 15);
  const mintsList = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(',');
  const unionAll = RUNNER_DEX_TABLES.map(
    (t) => `
    SELECT base_mint AS mint, ts, COALESCE(price_usd, 0)::float AS price_usd, COALESCE(volume_5m, 0)::float AS volume_5m
    FROM ${t}
    WHERE base_mint IN (${mintsList})
      AND ts >= '${tsIso}'::timestamptz - INTERVAL '90 minutes'
      AND ts <= '${tsIso}'::timestamptz
  `,
  ).join(' UNION ALL ');
  const sqlText = `
    WITH rows AS (${unionAll}),
    base AS (
      SELECT mint,
        MAX(price_usd) FILTER (WHERE price_usd > 0 AND ts >= '${tsIso}'::timestamptz - INTERVAL '5 minutes') AS price_now,
        MIN(price_usd) FILTER (WHERE price_usd > 0 AND ts >= '${tsIso}'::timestamptz - INTERVAL '30 minutes') AS price_min_30m,
        AVG(price_usd) FILTER (WHERE price_usd > 0 AND ts BETWEEN '${tsIso}'::timestamptz - INTERVAL '60 minutes' AND '${tsIso}'::timestamptz - INTERVAL '55 minutes') AS price_60m_ago,
        AVG(price_usd) FILTER (WHERE price_usd > 0 AND ts BETWEEN '${tsIso}'::timestamptz - INTERVAL '${window} minutes' AND '${tsIso}'::timestamptz - INTERVAL '${window - 5} minutes') AS price_window_ago,
        SUM(volume_5m) FILTER (WHERE ts >= '${tsIso}'::timestamptz - INTERVAL '1 hour') AS vol_1h
      FROM rows GROUP BY mint
    )
    SELECT * FROM base
  `;
  const r = (await db.execute(dsql.raw(sqlText))) as unknown as Array<{
    mint: string;
    price_now: number | null;
    price_min_30m: number | null;
    price_60m_ago: number | null;
    price_window_ago: number | null;
    vol_1h: number | null;
  }>;
  for (const a of r) {
    const pn = Number(a.price_now ?? 0);
    const pmin = Number(a.price_min_30m ?? 0);
    const p60 = Number(a.price_60m_ago ?? 0);
    const pwin = Number(a.price_window_ago ?? 0);
    map.set(a.mint, {
      mint: a.mint,
      ts,
      bounceFromMin30mPct: pmin > 0 ? (pn / pmin - 1) * 100 : null,
      priceChange1hPct: p60 > 0 ? (pn / p60 - 1) * 100 : null,
      priceChangeWindowPct: pwin > 0 ? (pn / pwin - 1) * 100 : null,
      vol1hUsd: Number(a.vol_1h ?? 0),
    });
  }
  return map;
}

interface APlusCfg {
  enabled: boolean;
  bounceMaxPct: number;
  priceChange1hMinPct: number;
  vol1hMaxUsd: number;
  priceChangeWindowMinPct: number;
}

function aPlusCfgFromEnv(): APlusCfg {
  return {
    enabled: process.env.PAPER_POLICY_A_PLUS_ENABLED === '1',
    bounceMaxPct: Number(process.env.PAPER_POLICY_A_PLUS_BOUNCE_FROM_MIN_30M_MAX_PCT ?? 2.5),
    priceChange1hMinPct: Number(process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_1H_MIN_PCT ?? -20),
    vol1hMaxUsd: Number(process.env.PAPER_POLICY_A_PLUS_VOL_1H_MAX_USD ?? 1_000_000),
    priceChangeWindowMinPct: Number(process.env.PAPER_POLICY_A_PLUS_PRICE_CHANGE_30M_MIN_PCT ?? -10),
  };
}

function passesAPlus(p: PolicyAPlusInputs, cfg: APlusCfg): boolean {
  if (!cfg.enabled) return true;
  if (p.bounceFromMin30mPct != null && p.bounceFromMin30mPct > cfg.bounceMaxPct) return false;
  if (p.priceChange1hPct != null && p.priceChange1hPct < cfg.priceChange1hMinPct) return false;
  if (cfg.vol1hMaxUsd > 0 && p.vol1hUsd > cfg.vol1hMaxUsd) return false;
  if (p.priceChangeWindowPct != null && p.priceChangeWindowPct < cfg.priceChangeWindowMinPct) return false;
  return true;
}

async function fetchAnchors(mint: string, fromTs: number, toTs: number): Promise<Anchor[]> {
  const fromIso = new Date(fromTs).toISOString();
  const toIso = new Date(toTs).toISOString();
  const unionAll = RUNNER_DEX_TABLES.map(
    (t) => `
    SELECT ts, COALESCE(price_usd, 0)::float AS p
    FROM ${t}
    WHERE base_mint = '${mint.replace(/'/g, "''")}'
      AND ts BETWEEN '${fromIso}'::timestamptz AND '${toIso}'::timestamptz
      AND price_usd > 0
  `,
  ).join(' UNION ALL ');
  const sqlText = `SELECT ts, AVG(p)::float AS p FROM (${unionAll}) u GROUP BY ts ORDER BY ts`;
  const r = (await db.execute(dsql.raw(sqlText))) as unknown as Array<{ ts: Date; p: number }>;
  return r.map((x) => ({ ts: new Date(x.ts).getTime(), p: Number(x.p) }));
}

interface SimResult {
  mint: string;
  symbol?: string;
  source: string;
  entryTs: number;
  entryPrice: number;
  closed: boolean;
  exitReason: string;
  exitTs: number;
  durationMin: number;
  peakPnlPct: number;
  pnlPct: number;
  netPnlUsd: number;
  tpHits: number;
  dcaLegs: number;
}

async function simulateOne(
  cand: CandidateRow,
  cfg: Awaited<ReturnType<typeof loadPaperTraderConfig>>,
  dcaLevels: ReturnType<typeof parseDcaLevels>,
  tpLadder: ReturnType<typeof parseTpLadder>,
): Promise<SimResult | null> {
  const fromTs = cand.ts;
  const toTs = cand.ts + HOLD_HOURS * 3_600_000;
  const anchors = await fetchAnchors(cand.mint, fromTs, toTs);
  if (anchors.length < 2) return null;
  const open = {
    mint: cand.mint,
    symbol: cand.symbol ?? '',
    lane: 'post_migration',
    source: cand.source,
    dex: cand.source,
    entryTs: cand.ts,
    entryMcUsd: cand.market_cap_usd ?? cand.price_usd,
    legs: [{ ts: cand.ts, price: cand.price_usd, marketPrice: cand.price_usd, sizeUsd: NOTIONAL_USD, reason: 'open' }],
    pairAddress: cand.pair_address,
    entryLiqUsd: cand.liquidity_usd,
  } as unknown as Record<string, unknown>;
  const baseOt = cloneOpenFromJournal(open, cfg);
  const closed = simulateLifecycle({
    baseOt,
    anchors,
    cfg,
    dcaLevels,
    tpLadder,
    stepMs: SIM_STEP_MS,
  });
  if (!closed) return null;
  return {
    mint: cand.mint,
    symbol: cand.symbol,
    source: cand.source,
    entryTs: cand.ts,
    entryPrice: cand.price_usd,
    closed: true,
    exitReason: closed.exitReason ?? 'UNKNOWN',
    exitTs: closed.exitTs ?? cand.ts,
    durationMin: closed.durationMin ?? 0,
    peakPnlPct: closed.peakPnlPct ?? 0,
    pnlPct: closed.pnlPct ?? 0,
    netPnlUsd: closed.netPnlUsd ?? 0,
    tpHits: closed.exitContext?.tpLadderHits ?? 0,
    dcaLegs: closed.exitContext?.dcaLegsAdded ?? 0,
  };
}

function summary(label: string, results: SimResult[]): string {
  const closed = results.filter((r) => r.closed);
  const inv = closed.length * NOTIONAL_USD;
  const sumPnl = closed.reduce((s, r) => s + r.netPnlUsd, 0);
  const wins = closed.filter((r) => r.netPnlUsd > 0).length;
  const losses = closed.filter((r) => r.netPnlUsd < 0).length;
  const wr = closed.length ? (100 * wins) / closed.length : 0;
  const avg = closed.length ? sumPnl / closed.length : 0;
  const peakWins = closed.filter((r) => r.peakPnlPct >= 5).length;
  const out: string[] = [];
  out.push(`## ${label}`);
  out.push(`- candidates simulated: ${closed.length}`);
  out.push(`- $invested: $${inv.toFixed(0)}`);
  out.push(`- net PnL: $${sumPnl.toFixed(2)}`);
  out.push(`- ROI: ${(inv > 0 ? (100 * sumPnl) / inv : 0).toFixed(2)}%`);
  out.push(`- avg per trade: $${avg.toFixed(2)}`);
  out.push(`- wins / losses / win-rate: ${wins} / ${losses} / ${wr.toFixed(0)}%`);
  out.push(`- peak ≥+5% in ${peakWins} of ${closed.length} (${closed.length ? (100 * peakWins / closed.length).toFixed(0) : 0}%)`);
  // exit reason histogram
  const reasonCnt = new Map<string, number>();
  for (const r of closed) reasonCnt.set(r.exitReason, (reasonCnt.get(r.exitReason) ?? 0) + 1);
  out.push(`- exit reasons: ${[...reasonCnt.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join(' ')}`);
  return out.join('\n');
}

async function main() {
  const cfg = loadPaperTraderConfig();
  const rcfg = buildRunnerCfgFromEnv();
  const aplus = aPlusCfgFromEnv();
  const dcaLevels = parseDcaLevels(process.env.PAPER_DCA_LEVELS ?? '');
  const tpLadder = parseTpLadder(process.env.PAPER_TP_LADDER ?? '');

  console.log('# Runner-canon backtest');
  console.log(`# Window: last ${WINDOW_DAYS} days, step ${STEP_MIN}min, cooldown ${COOLDOWN_MIN}min, hold ≤${HOLD_HOURS}h`);
  console.log(`# Notional per trade: $${NOTIONAL_USD}`);
  console.log(`# Runner thresholds (from env): vol1h≥$${rcfg.minVol1hUsd}, vol12h≥$${rcfg.minVol12hUsd}, velocity≥${rcfg.velocityMinX}x, bs1h≥${rcfg.bs1hMin}, bs12h≥${rcfg.bs12hMin}, mcap [$${rcfg.minMcapUsd},$${rcfg.maxMcapUsd}], liq≥$${rcfg.minLiqUsd}, priceHold≥${rcfg.priceHoldMin}, staleVolRatioMax=${rcfg.staleVolRatioMax}`);
  console.log(`# Policy A+ (env): enabled=${aplus.enabled}, bounceMax=${aplus.bounceMaxPct}%, vol1hMax=$${aplus.vol1hMaxUsd}`);

  const cutoffTs = Date.now() - WINDOW_DAYS * 86400_000;
  const allMints = await fetchActiveMints(cutoffTs);
  console.log(`# active mints (≥36 5min-rows in window): ${allMints.length}`);

  const stepMs = STEP_MIN * 60_000;
  const cooldownMs = COOLDOWN_MIN * 60_000;
  const lastPassByMint = new Map<string, number>();
  const candidates: CandidateRow[] = [];
  let tickIdx = 0;
  for (let t = cutoffTs; t <= Date.now(); t += stepMs) {
    tickIdx++;
    if (tickIdx % 50 === 0) {
      const pct = ((t - cutoffTs) / (Date.now() - cutoffTs)) * 100;
      console.error(`# tick ${tickIdx} (${pct.toFixed(1)}%) — ${candidates.length} candidates so far`);
    }
    // Only mints whose previous pass is older than cooldown
    const eligible = allMints.filter((m) => (lastPassByMint.get(m) ?? 0) + cooldownMs <= t);
    if (eligible.length === 0) continue;

    const [snap, agg] = await Promise.all([
      fetchSnapshotAtTs(eligible, t),
      fetchRunnerAggregatesAtTs(eligible, t),
    ]);
    for (const row of snap) {
      const a = agg.get(row.mint);
      if (!a) continue;
      const merged: CandidateRow = { ...row, ...a } as CandidateRow;
      if (passesRunner(merged, rcfg)) {
        candidates.push(merged);
        lastPassByMint.set(merged.mint, t);
      }
    }
  }

  console.log(`\n# Total runner-pass candidates (cooldown applied): ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('No candidates — exiting.');
    process.exit(0);
  }

  // Policy A+ filtering passes
  const wantOn = POLICY_A_PLUS === 'on' || POLICY_A_PLUS === 'both';
  const wantOff = POLICY_A_PLUS === 'off' || POLICY_A_PLUS === 'both';

  const aPlusInputsByCand = new Map<string, PolicyAPlusInputs>();
  if (wantOn) {
    // batch fetch policy-a-plus inputs (per-tick, reuse computed candidates ts)
    const byTs = new Map<number, string[]>();
    for (const c of candidates) {
      if (!byTs.has(c.ts)) byTs.set(c.ts, []);
      byTs.get(c.ts)!.push(c.mint);
    }
    for (const [ts, mints] of byTs) {
      const inputs = await fetchPolicyAPlusInputsAtTs(mints, ts);
      for (const [mint, inp] of inputs) aPlusInputsByCand.set(`${mint}|${ts}`, inp);
    }
  }
  const candsWithoutAPlus = candidates;
  const candsWithAPlus = wantOn
    ? candidates.filter((c) => {
        const inp = aPlusInputsByCand.get(`${c.mint}|${c.ts}`);
        return inp ? passesAPlus(inp, aplus) : false;
      })
    : [];

  console.log(`# Candidates (without A+): ${candsWithoutAPlus.length}`);
  if (wantOn) console.log(`# Candidates (with A+):    ${candsWithAPlus.length}`);

  // Simulate
  async function simulateBatch(label: string, list: CandidateRow[]): Promise<SimResult[]> {
    const out: SimResult[] = [];
    let i = 0;
    for (const c of list) {
      i++;
      if (i % 25 === 0) console.error(`# [${label}] simulated ${i}/${list.length}`);
      const r = await simulateOne(c, cfg, dcaLevels, tpLadder);
      if (r) out.push(r);
    }
    return out;
  }

  const resultsOff = wantOff ? await simulateBatch('off', candsWithoutAPlus) : [];
  const resultsOn = wantOn ? await simulateBatch('on', candsWithAPlus) : [];

  console.log('\n----------------------------------------\n');
  if (wantOff) console.log(summary(`Runner-only, NO Policy A+ (${candsWithoutAPlus.length} pass)`, resultsOff));
  if (wantOn) {
    console.log('');
    console.log(summary(`Runner + Policy A+ (${candsWithAPlus.length} pass)`, resultsOn));
  }

  // Per-trade table for the more conservative branch (A+ on if available, else off)
  const detail = wantOn ? resultsOn : resultsOff;
  if (detail.length > 0) {
    console.log(`\n## Per-trade detail (${wantOn ? 'with A+' : 'no A+'})`);
    console.log('entryTs              source     mint                                          dur(m)   peak%    pnl%    netPnl$   tp/dca  exitReason');
    for (const r of detail.sort((a, b) => a.entryTs - b.entryTs)) {
      console.log(
        new Date(r.entryTs).toISOString().slice(0, 16).replace('T', ' ') +
          '  ' +
          r.source.padEnd(9) + ' ' +
          r.mint.padEnd(46) + '  ' +
          String(r.durationMin.toFixed(0)).padStart(5) + '  ' +
          ((r.peakPnlPct >= 0 ? '+' : '') + r.peakPnlPct.toFixed(1) + '%').padStart(7) + '  ' +
          ((r.pnlPct >= 0 ? '+' : '') + r.pnlPct.toFixed(1) + '%').padStart(7) + '  ' +
          ('$' + r.netPnlUsd.toFixed(2)).padStart(8) + '  ' +
          `${r.tpHits}/${r.dcaLegs}`.padStart(6) + '  ' +
          r.exitReason,
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('runner-canon-backtest failed:', e);
  process.exit(1);
});
