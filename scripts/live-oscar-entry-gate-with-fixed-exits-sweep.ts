/**
 * Live Oscar — **фиксированные «идеальные» выходы** + перебор **только dip-гейта входа**
 * на истории закрытых сделок.
 *
 * Для каждой сделки: по PG `price_usd` строим high/low в окнах **до `entryTs`** (как в dip-detector),
 * собираем `SnapshotCandidateRow` с ценой первой ноги, вызываем **`evaluateDip`**.
 * Если гейт **не** прошёл — считаем «с таким входом сделки бы **не было**» (0 в сумму).
 * Если прошёл — **`simulateLifecycle`** с патчем выходов (signal kill, TP-grid, DCA kill, retrace + зеркало B).
 *
 * Цены — Postgres (как остальные live-свипы). Импульс/QN Jupiter при отборе **не** переигрывается
 * (для этого нужен отдельный трекер discovery); здесь только **dip-окна / % / импульс по тем же свечам PG**.
 *
 *   npm run live:entry-exit-sweep -- --journal data/live/pt1-oscar-live.jsonl
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../src/papertrader/config.js';
import { sourceSnapshotTable } from '../src/papertrader/dip-detector.js';
import { evaluateDip, type DipContextByWindows } from '../src/papertrader/dip-detector.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade, PositionLeg, SnapshotCandidateRow } from '../src/papertrader/types.js';
import {
  cloneOpenFromJournal,
  simulateLifecycle,
  type Anchor,
} from '../src/scripts/paper2-strategy-backtest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function stringifyEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function pm2AppPaperEnv(appName: 'live-oscar' | 'live-oscar-risky'): Record<string, string> {
  const ecosystem = require(path.join(repoRoot, 'ecosystem.config.cjs')) as {
    apps: Array<{ name?: string; env?: Record<string, unknown> }>;
  };
  const app = ecosystem.apps?.find((a) => a.name === appName);
  if (!app?.env) throw new Error(`ecosystem.config.cjs: ${appName} env not found`);
  return stringifyEnv(app.env as Record<string, unknown>);
}

function withEnvPatch<T>(patch: Record<string, string>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k] of Object.entries(patch)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
}

function argStr(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  return process.argv[i + 1]!;
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchPriceAnchorsPg(args: {
  mint: string;
  source: string;
  entryTs: number;
  endTs: number;
}): Promise<Anchor[]> {
  const table = sourceSnapshotTable(args.source);
  if (!table) return [];
  const mint = sqlQuote(args.mint);
  const t0 = args.entryTs / 1000;
  const t1 = args.endTs / 1000;
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

function mergeCfg(base: PaperTraderConfig, patch: Partial<PaperTraderConfig>): PaperTraderConfig {
  return { ...base, ...patch };
}

function tpAbMirror(patch: Partial<PaperTraderConfig>): Partial<PaperTraderConfig> {
  const out = { ...patch };
  if (typeof patch.tpGridStepPnl === 'number') {
    out.liveExitModeBTpGridStepPnl = patch.tpGridStepPnl;
  }
  if (typeof patch.tpGridSellFraction === 'number') {
    out.liveExitModeBTpGridSellFraction = patch.tpGridSellFraction;
  }
  if (typeof patch.tpGridFirstRungRetraceMinPnlPct === 'number') {
    out.liveExitModeBTpGridFirstRungRetraceMinPnlPct = patch.tpGridFirstRungRetraceMinPnlPct;
  }
  return out;
}

/** Фиксированные выходы из оракула (sell 0.05 как в топ-комбо). */
function fixedExitPatch(): Partial<PaperTraderConfig> {
  return tpAbMirror({
    liveStagedEntryKillDropPct: 15,
    tpGridStepPnl: 0.04,
    tpGridSellFraction: 0.05,
    tpGridFirstRungRetraceMinPnlPct: 0.02,
    dcaKillstop: -0.055,
    liveExitModeBDcaKillstop: -0.055,
  });
}

function clipAnchors(anchors: Anchor[], t0: number, t1: number): Anchor[] {
  return anchors.filter((a) => a.ts >= t0 && a.ts <= t1);
}

