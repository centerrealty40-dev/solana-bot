/**
 * Контрфактический перебор **трейла / ladder-retrace** на всех `live_position_close`
 * из live JSONL: одна и та же ценовая траектория из PG (`price_usd`), разные правила выхода.
 *
 * Использует `simulateLifecycle` / `simStep` из `paper2-strategy-backtest.ts` (тот же порядок,
 * что у трекера, плюс опция `minTpGridPartialsForPeakTrailArm` для arm peak-trail после N частичных TP-grid).
 *
 * Требует `DATABASE_URL`. **`PAPER_*` для симуляции подмешиваются из `ecosystem.config.cjs`**
 * процесса **`live-oscar`** (или `--risky` → `live-oscar-risky`), чтобы совпасть с PM2, а не только с `.env`.
 *
 * Пример (VPS):
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts/live-oscar-trail-scenario-sweep.ts \
 *     --journal data/live/pt1-oscar-live.jsonl --horizon-hours 48 --step-ms 60000
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
import type { LadderRetraceSpec } from '../src/papertrader/executor/tp-ladder-state.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { ExitReason } from '../src/papertrader/types.js';
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

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
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

type Scenario = {
  id: string;
  cfgPatch: Partial<PaperTraderConfig>;
  ladderRetraceSpec?: LadderRetraceSpec;
  minTpGridPartialsForPeakTrailArm?: number;
};

function buildScenarios(gridStep: number): Scenario[] {
  const fiveStepsDrop = Math.min(0.5, gridStep * 5);
  const out: Scenario[] = [
    { id: 'A0_prod_ladder_baseline', cfgPatch: {}, ladderRetraceSpec: { kind: 'baseline' } },
    {
      id: 'A1_ladder_adapt_skip1',
      cfgPatch: {},
      ladderRetraceSpec: { kind: 'adaptive', minPeakSortedIdx: 2, extraSkipRungs: 1 },
    },
    {
      id: 'A2_ladder_adapt_skip2',
      cfgPatch: {},
      ladderRetraceSpec: { kind: 'adaptive', minPeakSortedIdx: 2, extraSkipRungs: 2 },
    },
    {
      id: 'A3_ladder_adapt_skip3',
      cfgPatch: {},
      ladderRetraceSpec: { kind: 'adaptive', minPeakSortedIdx: 2, extraSkipRungs: 3 },
    },
    {
      id: 'A4_ladder_adapt_skip5',
      cfgPatch: {},
      ladderRetraceSpec: { kind: 'adaptive', minPeakSortedIdx: 2, extraSkipRungs: 5 },
    },
  ];
  const peakDrops = [0.03, 0.05, 0.08, 0.1, 0.125, 0.15, 0.2];
  for (const td of peakDrops) {
    out.push({
      id: `B_peak_drop_${(td * 100).toFixed(1).replace('.', '_')}pct_arm2`,
      cfgPatch: {
        trailMode: 'peak',
        trailDrop: td,
        trailTriggerX: 1.02,
      },
      minTpGridPartialsForPeakTrailArm: 2,
    });
  }
  out.push({
    id: `B_peak_drop_${(fiveStepsDrop * 100).toFixed(1)}pct_eq5gridSteps_arm2`,
    cfgPatch: {
      trailMode: 'peak',
      trailDrop: fiveStepsDrop,
      trailTriggerX: 1.02,
    },
    minTpGridPartialsForPeakTrailArm: 2,
  });
  for (const n of [0, 1, 2, 3, 5]) {
    out.push({
      id: `C_peak_drop10pct_armAfter${n}TpPartials`,
      cfgPatch: { trailMode: 'peak', trailDrop: 0.1, trailTriggerX: 1.02 },
      minTpGridPartialsForPeakTrailArm: n,
    });
  }
  return out;
}

type RowAgg = {
  nSim: number;
  sumNet: number;
  exit: Partial<Record<ExitReason, number>>;
  skippedAnchors: number;
};

async function main(): Promise<void> {
  const journal = argStr('--journal', 'data/live/pt1-oscar-live.jsonl');
  const horizonH = argNum('--horizon-hours', 48);
  const stepMs = argNum('--step-ms', 60_000);
  const risky = process.argv.includes('--risky');
  const appName = risky ? 'live-oscar-risky' : 'live-oscar';
  const pmEnv = pm2AppPaperEnv(appName);

  const { baseCfg, dcaLevels, tpLadder } = withEnvPatch(pmEnv, () => ({
    baseCfg: loadPaperTraderConfig(),
    dcaLevels: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
  }));
  const gridStep = baseCfg.tpGridStepPnl > 0 ? baseCfg.tpGridStepPnl : 0.025;
  const scenarios = buildScenarios(gridStep);

  const prep: Array<{ mint: string; closedTrade: Record<string, unknown>; anchors: Anchor[] }> = [];
  let skippedOpen = 0;
  let skippedBad = 0;

  const abs = path.resolve(journal);
  if (!fs.existsSync(abs)) {
    console.error('journal missing', abs);
    process.exit(1);
  }

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
    let probeOt: ReturnType<typeof cloneOpenFromJournal>;
    try {
      probeOt = cloneOpenFromJournal(ct, baseCfg);
    } catch {
      skippedOpen++;
      continue;
    }
    const entryTs = probeOt.entryTs;
    const exitTs = Number(ct.exitTs ?? 0);
    if (!Number.isFinite(exitTs) || exitTs <= entryTs) {
      skippedOpen++;
      continue;
    }
    const endTs = exitTs + horizonH * 3_600_000;
    const anchors = await fetchPriceAnchorsPg({ mint: probeOt.mint, source: src, entryTs, endTs });
    if (anchors.length < 2) {
      skippedOpen++;
      continue;
    }
    prep.push({ mint: probeOt.mint, closedTrade: ct, anchors });
  }

  const agg = new Map<string, RowAgg>();
  for (const s of scenarios) {
    agg.set(s.id, { nSim: 0, sumNet: 0, exit: {}, skippedAnchors: 0 });
  }

  for (const row of prep) {
    for (const s of scenarios) {
      const cfg = mergeCfg(baseCfg, s.cfgPatch);
      let baseOt: ReturnType<typeof cloneOpenFromJournal>;
      try {
        baseOt = cloneOpenFromJournal(row.closedTrade, cfg);
      } catch {
        const a = agg.get(s.id)!;
        a.skippedAnchors++;
        continue;
      }
      const ct = simulateLifecycle({
        baseOt,
        anchors: row.anchors,
        cfg,
        dcaLevels,
        tpLadder,
        stepMs,
        ladderRetraceSpec: s.ladderRetraceSpec,
        minTpGridPartialsForPeakTrailArm: s.minTpGridPartialsForPeakTrailArm,
      });
      const a = agg.get(s.id)!;
      if (!ct) {
        a.skippedAnchors++;
        continue;
      }
      a.nSim++;
      a.sumNet += ct.netPnlUsd;
      const er = ct.exitReason;
      a.exit[er] = (a.exit[er] ?? 0)! + 1;
    }
  }

  const table = scenarios.map((s) => {
    const a = agg.get(s.id)!;
    return {
      scenario: s.id,
      tradesSimulated: a.nSim,
      sumNetPnlUsd: +a.sumNet.toFixed(2),
      meanNetPnlUsd: a.nSim ? +(a.sumNet / a.nSim).toFixed(3) : null,
      exitMix: a.exit,
      skippedNullClose: a.skippedAnchors,
    };
  });

  console.log(
    JSON.stringify(
      {
        journal: abs,
        tradesWithPgPath: prep.length,
        skippedCorruptJournal: skippedBad,
        skippedNoAnchorsOrOpen: skippedOpen,
        horizonHoursPastExit: horizonH,
        stepMs,
        pm2PaperEnvApp: appName,
        baseTpGridStepPnl: baseCfg.tpGridStepPnl,
        baseTpGridSellFraction: baseCfg.tpGridSellFraction,
        baseTrailMode: baseCfg.trailMode,
        baseTrailDrop: baseCfg.trailDrop,
        note: 'Peak scenarios use trailMode=peak + trailDrop from peak; ladder_* use ladder_retrace + ladderRetraceSpec. PG path only (collector cadence).',
        results: table.sort((a, b) => (b.sumNetPnlUsd ?? 0) - (a.sumNetPnlUsd ?? 0)),
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
