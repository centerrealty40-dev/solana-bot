/**
 * Counterfactual backtest for one mint: Live Oscar rules (70/30 + 30s scale-in corridor,
 * TP grid, ladder_retrace trail, no DCA) on minute-dense CSV prices from Postgres exports.
 *
 * Usage (from solana-alpha root):
 *   npx tsx src/scripts/live-oscar-mint-counterfactual.ts
 *   npx tsx src/scripts/live-oscar-mint-counterfactual.ts --kill -0.05,-0.06,-0.07 --sell-frac 0.25,0.3,0.35
 *
 * Inputs default to data/tmp/3khm_ps.csv and data/tmp/3khm_me.csv (PumpSwap + Meteora).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PaperTraderConfig, TpLadderLevel } from '../papertrader/config.js';
import { loadPaperTraderConfig, parseDcaLevels, parseTpLadder } from '../papertrader/config.js';
import { applyEntryCosts, applyExitCosts } from '../papertrader/costs.js';
import type { ClosedTrade, DexId, OpenTrade } from '../papertrader/types.js';
import { buildClosedTradeSim, priceAt, simStep, type Anchor } from './paper2-strategy-backtest.js';

const MINT = '3KHMZhpthXuiCcgfTv7vVu9PpEz64KAEURFwi6Lopump';

const EMPTY_METRICS: OpenTrade['entryMetrics'] = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

/** Journal-derived rounds: historical entry time, venue, realized net, invested USD (as traded). */
const ROUNDS: Array<{
  id: number;
  entryTs: number;
  dex: DexId;
  histInvestedUsd: number;
  actualNetUsd: number;
}> = [
  { id: 1, entryTs: 1777842245685, dex: 'pumpswap', histInvestedUsd: 10, actualNetUsd: 1.317358544543941 },
  { id: 2, entryTs: 1777856298938, dex: 'pumpswap', histInvestedUsd: 10, actualNetUsd: -0.005523274355965668 },
  { id: 3, entryTs: 1777865966737, dex: 'pumpswap', histInvestedUsd: 20, actualNetUsd: 0.49706647604285337 },
  { id: 4, entryTs: 1777886348442, dex: 'pumpswap', histInvestedUsd: 52, actualNetUsd: -8.866396752986198 },
  { id: 5, entryTs: 1777895517126, dex: 'meteora', histInvestedUsd: 40, actualNetUsd: 0.34739346507726765 },
];

const SCALE_IN_DELAY_MS = 30_000;
const STEP_MS = 1000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