function dipContextFromAnchors(entryTs: number, windowsMin: number[], anchors: Anchor[]): DipContextByWindows {
  const map: DipContextByWindows = new Map();
  for (const w of windowsMin) {
    const t0 = entryTs - w * 60_000;
    const slice = anchors.filter((a) => a.ts >= t0 && a.ts <= entryTs);
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    for (const a of slice) {
      if (a.p > high) high = a.p;
      if (a.p < low) low = a.p;
    }
    if (!(high > 0) || !Number.isFinite(low) || !(low > 0)) continue;
    map.set(w, { high_px: high, low_px: low });
  }
  return map;
}

function syntheticSnapshotRow(ct: Record<string, unknown>, leg0: PositionLeg): SnapshotCandidateRow {
  const px = Number(leg0.marketPrice ?? leg0.price);
  return {
    mint: String(ct.mint),
    symbol: String(ct.symbol ?? ''),
    ts: new Date(Number(ct.entryTs ?? 0)),
    launch_ts: null,
    age_min: null,
    price_usd: px,
    liquidity_usd: Math.max(1, Number(ct.entryLiqUsd ?? 1)),
    volume_5m: 1_000_000,
    volume_1h: 1_000_000,
    buys_5m: 10,
    sells_5m: 10,
    market_cap_usd: null,
    source: String(ct.source ?? 'pumpswap'),
    holder_count: 3000,
    token_age_min: 100_000,
    pair_address: null,
  };
}

type Prep = {
  closedTrade: Record<string, unknown>;
  anchorsExit: Anchor[];
  anchorsDip: Anchor[];
  entryTs: number;
  exitTs: number;
};

type EntryScenario = { id: string; patch: Partial<PaperTraderConfig> };

function buildEntryScenarios(_base: PaperTraderConfig): EntryScenario[] {
  return [
    { id: 'E0_prod_dip_windows', patch: {} },
    { id: 'E1_windows_60_120_360', patch: { dipLookbackWindowsMin: [60, 120, 360] } },
    { id: 'E2_windows_30_60_120', patch: { dipLookbackWindowsMin: [30, 60, 120] } },
    { id: 'E3_windows_180_360_720', patch: { dipLookbackWindowsMin: [180, 360, 720] } },
    { id: 'E4_windows_60_only', patch: { dipLookbackWindowsMin: [60] } },
    { id: 'E5_windows_120_only', patch: { dipLookbackWindowsMin: [120] } },
    { id: 'E6_dipMinDrop_-15', patch: { dipMinDropPct: -15 } },
    { id: 'E7_dipMinDrop_-25', patch: { dipMinDropPct: -25 } },
    { id: 'E8_impulse_10', patch: { dipMinImpulsePct: 10 } },
    { id: 'E9_impulse_18', patch: { dipMinImpulsePct: 18 } },
    { id: 'E10_recovery_veto_off', patch: { dipRecoveryVetoEnabled: false } },
    { id: 'E11_local_high_veto_off', patch: { dipLocalHighVetoEnabled: false } },
    { id: 'E12_combo_shortwin_softdip', patch: { dipLookbackWindowsMin: [60, 120, 360], dipMinDropPct: -15 } },
  ];
}

function simTrade(
  row: Prep,
  cfg: PaperTraderConfig,
  dcaLevels: ReturnType<typeof parseDcaLevels>,
  tpLadder: ReturnType<typeof parseTpLadder>,
  stepMs: number,
): number | null {
  const anchorsClipped = clipAnchors(row.anchorsExit, row.entryTs, row.exitTs);
  let baseOt: OpenTrade;
  try {
    baseOt = cloneOpenFromJournal(row.closedTrade, cfg);
  } catch {
    return null;
  }
  const sim = simulateLifecycle({
    baseOt,
    anchors: anchorsClipped.length >= 2 ? anchorsClipped : row.anchorsExit,
    cfg,
    dcaLevels,
    tpLadder,
    stepMs,
  });
  return sim ? sim.netPnlUsd : null;
}

