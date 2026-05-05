/**
 * Compare PM2 baseline vs **switching TP-grid params after first simulated DCA leg**
 * vs always-aggressive vs always-tight grid (same forward PG sim as other paper2 scripts).
 *
 *   npx tsx src/scripts/paper2-dual-regime-compare.ts --since-hours 48 \
 *     --hold-horizon-hours 96 --jsonl data/live/pt1-oscar-live.jsonl
 *
 * Optional: `--dca-levels "-5:0.25"` overrides `PAPER_DCA_LEVELS` for this run only.
 * `--detail` — exitReason histogram + PnL conditional on simulated DCA.
 */
import type { PaperTraderConfig } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import {
  loadPaper2ScenarioPrepared,
  pm2Pt1OscarEnv,
  resolveScenarioJsonlPaths,
  withEnvPatch,
  type ScenarioPrep,
} from './paper2-scenario-tp-trail-optimize.js';
import { simulateLifecycle } from './paper2-strategy-backtest.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

/** Knobs from shallow vs deep bucket search (scenario optimizer); kill unified here for apples-to-apples. */
function aggressiveCfg(base: PaperTraderConfig, kill: number): PaperTraderConfig {
  return {
    ...base,
    tpGridStepPnl: 0.09,
    tpGridSellFraction: 0.35,
    trailTriggerX: 1.03,
    trailDrop: 0.08,
    timeoutHours: 12,
    dcaKillstop: kill,
  };
}

function tightCfg(base: PaperTraderConfig, kill: number): PaperTraderConfig {
  return {
    ...base,
    tpGridStepPnl: 0.075,
    tpGridSellFraction: 0.15,
    trailTriggerX: 1.03,
    trailDrop: 0.08,
    timeoutHours: 4,
    dcaKillstop: kill,
  };
}

type ModeStats = {
  sum: number;
  n: number;
  wins: number;
  dcaLegsSimGe1: number;
  exitCounts: Record<string, number>;
  /** Conditional on simulated ≥1 DCA leg */
  sumGivenDcaSim: number;
  nGivenDcaSim: number;
  /** No simulated DCA leg */
  sumGivenNoDcaSim: number;
  nGivenNoDcaSim: number;
};

