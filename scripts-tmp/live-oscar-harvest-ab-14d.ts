/**
 * Live Oscar 14d A/B: legacy v2 hybrid (grid + trail @+10%) vs prod harvest lock (+5% → 50%@+2.5% → flush @avg).
 *
 *   npx tsx scripts-tmp/live-oscar-harvest-ab-14d.ts [jsonl] [days]
 *
 * Entries: live_discovery_eval pass=true, $1000 notional (750+750 split), PG price path, 30m cooldown.
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { sql as dsql } from 'drizzle-orm';
import { db } from '../src/core/db/client.js';
import { loadPaperTraderConfig, parseDcaLevels } from '../src/papertrader/config.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { applyEntryCosts, applyExitCosts } from '../src/papertrader/costs.js';
import type { ClosedTrade, DexId, OpenTrade, PartialSell } from '../src/papertrader/types.js';
import {
  buildLiveStagedEntryState,
  entrySplitBandOk,
  markEntrySplitLeg1Filled,
  pctFromAnchor,
} from '../src/papertrader/executor/live-staged-entry-gates.js';
import { dcaCrossedDownward, dcaEffPrev, dcaStepOrTriggerTaken, markDcaStepFired } from '../src/papertrader/executor/dca-state.js';
import { dcaKillstopEffective, tpGridEffective } from '../src/papertrader/executor/tp-grid-effective.js';
import { cfgEffectiveForOpen } from '../src/papertrader/cfg-effective-for-open.js';
import {
  LADDER_PNL_EPS,
  ladderPnlThresholdMark,
  ladderPnlThresholdTaken,
  markLadderStepFired,
} from '../src/papertrader/executor/tp-ladder-state.js';
import {
  variantAHybridDefensiveTrailActive,
  variantAHybridEvalHarvest,
  variantAHybridHarvestActive,
  variantAHybridMarkTp5Taken,
  variantAHybridMaybeResetTpImpulse,
  variantAHybridResetTpGridOnDca,
  variantAHybridTp5Taken,
  VARIANT_A_V2_HARVEST_HALF_PNL_FRAC,
  VARIANT_A_V2_HARVEST_TP5_PNL_FRAC,
} from '../src/papertrader/executor/exit-policy-variant-a.js';
import {
  waveBOnNewHigh,
  waveBNextTrailLevelToFire,
  waveBMarkTrailLevelTaken,
  waveBTrailSellFractionForRemainder,
  waveBRemainderValueNetUsd,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
} from '../src/papertrader/executor/exit-policy-wave-b.js';
import { buildClosedTradeSim, priceAt } from '../src/scripts/paper2-strategy-backtest.js';

const NOTIONAL_USD = 1000;
const COOLDOWN_MS = 30 * 60_000;
const STEP_MS = 30_000;

const TABLES: Record<string, string> = {
  pumpswap: 'pumpswap_pair_snapshots',
  raydium: 'raydium_pair_snapshots',
  orca: 'orca_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
};

const EMPTY_METRICS: OpenTrade['entryMetrics'] = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

type ExitSimMode = 'legacy_v2_hybrid' | 'prod_harvest_v2';

interface EvalRow {
  ts: number;
  mint: string;
  symbol: string;
  source: string;
  pass: boolean;
}

function applyProdEnv(): void {
  const leg = String(NOTIONAL_USD / 2);
  process.env.PAPER_STRATEGY_ID = 'live-oscar';
  process.env.PAPER_POSITION_USD = String(NOTIONAL_USD);
  process.env.PAPER_LIVE_STAGED_ENTRY_ENABLED = '1';
  process.env.PAPER_LIVE_STAGED_ENTRY_FIRST_LEG_USD = leg;
  process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_LEG_USD = leg;
  process.env.PAPER_LIVE_STAGED_ENTRY_ENTRY_SPLIT_DELAY_MS = '10000';
  process.env.PAPER_LIVE_STAGED_ENTRY_SECOND_LEG_USD = '0';
  process.env.PAPER_LIVE_STAGED_ENTRY_THIRD_LEG_USD = '0';
  process.env.PAPER_DCA_LEVELS = '-10:0.266667,-20:0.266667';
  process.env.PAPER_DCA_KILLSTOP = '0';
  process.env.PAPER_TP_LADDER = '';
  process.env.PAPER_TP_GRID_STEP_PNL = '0.05';
  process.env.PAPER_TP_GRID_SELL_FRACTION = '0.10';
  process.env.PAPER_TP_GRID_SELL_FRACTION_PROFILE = '0';
  process.env.PAPER_TRAIL_MODE = 'peak';
  process.env.PAPER_TRAIL_DROP = '0.12';
  process.env.PAPER_TRAIL_TRIGGER_X = '1.35';
  process.env.PAPER_TIMEOUT_HOURS = '48';
  process.env.PAPER_SL_X = '0';
  process.env.PAPER_LIVE_OSCAR_EXIT_POLICY_VARIANT_A = '1';
  process.env.PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B_TRAIL_SELL_FRACTION = '0.20';
  process.env.PAPER_LIVE_OSCAR_VARIANT_A_SALVAGE24_ENABLED = '1';
  process.env.PAPER_LIVE_OSCAR_VARIANT_A_SMART48_ENABLED = '0';
}

function quoteSqlIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) throw new Error(`unsafe table: ${ident}`);
  return ident;
}

function sqlQuoteMint(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function loadPxSeries(
  mint: string,
  dex: string,
  tMinMs: number,
  tMaxMs: number,
): Promise<{ tsMs: number[]; px: number[] } | null> {
  const src = dex.toLowerCase().trim();
  const table = TABLES[src] ?? TABLES.pumpswap!;
  const t = quoteSqlIdent(table);
  const mintEsc = sqlQuoteMint(mint);
  const fromSec = (tMinMs / 1000).toFixed(3);
  const toSec = (tMaxMs / 1000).toFixed(3);
  const raw = await db.execute(dsql.raw(`
    SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts_ms,
           COALESCE(price_usd, 0)::float AS price_usd
    FROM ${t}
    WHERE base_mint = ${mintEsc}
      AND ts >= to_timestamp(${fromSec}) AT TIME ZONE 'UTC'
      AND ts <= to_timestamp(${toSec}) AT TIME ZONE 'UTC'
      AND COALESCE(price_usd, 0) > 0
    ORDER BY ts ASC
  `));
  const rows = raw as unknown as Array<{ ts_ms: string | bigint; price_usd: number }>;
  if (!rows.length) return null;
  const tsMs: number[] = [];
  const px: number[] = [];
  for (const r of rows) {
    tsMs.push(typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms));
    px.push(r.price_usd);
  }
  return { tsMs, px };
}

function buildOpen(cfg: PaperTraderConfig, row: EvalRow, entryPx: number, dex: DexId): OpenTrade {
  const leg1Usd = cfg.liveStagedEntryFirstLegUsd;
  const { effectivePrice } = applyEntryCosts(cfg, entryPx, dex, leg1Usd, null);
  const ot: OpenTrade = {
    mint: row.mint,
    symbol: row.symbol,
    lane: 'post_migration',
    source: dex === 'meteora' ? 'meteora' : 'pumpswap',
    metricType: 'price',
    dex,
    entryTs: row.ts,
    entryMcUsd: effectivePrice,
    entryMetrics: EMPTY_METRICS,
    peakMcUsd: entryPx,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts: row.ts, price: effectivePrice, marketPrice: entryPx, sizeUsd: leg1Usd, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: leg1Usd,
    avgEntry: effectivePrice,
    avgEntryMarket: entryPx,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    liveExitPolicyId: 'variant_a_v2',
    liveWavePeakPnlFrac: 0,
    liveWaveTrailAnchorPnlFrac: 0,
    liveWaveTrailLevelsTaken: [],
    liveKillstopBelowStreak: 0,
  };
  if (cfg.liveStagedEntryEnabled) {
    ot.liveStagedEntry = buildLiveStagedEntryState(cfg, {
      signalTs: row.ts,
      signalPriceUsd: entryPx,
    });
    markEntrySplitLeg1Filled(ot.liveStagedEntry, ot);
  }
  return ot;
}

function maybeEntrySplitLeg2(cfg: PaperTraderConfig, ot: OpenTrade, t: number, anchors: { ts: number; p: number }[]): void {
  const st = ot.liveStagedEntry;
  if (!st?.entrySplitV2 || st.entrySplitLeg2Done) return;
  const leg1Ts = st.entrySplitLeg1Ts ?? st.signalTs;
  if (t < leg1Ts + (st.entrySplitDelayMs ?? 10_000)) return;
  const px = priceAt(anchors, t);
  if (!(px > 0)) return;
  const anchor = st.entrySplitAnchorUsd ?? st.signalPriceUsd;
  const ch = pctFromAnchor(anchor, px);
  if (ch == null || !entrySplitBandOk(ch, st.entrySplitMaxUpPct ?? 3, st.entrySplitMaxDownPct ?? 10)) return;
  const addUsd = st.entrySplitLegUsd ?? st.firstLegUsd;
  const { effectivePrice } = applyEntryCosts(cfg, px, ot.dex, addUsd, null);
  ot.legs.push({
    ts: t,
    price: effectivePrice,
    marketPrice: px,
    sizeUsd: addUsd,
    reason: 'entry_split',
    triggerPct: ch / 100,
  });
  ot.totalInvestedUsd += addUsd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  st.entrySplitLeg2Done = true;
}

function pushPartialSell(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  curMetric: number;
  sellFraction: number;
  virtualNow: number;
  reason: PartialSell['reason'];
  threshold?: number;
}): void {
  const { cfg, ot, curMetric, sellFraction, virtualNow, reason } = args;
  if (!(sellFraction > 1e-12) || ot.remainingFraction <= 1e-9) return;
  const frac = Math.min(1, sellFraction);
  const marketSellPx = curMetric;
  const investedSoldUsd = ot.totalInvestedUsd * ot.remainingFraction * frac;
  const { effectivePrice: effectiveSell } = applyExitCosts(cfg, marketSellPx, ot.dex, investedSoldUsd, null);
  const remainingValueNet = ot.totalInvestedUsd * ot.remainingFraction * (effectiveSell / ot.avgEntry);
  const proceedsUsd = remainingValueNet * frac;
  const remainingValueGross = ot.totalInvestedUsd * ot.remainingFraction * (marketSellPx / ot.avgEntryMarket);
  const grossProceedsUsd = remainingValueGross * frac;
  ot.partialSells.push({
    ts: virtualNow,
    price: effectiveSell,
    marketPrice: marketSellPx,
    sellFraction: frac,
    reason,
    proceedsUsd,
    grossProceedsUsd,
    pnlUsd: proceedsUsd - investedSoldUsd,
    grossPnlUsd: grossProceedsUsd - investedSoldUsd,
  });
  ot.remainingFraction *= 1 - frac;
  if (args.threshold != null) ladderPnlThresholdMark(ot.ladderUsedLevels, args.threshold);
}

function simStepV2(args: {
  cfg: PaperTraderConfig;
  ot: OpenTrade;
  curMetric: number;
  virtualNow: number;
  dcaLevels: ReturnType<typeof parseDcaLevels>;
  mode: ExitSimMode;
}): { closed: ClosedTrade | null } {
  const { cfg, ot, curMetric, virtualNow, dcaLevels, mode } = args;
  let effCfg = cfgEffectiveForOpen(cfg, ot);
  const ageH = (virtualNow - ot.entryTs) / 3_600_000;
  if (!(curMetric > 0)) {
    if (ageH > effCfg.timeoutHours) {
      return {
        closed: buildClosedTradeSim({
          cfg,
          ot,
          marketSell: 0,
          effectiveSell: 0,
          exitReason: 'NO_DATA',
          ageH,
          exitTs: virtualNow,
        }),
      };
    }
    return { closed: null };
  }

  const firstPrice = ot.legs[0]?.price || ot.entryMcUsd;
  const dropFromFirstPct = curMetric / firstPrice - 1;
  let xAvg = curMetric / ot.avgEntry;
  let pnlPctVsAvg = (xAvg - 1) * 100;
  effCfg = cfgEffectiveForOpen(cfg, ot);
  let tgEff = tpGridEffective(ot, effCfg);
  const pnlFrac = xAvg - 1;
  const harvestActive = mode === 'prod_harvest_v2' && variantAHybridHarvestActive(ot, tgEff.stepPnl);

  if (curMetric > ot.peakMcUsd) {
    ot.peakMcUsd = curMetric;
    ot.peakPnlPct = pnlPctVsAvg;
    if (mode === 'legacy_v2_hybrid') {
      waveBOnNewHigh(ot, pnlFrac, tgEff.stepPnl);
      if (pnlFrac + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) ot.trailingArmed = true;
    }
  }

  const mayDca =
    !ot.liveStagedEntry &&
    !harvestActive &&
    (tgEff.stepPnl <= 0 ||
      ot.partialSells.length === 0 ||
      (mode === 'legacy_v2_hybrid' && !variantAHybridTp5Taken(ot, tgEff.stepPnl))) &&
    dcaLevels.length > 0 &&
    ot.remainingFraction > 0;

  if (mayDca) {
    const effPrevDrop = dcaEffPrev(ot);
    for (let dcaIdx = 0; dcaIdx < dcaLevels.length; dcaIdx++) {
      const lvl = dcaLevels[dcaIdx]!;
      if (dcaStepOrTriggerTaken(ot, dcaIdx, lvl.triggerPct)) continue;
      if (!dcaCrossedDownward(effPrevDrop, dropFromFirstPct, lvl.triggerPct)) continue;
      const addUsd = effCfg.positionUsd * lvl.addFraction;
      const { effectivePrice: effectiveBuy } = applyEntryCosts(cfg, curMetric, ot.dex, addUsd, null);
      ot.legs.push({
        ts: virtualNow,
        price: effectiveBuy,
        marketPrice: curMetric,
        sizeUsd: addUsd,
        reason: 'dca',
        triggerPct: lvl.triggerPct,
      });
      ot.totalInvestedUsd += addUsd;
      ot.avgEntry = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0) / ot.totalInvestedUsd;
      ot.avgEntryMarket = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0) / ot.totalInvestedUsd;
      markDcaStepFired(ot, dcaIdx, lvl.triggerPct);
      variantAHybridResetTpGridOnDca(ot);
      ot.remainingFraction = 1;
      ot.peakPnlPct = (curMetric / ot.avgEntry - 1) * 100;
    }
  }

  xAvg = curMetric / ot.avgEntry;
  pnlPctVsAvg = (xAvg - 1) * 100;
  const pnlFracPost = xAvg - 1;
  effCfg = cfgEffectiveForOpen(cfg, ot);
  tgEff = tpGridEffective(ot, effCfg);
  const harvestActivePost =
    mode === 'prod_harvest_v2' && variantAHybridHarvestActive(ot, tgEff.stepPnl);

  if (!harvestActivePost && tgEff.stepPnl > 0 && ot.remainingFraction > 0) {
    if (mode === 'legacy_v2_hybrid') variantAHybridMaybeResetTpImpulse(ot, pnlFracPost, tgEff.stepPnl);
    const step = tgEff.stepPnl;
    let maxK = Math.floor((pnlFracPost + LADDER_PNL_EPS) / step);
    for (let k = 1; k <= maxK; k++) {
      const threshold = k * step;
      if (ladderPnlThresholdTaken(ot.ladderUsedLevels, threshold)) continue;
      if (pnlFracPost + LADDER_PNL_EPS < threshold) break;
      if (mode === 'prod_harvest_v2' && threshold > VARIANT_A_V2_HARVEST_TP5_PNL_FRAC + LADDER_PNL_EPS) break;
      const sellFraction = Math.min(1, tgEff.sellFractionForStep(k));
      pushPartialSell({
        cfg: effCfg,
        ot,
        curMetric,
        sellFraction,
        virtualNow,
        reason: 'TP_LADDER',
        threshold,
      });
      if (mode === 'prod_harvest_v2' && threshold + LADDER_PNL_EPS >= VARIANT_A_V2_HARVEST_TP5_PNL_FRAC) {
        variantAHybridMarkTp5Taken(ot);
        markLadderStepFired(ot, k - 1, threshold);
        break;
      }
      if (mode === 'legacy_v2_hybrid') {
        markLadderStepFired(ot, k - 1, threshold);
        break;
      }
    }
  }

  if (mode === 'prod_harvest_v2' && variantAHybridHarvestActive(ot, tgEff.stepPnl)) {
    const prev = ot.liveVariantAHybridHarvestPrevPnlFrac ?? pnlFracPost;
    const action = variantAHybridEvalHarvest(ot, cfg, pnlFracPost, prev);
    ot.liveVariantAHybridHarvestPrevPnlFrac = pnlFracPost;
    if (action.kind === 'sell_half') {
      pushPartialSell({
        cfg: effCfg,
        ot,
        curMetric,
        sellFraction: action.sellFraction,
        virtualNow,
        reason: 'HYBRID_HARVEST_HALF',
      });
      ot.liveVariantAHybridHarvestHalfDone = true;
    } else if (action.kind === 'flush_all') {
      const mtm = action.useAvgPrice && ot.avgEntry > 0 ? ot.avgEntry : curMetric;
      pushPartialSell({
        cfg: effCfg,
        ot,
        curMetric: mtm,
        sellFraction: 1,
        virtualNow,
        reason: action.tag === 'hybrid_harvest_gap_flush' ? 'HYBRID_HARVEST_GAP' : 'HYBRID_HARVEST_FLUSH0',
      });
      ot.liveVariantAHybridHarvestComplete = true;
    }
  }

  if (mode === 'legacy_v2_hybrid' && variantAHybridDefensiveTrailActive(ot, tgEff.stepPnl)) {
    const peakFrac = ot.liveWavePeakPnlFrac ?? pnlFracPost;
    if (pnlFracPost < peakFrac - LADDER_PNL_EPS) {
      const anchor = ot.liveWaveTrailAnchorPnlFrac ?? pnlFracPost;
      const level = waveBNextTrailLevelToFire(
        anchor,
        tgEff.stepPnl,
        pnlFracPost,
        ot.liveWaveTrailLevelsTaken ?? [],
        true,
      );
      if (level != null) {
        const remUsd = waveBRemainderValueNetUsd(ot, curMetric);
        const sellFraction = waveBTrailSellFractionForRemainder(remUsd, cfg);
        pushPartialSell({
          cfg: effCfg,
          ot,
          curMetric,
          sellFraction,
          virtualNow,
          reason: 'TRAIL_STEP',
          threshold: level,
        });
        waveBMarkTrailLevelTaken(ot, level);
      }
    }
  }

  let exitReason: ClosedTrade['exitReason'] | null = null;
  if (ot.remainingFraction <= 1e-6) exitReason = 'TP';
  else if (ageH >= effCfg.timeoutHours && mode === 'legacy_v2_hybrid') exitReason = 'TIMEOUT';

  if (exitReason) {
    const investedRemaining = ot.totalInvestedUsd * Math.max(0, ot.remainingFraction);
    const { effectivePrice: effectiveSell } = applyExitCosts(
      cfg,
      curMetric,
      ot.dex,
      Math.max(1, investedRemaining),
      null,
    );
    return {
      closed: buildClosedTradeSim({
        cfg,
        ot,
        marketSell: curMetric,
        effectiveSell,
        exitReason,
        ageH,
        exitTs: virtualNow,
      }),
    };
  }
  return { closed: null };
}

async function simulateTrade(
  cfg: PaperTraderConfig,
  row: EvalRow,
  mode: ExitSimMode,
): Promise<{ netUsd: number | null; exitReason: string | null; exitTs: number | null }> {
  let dex = row.source.toLowerCase();
  if (!TABLES[dex]) dex = 'pumpswap';
  const series = await loadPxSeries(row.mint, dex, row.ts - 60_000, row.ts + (cfg.timeoutHours + 4) * 3_600_000);
  if (!series) return { netUsd: null, exitReason: 'NO_PX', exitTs: null };
  const anchors = series.tsMs.map((ts, i) => ({ ts, p: series.px[i]! }));
  const entryPx = priceAt(anchors, row.ts);
  if (!(entryPx > 0)) return { netUsd: null, exitReason: 'NO_PX', exitTs: null };

  const ot = buildOpen(cfg, row, entryPx, dex as DexId);
  const dcaLevels = parseDcaLevels(cfg.dcaLevelsSpec);
  const endTs = row.ts + (cfg.timeoutHours + 4) * 3_600_000;
  const simEnd = Math.min(endTs, anchors[anchors.length - 1]!.ts + STEP_MS);

  let closed: ClosedTrade | null = null;
  for (let t = row.ts; t <= simEnd; t += STEP_MS) {
    maybeEntrySplitLeg2(cfg, ot, t, anchors);
    const r = simStepV2({ cfg, ot, curMetric: priceAt(anchors, t), virtualNow: t, dcaLevels, mode });
    if (r.closed) {
      closed = r.closed;
      break;
    }
  }
  if (!closed && ot.remainingFraction > 1e-6) {
    const finalT = Math.min(simEnd, anchors[anchors.length - 1]!.ts);
    const curMetric = priceAt(anchors, finalT);
    if (curMetric > 0) {
      const investedRemaining = ot.totalInvestedUsd * ot.remainingFraction;
      const { effectivePrice } = applyExitCosts(cfg, curMetric, ot.dex, Math.max(1, investedRemaining), null);
      closed = buildClosedTradeSim({
        cfg,
        ot,
        marketSell: curMetric,
        effectiveSell: effectivePrice,
        exitReason: 'TIMEOUT',
        ageH: (finalT - ot.entryTs) / 3_600_000,
        exitTs: finalT,
      });
    }
  }
  if (!closed) return { netUsd: null, exitReason: 'NO_CLOSE', exitTs: null };
  return { netUsd: closed.netPnlUsd, exitReason: closed.exitReason, exitTs: Number(closed.exitTs) };
}

async function runMode(
  mode: ExitSimMode,
  evals: EvalRow[],
  opts: { portfolioCooldown: boolean },
): Promise<Record<string, unknown>> {
  applyProdEnv();
  const cfg = loadPaperTraderConfig();
  const mintFreeAfter = new Map<string, number>();
  const pnls: number[] = [];
  const exitMix: Record<string, number> = {};
  let skippedCooldown = 0;
  let skippedNoPx = 0;

  const candidates = evals.filter((e) => e.pass).sort((a, b) => a.ts - b.ts);
  for (const row of candidates) {
    if (opts.portfolioCooldown && row.ts < (mintFreeAfter.get(row.mint) ?? 0)) {
      skippedCooldown++;
      continue;
    }
    const sim = await simulateTrade(cfg, row, mode);
    if (sim.netUsd == null) {
      skippedNoPx++;
      continue;
    }
    pnls.push(sim.netUsd);
    const er = sim.exitReason ?? '?';
    exitMix[er] = (exitMix[er] ?? 0) + 1;
    if (opts.portfolioCooldown) {
      mintFreeAfter.set(row.mint, (sim.exitTs ?? row.ts) + COOLDOWN_MS);
    }
  }

  const sumPnlUsd = +pnls.reduce((s, x) => s + x, 0).toFixed(2);
  const sorted = [...pnls].sort((a, b) => a - b);
  const median =
    sorted.length === 0
      ? null
      : sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  return {
    mode,
    label:
      mode === 'legacy_v2_hybrid'
        ? 'До harvest: v2 сетка +5% (10% rem), trail −5% от хая с +10%, DCA, re-arm'
        : 'Нынешний prod: после TP +5% → 50%@+2.5% → flush @avg, без DCA/trail вниз',
    trades: pnls.length,
    skippedCooldown,
    skippedNoPx,
    sumPnlUsd,
    meanPnlUsd: pnls.length ? +(sumPnlUsd / pnls.length).toFixed(2) : null,
    medianPnlUsd: median != null ? +median.toFixed(2) : null,
    wins: pnls.filter((x) => x > 0).length,
    losses: pnls.filter((x) => x < 0).length,
    winRatePct: pnls.length ? +((100 * pnls.filter((x) => x > 0).length) / pnls.length).toFixed(1) : null,
    exitMix,
  };
}

/** Actual bot opens from journal (real trades), not all eval passes. */
async function loadOpensFromJournal(jsonlPath: string, days: number): Promise<EvalRow[]> {
  const t0 = Date.now() - days * 24 * 3_600_000;
  const out: EvalRow[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('live_position_open')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (Number(o.ts ?? 0) < t0) continue;
    if (o.strategyId && o.strategyId !== 'live-oscar') continue;
    const ot = o.openTrade as Record<string, unknown> | undefined;
    const mint = String(o.mint ?? ot?.mint ?? '');
    if (!mint) continue;
    out.push({
      ts: Number(o.ts),
      mint,
      symbol: String(o.symbol ?? ot?.symbol ?? '?'),
      source: String(ot?.source ?? o.source ?? 'pumpswap'),
      pass: true,
    });
  }
  return out;
}