async function main(): Promise<void> {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const stepMs = 60_000;
  const maxLookbackMin = 12 * 60;
  const risky = process.argv.includes('--risky');
  const appName = risky ? 'live-oscar-risky' : 'live-oscar';
  const pmEnv = pm2AppPaperEnv(appName);

  const { baseCfg, dcaLevels, tpLadder } = withEnvPatch(pmEnv, () => ({
    baseCfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));

  const exitPatch = fixedExitPatch();
  const cfgExitFixed = mergeCfg(baseCfg, exitPatch);
  const scenarios = buildEntryScenarios(baseCfg);

  const abs = path.resolve(journal);
  if (!fs.existsSync(abs)) {
    console.error('journal missing', abs);
    process.exit(1);
  }

  const prep: Prep[] = [];
  let skippedBad = 0;
  let skippedOpen = 0;
  let sumActual = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim() || line[0] !== '{') continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.kind !== 'live_position_close') continue;
    if (typeof e.strategyId === 'string' && e.strategyId !== 'live-oscar') continue;
    const ct = e.closedTrade as Record<string, unknown> | undefined;
    if (!ct || typeof ct.mint !== 'string') continue;
    const net = Number(ct.netPnlUsd ?? 0);
    const pnlPct = Number(ct.pnlPct ?? 0);
    if (!Number.isFinite(net) || Math.abs(net) > 1e6 || !Number.isFinite(pnlPct) || Math.abs(pnlPct) > 5000) {
      skippedBad++;
      continue;
    }
    const src = typeof ct.source === 'string' ? ct.source : '';
    if (!sourceSnapshotTable(src)) {
      skippedOpen++;
      continue;
    }
    let probe: OpenTrade;
    try {
      probe = cloneOpenFromJournal(ct, baseCfg);
    } catch {
      skippedOpen++;
      continue;
    }
    const entryTs = probe.entryTs;
    const exitTs = Number(ct.exitTs ?? 0);
    if (!Number.isFinite(exitTs) || exitTs <= entryTs) {
      skippedOpen++;
      continue;
    }
    const dipStart = entryTs - maxLookbackMin * 60_000;
    const anchorsDip = await fetchPriceAnchorsPg({ mint: probe.mint, source: src, entryTs: dipStart, endTs: entryTs });
    const anchorsExit = await fetchPriceAnchorsPg({ mint: probe.mint, source: src, entryTs, endTs: exitTs });
    if (anchorsExit.length < 2) {
      skippedOpen++;
      continue;
    }
    sumActual += net;
    prep.push({ closedTrade: ct, anchorsExit, anchorsDip, entryTs, exitTs });
  }

  const noGateSum = prep.reduce((s, row) => s + (simTrade(row, cfgExitFixed, dcaLevels, tpLadder, stepMs) ?? 0), 0);

  const results = scenarios.map((sc) => {
    const cfg = mergeCfg(cfgExitFixed, sc.patch);
    const windowsUnion = [...new Set([...cfg.dipLookbackWindowsMin, ...baseCfg.dipLookbackWindowsMin])].sort(
      (a, b) => a - b,
    );
    let sum = 0;
    let passed = 0;
    let failed = 0;
    for (const row of prep) {
      const legs = row.closedTrade.legs as PositionLeg[] | undefined;
      const leg0 = legs?.[0];
      if (!leg0) {
        failed++;
        continue;
      }
      const dipCtx = dipContextFromAnchors(row.entryTs, windowsUnion, row.anchorsDip);
      const rowSnap = syntheticSnapshotRow(row.closedTrade, leg0);
      const dip = evaluateDip(cfg, rowSnap, dipCtx);
      if (dip.reasons.length > 0) {
        failed++;
        continue;
      }
      passed++;
      const v = simTrade(row, cfg, dcaLevels, tpLadder, stepMs);
      if (v != null) sum += v;
    }
    return {
      scenario: sc.id,
      entryPatch: sc.patch,
      tradesPassedGate: passed,
      tradesFailedGate: failed,
      sumSimNetUsdOnPassed: +sum.toFixed(2),
      meanOnPassed: passed ? +(sum / passed).toFixed(3) : null,
      deltaVsNoEntryGateUsd: +(sum - noGateSum).toFixed(2),
    };
  });

  results.sort((a, b) => b.sumSimNetUsdOnPassed - a.sumSimNetUsdOnPassed);

  console.log(
    JSON.stringify(
      {
        journal: abs,
        tradesPrepared: prep.length,
        sumActualJournalNetUsd: +sumActual.toFixed(2),
        fixedExitParams: exitPatch,
        noteRu:
          'Вход: только dip high/low по PG до entryTs; vol/BS/holders не менялись (синтетическая строка). Без гейта: все сделки симятся.',
        sumSimNoEntryGate_allTrades: +noGateSum.toFixed(2),
        skippedCorrupt: skippedBad,
        skippedNoAnchors: skippedOpen,
        rankedEntryScenarios: results,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
