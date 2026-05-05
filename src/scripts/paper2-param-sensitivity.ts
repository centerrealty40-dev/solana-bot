/**
 * Empirical sensitivity: dual-regime TP grid + DCA add fraction on fixed opens + PG anchors.
 *
 *   npx tsx src/scripts/paper2-param-sensitivity.ts --since-hours 48 \
 *     --hold-horizon-hours 96 --jsonl data/live/pt1-oscar-live.jsonl
 *
 * Requires DATABASE_URL (same loader as scenario optimizer).
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

function dualSum(
  rows: ScenarioPrep[],
  args: {
    baseCfg: PaperTraderConfig;
    tpLadder: ReturnType<typeof parseTpLadder>;
    stepMs: number;
    clipHours: number;
    kill: number;
    dcaLevels: ReturnType<typeof parseDcaLevels>;
    preStep: number;
    preSell: number;
    preTimeoutH: number;
    postStep: number;
    postSell: number;
    postTimeoutH: number;
  },
): { sum: number; sumNoDca: number; sumDca: number; nNoDca: number; nDca: number } {
  const {
    baseCfg,
    tpLadder,
    stepMs,
    clipHours,
    kill,
    dcaLevels,
    preStep,
    preSell,
    preTimeoutH,
    postStep,
    postSell,
    postTimeoutH,
  } = args;

  const cfgPre: PaperTraderConfig = {
    ...baseCfg,
    tpGridStepPnl: preStep,
    tpGridSellFraction: preSell,
    trailTriggerX: 1.03,
    trailDrop: 0.08,
    timeoutHours: preTimeoutH,
    dcaKillstop: kill,
  };
  const cfgPost: PaperTraderConfig = {
    ...baseCfg,
    tpGridStepPnl: postStep,
    tpGridSellFraction: postSell,
    trailTriggerX: 1.03,
    trailDrop: 0.08,
    timeoutHours: postTimeoutH,
    dcaKillstop: kill,
  };

  let sum = 0;
  let sumNoDca = 0;
  let sumDca = 0;
  let nNoDca = 0;
  let nDca = 0;

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
    sum += ct.netPnlUsd;
    const nLeg = ct.legs.filter((l) => l.reason === 'dca').length;
    if (nLeg >= 1) {
      sumDca += ct.netPnlUsd;
      nDca++;
    } else {
      sumNoDca += ct.netPnlUsd;
      nNoDca++;
    }
  }
  return { sum, sumNoDca, sumDca, nNoDca, nDca };
}

function baselineSum(
  rows: ScenarioPrep[],
  baseCfg: PaperTraderConfig,
  dcaLevels: ReturnType<typeof parseDcaLevels>,
  tpLadder: ReturnType<typeof parseTpLadder>,
  stepMs: number,
  clipHours: number,
): number {
  let s = 0;
  for (const row of rows) {
    const clipEnd = row.baseOt.entryTs + clipHours * 3_600_000;
    const clipped = row.anchors.filter((a) => a.ts <= clipEnd);
    const use = clipped.length >= 2 ? clipped : row.anchors;
    const ct = simulateLifecycle({
      baseOt: row.baseOt,
      anchors: use,
      cfg: baseCfg,
      dcaLevels,
      tpLadder,
      stepMs,
    });
    if (ct) s += ct.netPnlUsd;
  }
  return s;
}

async function main(): Promise<void> {
  const sinceH = Number(arg('--since-hours') ?? 48);
  const holdH = Number(arg('--hold-horizon-hours') ?? 96);
  const stepMs = Number(arg('--step-ms') ?? 60_000);
  const bufferHours = Number(arg('--buffer-hours') ?? 8);

  const paths = resolveScenarioJsonlPaths();
  if (paths.length === 0) {
    console.error('No jsonl paths.');
    process.exit(1);
  }

  const oscarEnv = pm2Pt1OscarEnv();
  let prodDcaEnv = '';
  const { cfg: baseCfg, tpLadder, prodDca } = withEnvPatch(oscarEnv, () => {
    prodDcaEnv = process.env.PAPER_DCA_LEVELS ?? '';
    return {
      cfg: loadPaperTraderConfig(),
      tpLadder: parseTpLadder(process.env.PAPER_TP_LADDER),
      prodDca: parseDcaLevels(process.env.PAPER_DCA_LEVELS),
    };
  });

  const minNeed = baseCfg.timeoutHours + bufferHours;
  if (holdH < minNeed) {
    console.error(`hold-horizon-hours >= ${minNeed}`);
    process.exit(1);
  }

  const { prepared, skipped } = await loadPaper2ScenarioPrepared({
    paths,
    sinceHours: sinceH,
    holdHorizonHours: holdH,
  });

  const killTune = -0.1;
  const clipHours = holdH;

  console.log(
    `\n=== paper2-param-sensitivity  opens=${sinceH}h PG=${holdH}h  n=${prepared.length} skipped=${skipped} ===`,
  );
  console.log(`Prod PM2 DCA: ${prodDcaEnv || '(parse only)'}  baseline kill: ${baseCfg.dcaKillstop}  tuned kill in dual sweeps: ${killTune}`);
  console.log(
    `\nReference: PM2 baseline (unchanged) sum=$${baselineSum(prepared, baseCfg, prodDca, tpLadder, stepMs, clipHours).toFixed(2)}`,
  );

  console.log('\n--- A) Dual: same step pre=post, sells fixed 35% / 15%, timeouts 12h / 4h ---');
  console.log('stepPre=stepPost | sum      | avg      | sum_noDCA | sum_DCA');
  for (const step of [0.07, 0.075, 0.08, 0.085, 0.09]) {
    const r = dualSum(prepared, {
      baseCfg,
      tpLadder,
      stepMs,
      clipHours,
      kill: killTune,
      dcaLevels: prodDca,
      preStep: step,
      preSell: 0.35,
      preTimeoutH: 12,
      postStep: step,
      postSell: 0.15,
      postTimeoutH: 4,
    });
    const n = r.nNoDca + r.nDca;
    const avg = n > 0 ? r.sum / n : 0;
    console.log(
      `${step.toFixed(3)}           | $${r.sum.toFixed(2).padStart(7)} | ${avg.toFixed(2).padStart(8)} | $${r.sumNoDca.toFixed(2).padStart(8)} | $${r.sumDca.toFixed(2)}`,
    );
  }

  console.log('\n--- B) Dual: step 8% both legs; sweep POST-DCA sell fraction (pre sell 35%) ---');
  console.log('postSell | sum      | avg   | sum_noDCA | sum_DCA');
  for (const postSell of [0.12, 0.15, 0.18, 0.2, 0.25, 0.3]) {
    const r = dualSum(prepared, {
      baseCfg,
      tpLadder,
      stepMs,
      clipHours,
      kill: killTune,
      dcaLevels: prodDca,
      preStep: 0.08,
      preSell: 0.35,
      preTimeoutH: 12,
      postStep: 0.08,
      postSell,
      postTimeoutH: 4,
    });
    const n = r.nNoDca + r.nDca;
    const avg = n > 0 ? r.sum / n : 0;
    console.log(
      `${(postSell * 100).toFixed(0)}%      | $${r.sum.toFixed(2).padStart(7)} | ${avg.toFixed(2).padStart(5)} | $${r.sumNoDca.toFixed(2).padStart(8)} | $${r.sumDca.toFixed(2)}`,
    );
  }

  console.log('\n--- C) Dual: step 8% both; sweep PRE-DCA sell fraction (post sell 18%) ---');
  console.log('preSell | sum      | avg   | sum_noDCA | sum_DCA');
  for (const preSell of [0.25, 0.3, 0.35, 0.4]) {
    const r = dualSum(prepared, {
      baseCfg,
      tpLadder,
      stepMs,
      clipHours,
      kill: killTune,
      dcaLevels: prodDca,
      preStep: 0.08,
      preSell,
      preTimeoutH: 12,
      postStep: 0.08,
      postSell: 0.18,
      postTimeoutH: 4,
    });
    const n = r.nNoDca + r.nDca;
    const avg = n > 0 ? r.sum / n : 0;
    console.log(
      `${(preSell * 100).toFixed(0)}%     | $${r.sum.toFixed(2).padStart(7)} | ${avg.toFixed(2).padStart(5)} | $${r.sumNoDca.toFixed(2).padStart(8)} | $${r.sumDca.toFixed(2)}`,
    );
  }

  console.log('\n--- D) Dual: step 8%/8%, sell 35%/18%; sweep DCA add fraction (single leg −7%) ---');
  console.log('DCA spec   | sum      | avg   | sum_noDCA | sum_DCA');
  for (const add of [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45]) {
    const levels = parseDcaLevels(`-7:${add}`);
    const r = dualSum(prepared, {
      baseCfg,
      tpLadder,
      stepMs,
      clipHours,
      kill: killTune,
      dcaLevels: levels,
      preStep: 0.08,
      preSell: 0.35,
      preTimeoutH: 12,
      postStep: 0.08,
      postSell: 0.18,
      postTimeoutH: 4,
    });
    const n = r.nNoDca + r.nDca;
    const avg = n > 0 ? r.sum / n : 0;
    const label = `-7:${add}`;
    console.log(
      `${label.padEnd(10)} | $${r.sum.toFixed(2).padStart(7)} | ${avg.toFixed(2).padStart(5)} | $${r.sumNoDca.toFixed(2).padStart(8)} | $${r.sumDca.toFixed(2)}`,
    );
  }

  console.log(
    '\nNote: tuned kill=-0.10 throughout sweeps A–D; prod PM2 uses kill=' +
      String(baseCfg.dcaKillstop) +
      '. Grid steps are **PnL fractions** (0.08 = +8% vs avg entry per rung).',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