async function loadEvals(jsonlPath: string, days: number): Promise<EvalRow[]> {
  const t0 = Date.now() - days * 24 * 3_600_000;
  const evals: EvalRow[] = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('live_discovery_eval')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (Number(o.ts ?? 0) < t0) continue;
    if (o.strategyId && o.strategyId !== 'live-oscar') continue;
    evals.push({
      ts: Number(o.ts),
      mint: String(o.mint ?? ''),
      symbol: String(o.symbol ?? '?'),
      source: String(o.source ?? 'pumpswap'),
      pass: o.pass === true,
    });
  }
  return evals;
}

async function main(): Promise<void> {
  const jsonlPath = process.argv[2]?.trim() || path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');
  const days = Math.max(1, Number(process.argv[3] ?? 14) || 14);
  const useEvalPasses = process.argv.includes('--eval-passes');
  const useJournalOpens = !useEvalPasses;
  const evals = useJournalOpens
    ? await loadOpensFromJournal(jsonlPath, days)
    : await loadEvals(jsonlPath, days);

  const portfolioCooldown = useEvalPasses;
  const legacy = await runMode('legacy_v2_hybrid', evals, { portfolioCooldown });
  const prod = await runMode('prod_harvest_v2', evals, { portfolioCooldown });
  const delta = +(prod.sumPnlUsd - legacy.sumPnlUsd).toFixed(2);
  const winner = delta > 0 ? 'prod_harvest_v2' : delta < 0 ? 'legacy_v2_hybrid' : 'tie';

  console.log(
    JSON.stringify(
      {
        methodology: {
          notionalUsdPerTrade: NOTIONAL_USD,
          windowDays: days,
          journal: jsonlPath,
          entries: useJournalOpens
            ? 'live_position_open from journal (actual trades)'
            : 'live_discovery_eval pass=true + 30m cooldown (portfolio)',
          exitSim: 'PG snapshots + 30s steps; costs via applyEntryCosts/applyExitCosts',
          legacy: legacy.label,
          prod: prod.label,
          portfolioCooldown,
          note: portfolioCooldown
            ? 'Cooldown 30m после выхода (как discovery sweep).'
            : 'Каждый journal open симулируется отдельно — одинаковое число сделок в обоих режимах.',
        },
        evalRows: evals.length,
        evalPass: evals.filter((e) => e.pass).length,
        legacy_v2_hybrid: legacy,
        prod_harvest_v2: prod,
        comparison: {
          deltaProdMinusLegacyUsd: delta,
          winner,
          prodBetterPct: legacy.sumPnlUsd !== 0 ? +((100 * delta) / Math.abs(legacy.sumPnlUsd)).toFixed(1) : null,
        },
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