function loadCsvAnchors(filePath: string): Anchor[] {
  const raw = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const out: Anchor[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!.trim();
    if (!line || (i === 0 && line.toLowerCase().startsWith('ts_ms'))) continue;
    const [tsS, pS] = line.split(',');
    const ts = Number(tsS);
    const p = Number(pS);
    if (!Number.isFinite(ts) || !Number.isFinite(p) || p <= 0) continue;
    out.push({ ts, p });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function applyPaperLiveOscarEnv() {
  process.env.PAPER_POSITION_USD = '40';
  process.env.PAPER_ENTRY_FIRST_LEG_FRACTION = '0.7';
  process.env.PAPER_DCA_LEVELS = '';
  process.env.PAPER_TP_LADDER = '';
  process.env.PAPER_TP_GRID_STEP_PNL = '0.05';
  process.env.PAPER_TP_X = '100';
  process.env.PAPER_SL_X = '0';
  process.env.PAPER_TRAIL_MODE = 'ladder_retrace';
  process.env.PAPER_TRAIL_DROP = '0.10';
  process.env.PAPER_TRAIL_TRIGGER_X = '1.10';
  process.env.PAPER_TIMEOUT_HOURS = '8';
  process.env.PAPER_TP_GRID_FIRST_RUNG_RETRACE_MIN_PNL = '0.025';
  process.env.PAPER_PEAK_LOG_STEP_PCT = '1';
}

function buildOpenFirstLeg(args: {
  cfg: PaperTraderConfig;
  mint: string;
  entryTs: number;
  dex: DexId;
  leg1Usd: number;
  marketPx: number;
}): OpenTrade {
  const { cfg, mint, entryTs, dex, leg1Usd, marketPx } = args;
  const { effectivePrice } = applyEntryCosts(cfg, marketPx, dex, leg1Usd, null);
  return {
    mint,
    symbol: 'BT',
    lane: 'post_migration',
    source: dex === 'meteora' ? 'meteora' : 'pumpswap',
    metricType: 'price',
    dex,
    entryTs,
    entryMcUsd: effectivePrice,
    entryMetrics: EMPTY_METRICS,
    peakMcUsd: marketPx,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [
      {
        ts: entryTs,
        price: effectivePrice,
        marketPrice: marketPx,
        sizeUsd: leg1Usd,
        reason: 'open',
      },
    ],
    partialSells: [],
    totalInvestedUsd: leg1Usd,
    avgEntry: effectivePrice,
    avgEntryMarket: marketPx,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
  };
}

function maybeScaleInSecondLeg(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  scaleTs: number;
  leg2Usd: number;
  anchors: Anchor[];
  corridorUpPct: number;
  corridorDownPct: number;
}): void {
  const { cfg, ot, scaleTs, leg2Usd, anchors, corridorUpPct, corridorDownPct } = args;
  if (!(leg2Usd > 0)) return;
  const anchorMkt = ot.legs[0]!.marketPrice!;
  const p2 = priceAt(anchors, scaleTs);
  if (!(p2 > 0)) return;
  const signedDevPct = (p2 / anchorMkt - 1) * 100;
  const eps = 1e-6;
  const inCorridor =
    signedDevPct <= corridorUpPct + eps && signedDevPct >= -corridorDownPct - eps;
  if (!inCorridor) return;

  const marketBuy = p2;
  const { effectivePrice } = applyEntryCosts(cfg, marketBuy, ot.dex, leg2Usd, null);
  ot.legs.push({
    ts: scaleTs,
    price: effectivePrice,
    marketPrice: marketBuy,
    sizeUsd: leg2Usd,
    reason: 'scale_in',
  });
  ot.totalInvestedUsd += leg2Usd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  ot.remainingFraction = 1;
  if (marketBuy > ot.peakMcUsd) {
    ot.peakMcUsd = marketBuy;
    ot.peakPnlPct = (marketBuy / ot.avgEntry - 1) * 100;
    if (marketBuy / ot.avgEntry >= cfg.trailTriggerX) ot.trailingArmed = true;
  }
}

function simulateRound(args: {
  cfg: PaperTraderConfig;
  round: (typeof ROUNDS)[number];
  anchors: Anchor[];
  corridorUpPct: number;
  corridorDownPct: number;
}): ClosedTrade | null {
  const { cfg, round, anchors, corridorUpPct, corridorDownPct } = args;
  const entryTs = round.entryTs;
  const p0 = priceAt(anchors, entryTs);
  if (!(p0 > 0)) return null;

  const leg1Usd = cfg.positionUsd * cfg.entryFirstLegFraction;
  const leg2Usd = cfg.positionUsd * (1 - cfg.entryFirstLegFraction);
  const ot = buildOpenFirstLeg({
    cfg,
    mint: MINT,
    entryTs,
    dex: round.dex,
    leg1Usd,
    marketPx: p0,
  });

  const dcaLevels = parseDcaLevels(cfg.dcaLevelsSpec);
  const tpLadder: TpLadderLevel[] =
    cfg.tpGridStepPnl > 0 ? [] : parseTpLadder(cfg.tpLadderSpec);
  const peakLog = { lastPersistedPeak: -Infinity };
  const scaleTs = entryTs + SCALE_IN_DELAY_MS;
  let scaleDone = false;

  const lastAnchorTs = anchors.length ? anchors[anchors.length - 1]!.ts : entryTs;

  for (let t = entryTs; t <= lastAnchorTs + STEP_MS; t += STEP_MS) {
    if (!scaleDone && t >= scaleTs) {
      scaleDone = true;
      maybeScaleInSecondLeg({
        cfg,
        ot,
        scaleTs,
        leg2Usd,
        anchors,
        corridorUpPct,
        corridorDownPct,
      });
    }

    const curMetric = priceAt(anchors, t);
    const r = simStep({
      cfg,
      ot,
      curMetric,
      virtualNow: t,
      dcaLevels,
      tpLadder,
      peakLog,
    });
    if (r.closed) return r.closed;
  }

  const finalT = lastAnchorTs;
  const curMetric = priceAt(anchors, finalT);
  const ageH = (finalT - ot.entryTs) / 3_600_000;
  if (curMetric > 0) {
    const marketSell = curMetric;
    const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
    const { effectivePrice: effectiveSell } = applyExitCosts(
      cfg,
      marketSell,
      ot.dex,
      Math.max(1, investedRemaining),
      null,
    );
    return buildClosedTradeSim({
      cfg,
      ot,
      marketSell,
      effectiveSell,
      exitReason: 'TIMEOUT',
      ageH,
      exitTs: finalT,
    });
  }
  return buildClosedTradeSim({
    cfg,
    ot,
    marketSell: 0,
    effectiveSell: 0,
    exitReason: 'NO_DATA',
    ageH,
    exitTs: finalT,
  });
}

function parseNumList(raw: string | undefined): number[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function main() {
  const psCsv = arg('--ps-csv') ?? path.join(process.cwd(), 'data/tmp/3khm_ps.csv');
  const meCsv = arg('--me-csv') ?? path.join(process.cwd(), 'data/tmp/3khm_me.csv');
  const corridorUp = Number(arg('--corridor-up') ?? '1');
  const corridorDown = Number(arg('--corridor-down') ?? '2');

  const killList =
    parseNumList(arg('--kill')).filter((n) => n < 0).length > 0
      ? parseNumList(arg('--kill')).filter((n) => n < 0)
      : [-0.05];
  const sellFracList =
    parseNumList(arg('--sell-frac')).filter((n) => n > 0 && n <= 1).length > 0
      ? parseNumList(arg('--sell-frac')).filter((n) => n > 0 && n <= 1)
      : [0.3];

  if (!fs.existsSync(psCsv)) {
    console.error(`Missing ${psCsv} (export pumpswap_pair_snapshots first)`);
    process.exit(1);
  }
  if (!fs.existsSync(meCsv)) {
    console.error(`Missing ${meCsv} (export meteora_pair_snapshots first)`);
    process.exit(1);
  }

  const psAnchors = loadCsvAnchors(psCsv);
  const meAnchors = loadCsvAnchors(meCsv);

  applyPaperLiveOscarEnv();

  let baseCfg = loadPaperTraderConfig();

  const sumHistActual = ROUNDS.reduce((s, r) => s + r.actualNetUsd, 0);
  const sumScaledActual = ROUNDS.reduce(
    (s, r) => s + (r.actualNetUsd * baseCfg.positionUsd) / r.histInvestedUsd,
    0,
  );

  console.log(`Mint ${MINT}`);
  console.log(`Sum actual (as traded): ${sumHistActual.toFixed(4)} USD`);
  console.log(
    `Sum actual scaled to ${baseCfg.positionUsd} USD notional each round: ${sumScaledActual.toFixed(4)} USD`,
  );
  console.log('');

  for (const kill of killList) {
    for (const sellFrac of sellFracList) {
      process.env.PAPER_DCA_KILLSTOP = String(kill);
      process.env.PAPER_TP_GRID_SELL_FRACTION = String(sellFrac);
      baseCfg = loadPaperTraderConfig();

      console.log(
        `=== kill ${(kill * 100).toFixed(2)}%  |  TP grid sell fraction ${sellFrac}  |  step ${baseCfg.tpGridStepPnl}  |  trail ${baseCfg.trailMode} drop ${baseCfg.trailDrop} ===`,
      );

      let sumSim = 0;
      for (const round of ROUNDS) {
        const anchors = round.dex === 'meteora' ? meAnchors : psAnchors;
        const ct = simulateRound({
          cfg: baseCfg,
          round,
          anchors,
          corridorUpPct: corridorUp,
          corridorDownPct: corridorDown,
        });
        const simNet = ct?.netPnlUsd ?? 0;
        sumSim += simNet;
        const scaledActual = (round.actualNetUsd * baseCfg.positionUsd) / round.histInvestedUsd;
        const legsNote =
          ct === null ? 'NO_PRICE' : `${ct.legs.length} legs (${ct.totalInvestedUsd.toFixed(2)} USD in)`;
        console.log(
          [
            `r${round.id}`,
            `histNet ${round.actualNetUsd.toFixed(4)}`,
            `scaled@${baseCfg.positionUsd}$ ${scaledActual.toFixed(4)}`,
            `simNet ${simNet.toFixed(4)}`,
            `Δ(sim-scaled) ${(simNet - scaledActual).toFixed(4)}`,
            ct ? `${ct.exitReason}` : '',
            ct ? `partials ${ct.partialSells?.length ?? 0}` : '',
            `legs ${legsNote}`,
          ].join(' | '),
        );
      }
      console.log(`SUM sim: ${sumSim.toFixed(4)}  |  SUM scaled actual: ${sumScaledActual.toFixed(4)}  |  Δ ${(sumSim - sumScaledActual).toFixed(4)}`);
      console.log('');
    }
  }
}

main();