function runMode(
  rows: ScenarioPrep[],
  args: {
    mode: 'baseline' | 'agg_only' | 'tight_only' | 'dual';
    baseCfg: PaperTraderConfig;
    dcaLevels: ReturnType<typeof parseDcaLevels>;
    tpLadder: ReturnType<typeof parseTpLadder>;
    stepMs: number;
    clipHours: number;
    killUnified: number;
  },
): ModeStats {
  const { baseCfg, dcaLevels, tpLadder, stepMs, clipHours, killUnified, mode } = args;
  const cfgPre =
    mode === 'baseline'
      ? baseCfg
      : mode === 'agg_only'
        ? aggressiveCfg(baseCfg, killUnified)
        : mode === 'tight_only'
          ? tightCfg(baseCfg, killUnified)
          : aggressiveCfg(baseCfg, killUnified);
  const cfgPost = mode === 'dual' ? tightCfg(baseCfg, killUnified) : undefined;

  let sum = 0;
  let n = 0;
  let wins = 0;
  let dcaLegsSimGe1 = 0;
  const exitCounts: Record<string, number> = {};
  let sumGivenDcaSim = 0;
  let nGivenDcaSim = 0;
  let sumGivenNoDcaSim = 0;
  let nGivenNoDcaSim = 0;

  for (const row of rows) {
    const clipEnd = row.baseOt.entryTs + clipHours * 3_600_000;
    const clipped = row.anchors.filter((a) => a.ts <= clipEnd);
    const use = clipped.length >= 2 ? clipped : row.anchors;
    const ct = simulateLifecycle({
      baseOt: row.baseOt,
      anchors: use,
      cfg: cfgPre,
      cfgAfterDca: cfgPost,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (!ct) continue;
    n++;
    sum += ct.netPnlUsd;
    if (ct.netPnlUsd > 0) wins++;
    const er = String(ct.exitReason);
    exitCounts[er] = (exitCounts[er] ?? 0) + 1;
    const nDcaLegs = ct.legs.filter((l) => l.reason === 'dca').length;
    if (nDcaLegs >= 1) {
      dcaLegsSimGe1++;
      sumGivenDcaSim += ct.netPnlUsd;
      nGivenDcaSim++;
    } else {
      sumGivenNoDcaSim += ct.netPnlUsd;
      nGivenNoDcaSim++;
    }
  }

  return {
    sum,
    n,
    wins,
    dcaLegsSimGe1,
    exitCounts,
    sumGivenDcaSim,
    nGivenDcaSim,
    sumGivenNoDcaSim,
    nGivenNoDcaSim,
  };
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function printModeLine(mode: string, r: ModeStats): void {
  const wr = r.n > 0 ? ((100 * r.wins) / r.n).toFixed(1) : '0.0';
  const avg = r.n > 0 ? r.sum / r.n : 0;
  console.log(
    `  ${mode.padEnd(12)} sum=$${r.sum.toFixed(2)}  avg=$${avg.toFixed(2)}  win%=${wr}  sim_DCA≥1: ${r.dcaLegsSimGe1}/${r.n}`,
  );
}

function printDetail(mode: string, r: ModeStats): void {
  console.log(`\n  [${mode}] exitReason × trades:`);
  const keys = Object.keys(r.exitCounts).sort((a, b) => r.exitCounts[b]! - r.exitCounts[a]!);
  for (const k of keys) {
    console.log(`    ${k}: ${r.exitCounts[k]}`);
  }
  if (r.nGivenNoDcaSim > 0) {
    console.log(
      `    subset no_sim_DCA: n=${r.nGivenNoDcaSim} sum=$${r.sumGivenNoDcaSim.toFixed(2)} avg=$${(r.sumGivenNoDcaSim / r.nGivenNoDcaSim).toFixed(2)}`,
    );
  }
  if (r.nGivenDcaSim > 0) {
    console.log(
      `    subset sim_DCA≥1: n=${r.nGivenDcaSim} sum=$${r.sumGivenDcaSim.toFixed(2)} avg=$${(r.sumGivenDcaSim / r.nGivenDcaSim).toFixed(2)}`,
    );
  }
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 48);
  const holdHorizonH = Number(arg('--hold-horizon-hours') ?? 96);
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);
  const dcaOverride = arg('--dca-levels');
  const wantDetail = flag('--detail');

  const paths = resolveScenarioJsonlPaths();
  if (paths.length === 0) {
    console.error('No jsonl paths.');
    process.exit(1);
  }

  const oscarEnv = pm2Pt1OscarEnv();
  const { cfg: baseCfg, tpLadder, prodDca } = withEnvPatch(oscarEnv, () => {
    if (dcaOverride) process.env.PAPER_DCA_LEVELS = dcaOverride;
    return {
      cfg: loadPaperTraderConfig(),
      tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
      prodDca: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    };
  });

  const minNeed = baseCfg.timeoutHours + bufferHours;
  if (holdHorizonH < minNeed) {
    console.error(`hold-horizon-hours >= ${minNeed}`);
    process.exit(1);
  }

  const { prepared, skipped } = await loadPaper2ScenarioPrepared({
    paths,
    sinceHours: sinceH,
    holdHorizonHours: holdHorizonH,
  });

  const killPm2 = baseCfg.dcaKillstop;
  const killSweepBest = -0.1;

  /** Same PG window for every row/strategy — exits still enforced inside `simulateLifecycle`. */
  const clipHours = holdHorizonH;

  console.log(`\n=== Dual-regime TP grid compare (${sinceH}h opens, horizon ${holdHorizonH}h, n=${prepared.length}, skipped=${skipped}) ===`);
  if (dcaOverride) console.log(`DCA override: ${dcaOverride}`);
  console.log(`Anchor clip: ${clipHours}h for all modes (fair comparison).\n`);

  const modes = ['baseline', 'agg_only', 'tight_only', 'dual'] as const;

  console.log(`--- Kill = PM2 (${killPm2}) ---`);
  for (const mode of modes) {
    const r = runMode(prepared, {
      mode,
      baseCfg,
      dcaLevels: prodDca,
      tpLadder,
      stepMs,
      clipHours,
      killUnified: killPm2,
    });
    printModeLine(mode, r);
    if (wantDetail) printDetail(mode, r);
  }

  console.log(`\n--- Kill = ${killSweepBest} (prior coarse sweep on this pipeline) — tuned modes only ---`);
  for (const mode of modes) {
    if (mode === 'baseline') {
      const r = runMode(prepared, {
        mode: 'baseline',
        baseCfg,
        dcaLevels: prodDca,
        tpLadder,
        stepMs,
        clipHours,
        killUnified: killPm2,
      });
      console.log(`  ${mode.padEnd(12)} sum=$${r.sum.toFixed(2)}  (PM2 kill unchanged)`);
      if (wantDetail) printDetail(mode, r);
      continue;
    }
    const r = runMode(prepared, {
      mode,
      baseCfg,
      dcaLevels: prodDca,
      tpLadder,
      stepMs,
      clipHours,
      killUnified: killSweepBest,
    });
    printModeLine(mode, r);
    if (wantDetail) printDetail(mode, r);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
