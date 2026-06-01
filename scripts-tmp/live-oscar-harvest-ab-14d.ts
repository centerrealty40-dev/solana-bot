/**
 * Live Oscar — честный A/B на закрытых сделках журнала (PG-replay).
 *
 *   npx tsx scripts-tmp/live-oscar-harvest-ab-14d.ts [jsonl] [days] [--notional 100]
 *
 * - Входы: пары open→close за окно (очередь по mint), $100 на позицию (staged 50+50).
 * - Оба режима: `PAPER_TP_GRID_SELL_FRACTION_PROFILE=0` как live (ecosystem.config.cjs).
 * - pre_harvest: v2 grid + trail @+10%, без harvest.
 * - current_prod: то же + harvest (+5% без +10% → 50% @+2.5%, flush @0%).
 * - PG merged, шаг 30s, горизонт 48h; не подставляет фактический exit из journal.
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
  ladderStepOrThresholdTaken,
  markLadderStepFired,
} from '../src/papertrader/executor/tp-ladder-state.js';
import {
  variantAHybridDefensiveTrailActive,
  variantAHybridEvalHarvest,
  variantAHybridHarvestActive,
  variantAHybridMarkTp5Taken,
  variantAHybridNoteReachedPlus10,
  variantAHybridMaybeResetTpImpulse,
  variantAHybridResetTpGridOnDca,
  variantAHybridTp5Taken,
  variantAEvalTimedExit,
  VARIANT_A_V2_HARVEST_HALF_PNL_FRAC,
  VARIANT_A_V2_HARVEST_TP5_PNL_FRAC,
  VARIANT_A_V2_TRAIL_ARM_PNL_FRAC,
} from '../src/papertrader/executor/exit-policy-variant-a.js';
import {
  waveBOnNewHigh,
  waveBNextTrailLevelToFire,
  waveBMarkTrailLevelTaken,
  waveBTrailSellFractionForRemainder,
  waveBRemainderValueNetUsd,
  WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC,
} from '../src/papertrader/executor/exit-policy-wave-b.js';
import { buildClosedTradeSim, priceAt, type Anchor } from '../src/scripts/paper2-strategy-backtest.js';

let NOTIONAL_USD = 100;
const COOLDOWN_MS = 30 * 60_000;
const STEP_MS = 30_000;
const DEX_TRY_ORDER = ['pumpswap', 'raydium', 'meteora', 'orca', 'moonshot'] as const;

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
  /** When set (journal open), sim entry uses bot fill — not only PG @ open ts. */
  priceUsd?: number | null;
  journalInvestedUsd?: number | null;
  journalClosePnlUsd?: number | null;
  journalExitReason?: string | null;
}

function parseNotionalUsd(): number {
  const idx = process.argv.indexOf('--notional');
  if (idx >= 0) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 100;
}

function parseEntriesMode(): 'journal' | 'eval' {
  const eq = process.argv.find((a) => a.startsWith('--entries='));
  if (eq) {
    const v = eq.split('=')[1]?.trim();
    if (v === 'eval' || v === 'journal') return v;
  }
  const idx = process.argv.indexOf('--entries');
  if (idx >= 0) {
    const v = process.argv[idx + 1]?.trim();
    if (v === 'eval' || v === 'journal') return v;
  }
  if (process.argv.includes('--eval-passes')) return 'eval';
  return 'journal';
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
  /** Как live-oscar в ecosystem.config.cjs */
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

async function loadPxSeriesOneDex(
  mint: string,
  dex: string,
  tMinMs: number,
  tMaxMs: number,
): Promise<Anchor[]> {
  const src = dex.toLowerCase().trim();
  const table = TABLES[src];
  if (!table) return [];
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
  const out: Anchor[] = [];
  for (const r of rows) {
    const ts = typeof r.ts_ms === 'bigint' ? Number(r.ts_ms) : Number(r.ts_ms);
    if (ts > 0 && r.price_usd > 0) out.push({ ts, p: r.price_usd });
  }
  return out;
}

/** Merge snapshots from preferred dex + fallbacks (denser path → fewer false early exits). */
async function loadPxAnchors(
  mint: string,
  preferredDex: string,
  tMinMs: number,
  tMaxMs: number,
): Promise<{ anchors: Anchor[]; dexUsed: string; pgLastTs: number | null }> {
  const order = [
    preferredDex.toLowerCase().trim(),
    ...DEX_TRY_ORDER.filter((d) => d !== preferredDex.toLowerCase().trim()),
  ];
  const byTs = new Map<number, number>();
  let dexUsed = 'pumpswap';
  for (const dex of order) {
    const chunk = await loadPxSeriesOneDex(mint, dex, tMinMs, tMaxMs);
    if (chunk.length) dexUsed = dex;
    for (const a of chunk) {
      const prev = byTs.get(a.ts);
      if (prev == null || a.p > 0) byTs.set(a.ts, a.p);
    }
  }
  if (!byTs.size) return { anchors: [], dexUsed, pgLastTs: null };
  const anchors = [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, p]) => ({ ts, p }));
  return { anchors, dexUsed, pgLastTs: anchors[anchors.length - 1]!.ts };
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
  const harvestActive =
    mode === 'prod_harvest_v2' && variantAHybridHarvestActive(ot, tgEff.stepPnl, pnlFrac);

  if (curMetric > ot.peakMcUsd) {
    ot.peakMcUsd = curMetric;
    ot.peakPnlPct = pnlPctVsAvg;
    waveBOnNewHigh(ot, pnlFrac, tgEff.stepPnl);
    variantAHybridNoteReachedPlus10(ot, pnlFrac, tgEff.stepPnl);
    if (pnlFrac + LADDER_PNL_EPS >= WAVE_B_DEFENSIVE_TRAIL_ARM_PNL_FRAC) ot.trailingArmed = true;
  }

  const mayDca =
    !ot.liveStagedEntry &&
    !harvestActive &&
    (tgEff.stepPnl <= 0 ||
      ot.partialSells.length === 0 ||
      !variantAHybridTp5Taken(ot, tgEff.stepPnl)) &&
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
  variantAHybridNoteReachedPlus10(ot, pnlFracPost, tgEff.stepPnl);
  const harvestActivePost =
    mode === 'prod_harvest_v2' && variantAHybridHarvestActive(ot, tgEff.stepPnl, pnlFracPost);

  if (!harvestActivePost && tgEff.stepPnl > 0 && ot.remainingFraction > 0) {
    variantAHybridMaybeResetTpImpulse(ot, pnlFracPost, tgEff.stepPnl);
    const step = tgEff.stepPnl;
    const maxK = Math.floor((pnlFracPost + LADDER_PNL_EPS) / step);
    for (let k = 1; k <= maxK; k++) {
      const threshold = k * step;
      if (ladderStepOrThresholdTaken(ot, k - 1, threshold)) continue;
      if (pnlFracPost + LADDER_PNL_EPS < threshold) break;
      const sellFraction = Math.min(1, tgEff.sellFractionForStep(k));
      if (sellFraction > 1e-12) {
        pushPartialSell({
          cfg: effCfg,
          ot,
          curMetric,
          sellFraction,
          virtualNow,
          reason: 'TP_LADDER',
          threshold,
        });
      }
      markLadderStepFired(ot, k - 1, threshold);
      if (threshold + LADDER_PNL_EPS >= VARIANT_A_V2_HARVEST_TP5_PNL_FRAC) {
        variantAHybridMarkTp5Taken(ot);
      }
      if (sellFraction > 1e-12) break;
    }
  }

  if (mode === 'prod_harvest_v2' && harvestActivePost) {
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

  if (variantAHybridDefensiveTrailActive(ot, tgEff.stepPnl)) {
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
  else if (ot.liveExitPolicyId === 'variant_a_v2') {
    const timedTag = variantAEvalTimedExit(ot, effCfg, pnlFracPost, ageH);
    // timed skip only when harvest armed (not merely tp5 while still >+5%)
    if (timedTag) {
      ot.liveVariantAExitTag = timedTag;
      exitReason = 'TIMEOUT';
    }
  }
  if (!exitReason && ageH >= effCfg.timeoutHours) exitReason = 'TIMEOUT';

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
): Promise<{
  netUsd: number | null;
  exitReason: string | null;
  exitTs: number | null;
  pgSpanHours: number | null;
  simHorizonHours: number;
  debug?: {
    partialCount: number;
    maxPnlPctVsAvg: number;
    totalInvestedUsd: number;
    ageHAtExit: number;
    timedTag: string | null;
  };
}> {
  let dex = row.source.toLowerCase();
  if (!TABLES[dex]) dex = 'pumpswap';
  const horizonMs = (cfg.timeoutHours + 4) * 3_600_000;
  const tMax = row.ts + horizonMs;
  const { anchors, dexUsed, pgLastTs } = await loadPxAnchors(row.mint, dex, row.ts - 60_000, tMax);
  if (!anchors.length) {
    return { netUsd: null, exitReason: 'NO_PX', exitTs: null, pgSpanHours: null, simHorizonHours: cfg.timeoutHours };
  }
  const entryPx =
    row.priceUsd != null && row.priceUsd > 0 ? row.priceUsd : priceAt(anchors, row.ts);
  if (!(entryPx > 0)) {
    return { netUsd: null, exitReason: 'NO_PX', exitTs: null, pgSpanHours: null, simHorizonHours: cfg.timeoutHours };
  }

  const ot = buildOpen(cfg, row, entryPx, dexUsed as DexId);
  const dcaLevels = parseDcaLevels(cfg.dcaLevelsSpec);
  const simEnd = tMax;
  const pgSpanHours =
    pgLastTs != null ? +((pgLastTs - row.ts) / 3_600_000).toFixed(2) : null;

  let closed: ClosedTrade | null = null;
  let maxPnlPctVsAvg = -Infinity;
  let lastPnlFrac = 0;
  for (let t = row.ts; t <= simEnd; t += STEP_MS) {
    maybeEntrySplitLeg2(cfg, ot, t, anchors);
    const px = priceAt(anchors, t);
    if (px > 0 && ot.avgEntry > 0) {
      lastPnlFrac = px / ot.avgEntry - 1;
      maxPnlPctVsAvg = Math.max(maxPnlPctVsAvg, lastPnlFrac * 100);
    }
    const r = simStepV2({ cfg, ot, curMetric: px, virtualNow: t, dcaLevels, mode });
    if (r.closed) {
      closed = r.closed;
      break;
    }
  }
  if (!closed && ot.remainingFraction > 1e-6) {
    const finalT = simEnd;
    const ageH = (finalT - ot.entryTs) / 3_600_000;
    const curMetric = priceAt(anchors, finalT);
    if (curMetric > 0 && ageH >= cfg.timeoutHours) {
      const investedRemaining = ot.totalInvestedUsd * ot.remainingFraction;
      const { effectivePrice } = applyExitCosts(cfg, curMetric, ot.dex, Math.max(1, investedRemaining), null);
      closed = buildClosedTradeSim({
        cfg,
        ot,
        marketSell: curMetric,
        effectiveSell: effectivePrice,
        exitReason: 'TIMEOUT',
        ageH,
        exitTs: finalT,
      });
    }
  }
  if (!closed) return { netUsd: null, exitReason: 'NO_CLOSE', exitTs: null, pgSpanHours, simHorizonHours: cfg.timeoutHours };
  const ageHAtExit = (Number(closed.exitTs) - ot.entryTs) / 3_600_000;
  return {
    netUsd: closed.netPnlUsd,
    exitReason: closed.exitReason,
    exitTs: Number(closed.exitTs),
    pgSpanHours,
    simHorizonHours: cfg.timeoutHours,
    debug: {
      partialCount: ot.partialSells.length,
      maxPnlPctVsAvg: +maxPnlPctVsAvg.toFixed(2),
      totalInvestedUsd: +ot.totalInvestedUsd.toFixed(2),
      ageHAtExit: +ageHAtExit.toFixed(2),
      timedTag: ot.liveVariantAExitTag != null ? String(ot.liveVariantAExitTag) : null,
      tp5Taken: variantAHybridTp5Taken(ot, 0.05),
      everPlus10: ot.liveVariantAHybridEverReachedPlus10 === true,
      harvestArmed: variantAHybridHarvestActive(ot, 0.05, lastPnlFrac),
      harvestComplete: ot.liveVariantAHybridHarvestComplete === true,
      partialsByReason: ot.partialSells.reduce(
        (acc, p) => {
          acc[p.reason] = (acc[p.reason] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    },
  };
}

/** Portfolio pass: какие eval-pass реально «заняли слот» при cooldown (по факту выхода legacy). */
async function freezeEvalEntriesWithLegacyCooldown(
  evals: EvalRow[],
): Promise<EvalRow[]> {
  applyProdEnv();
  const cfg = loadPaperTraderConfig();
  const mintFreeAfter = new Map<string, number>();
  const frozen: EvalRow[] = [];
  const candidates = evals.filter((e) => e.pass).sort((a, b) => a.ts - b.ts);
  for (const row of candidates) {
    if (row.ts < (mintFreeAfter.get(row.mint) ?? 0)) continue;
    const sim = await simulateTrade(cfg, row, 'legacy_v2_hybrid');
    if (sim.netUsd == null) continue;
    frozen.push(row);
    mintFreeAfter.set(row.mint, (sim.exitTs ?? row.ts) + COOLDOWN_MS);
  }
  return frozen;
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
  let skippedNoClose = 0;
  const pgSpanHours: number[] = [];

  const candidates = evals.filter((e) => e.pass).sort((a, b) => a.ts - b.ts);
  for (const row of candidates) {
    if (opts.portfolioCooldown && row.ts < (mintFreeAfter.get(row.mint) ?? 0)) {
      skippedCooldown++;
      continue;
    }
    const sim = await simulateTrade(cfg, row, mode);
    if (sim.pgSpanHours != null) pgSpanHours.push(sim.pgSpanHours);
    if (sim.netUsd == null) {
      if (sim.exitReason === 'NO_CLOSE') skippedNoClose++;
      else skippedNoPx++;
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
  const capWin = NOTIONAL_USD * 3;
  const capLoss = -NOTIONAL_USD;
  const sumPnlUsdCapped = +pnls
    .reduce((s, x) => s + Math.max(capLoss, Math.min(capWin, x)), 0)
    .toFixed(2);
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
        ? 'До harvest: v2 grid profile=0, trail с +10%, DCA до +5%, без harvest'
        : 'Текущий prod: profile=0 + harvest (+5% без +10% → 50%@+2.5%, flush @0%)',
    trades: pnls.length,
    skippedCooldown,
    skippedNoPx,
    skippedNoClose,
    pgSpanHoursMedian:
      pgSpanHours.length === 0
        ? null
        : +[...pgSpanHours].sort((a, b) => a - b)[Math.floor(pgSpanHours.length / 2)]!.toFixed(2),
    sumPnlUsd,
    sumPnlUsdCapped,
    meanPnlUsd: pnls.length ? +(sumPnlUsd / pnls.length).toFixed(2) : null,
    medianPnlUsd: median != null ? +median.toFixed(2) : null,
    wins: pnls.filter((x) => x > 0).length,
    losses: pnls.filter((x) => x < 0).length,
    winRatePct: pnls.length ? +((100 * pnls.filter((x) => x > 0).length) / pnls.length).toFixed(1) : null,
    exitMix,
  };
}

/** Закрытые сделки за окно: open→close по очереди на mint (как в live). */
async function loadClosedTradesFromJournal(
  jsonlPath: string,
  days: number,
): Promise<{ entries: EvalRow[]; journalSumUsd: number; journalScaledToNotionalUsd: number }> {
  const t0 = Date.now() - days * 24 * 3_600_000;
  const openQueue = new Map<string, EvalRow[]>();
  const entries: EvalRow[] = [];
  let journalSumUsd = 0;
  let journalScaledToNotionalUsd = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('live_position_open') && !line.includes('live_position_close')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.strategyId && o.strategyId !== 'live-oscar') continue;
    const mint = String(o.mint ?? '');
    if (!mint) continue;

    if (o.kind === 'live_position_open') {
      const ot = o.openTrade as Record<string, unknown> | undefined;
      const legs = ot?.legs as Array<Record<string, unknown>> | undefined;
      const leg0 = legs?.[0];
      const entryMkt =
        typeof leg0?.marketPrice === 'number'
          ? leg0.marketPrice
          : typeof leg0?.price === 'number'
            ? leg0.price
            : typeof ot?.avgEntryMarket === 'number'
              ? ot.avgEntryMarket
              : null;
      const row: EvalRow = {
        ts: Number(o.ts),
        mint,
        symbol: String(o.symbol ?? ot?.symbol ?? '?'),
        source: String(ot?.source ?? o.source ?? 'pumpswap'),
        pass: true,
        priceUsd: entryMkt,
        journalInvestedUsd: typeof ot?.totalInvestedUsd === 'number' ? ot.totalInvestedUsd : null,
      };
      const q = openQueue.get(mint) ?? [];
      q.push(row);
      openQueue.set(mint, q);
      continue;
    }

    if (o.kind !== 'live_position_close') continue;
    const closeTs = Number(o.ts ?? 0);
    if (closeTs < t0) continue;
    const q = openQueue.get(mint);
    const open = q?.shift();
    if (!open || open.ts >= closeTs) continue;
    const ct = (o.closedTrade ?? {}) as Record<string, unknown>;
    const pnl = Number(ct.netPnlUsd ?? NaN);
    const invested = open.journalInvestedUsd ?? Number(ct.totalInvestedUsd ?? NaN);
    open.journalClosePnlUsd = Number.isFinite(pnl) ? pnl : null;
    open.journalExitReason = String(ct.exitReason ?? '?');
    entries.push(open);
    if (Number.isFinite(pnl)) {
      journalSumUsd += pnl;
      if (Number.isFinite(invested) && invested > 0) {
        journalScaledToNotionalUsd += pnl * (NOTIONAL_USD / invested);
      }
    }
  }

  entries.sort((a, b) => a.ts - b.ts);
  return {
    entries,
    journalSumUsd: +journalSumUsd.toFixed(2),
    journalScaledToNotionalUsd: +journalScaledToNotionalUsd.toFixed(2),
  };
}

/** Opens only (без фильтра close) — для --audit. */
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
    const legs = ot?.legs as Array<Record<string, unknown>> | undefined;
    const leg0 = legs?.[0];
    const entryMkt =
      typeof leg0?.marketPrice === 'number'
        ? leg0.marketPrice
        : typeof leg0?.price === 'number'
          ? leg0.price
          : typeof ot?.avgEntryMarket === 'number'
            ? ot.avgEntryMarket
            : null;
    out.push({
      ts: Number(o.ts),
      mint,
      symbol: String(o.symbol ?? ot?.symbol ?? '?'),
      source: String(ot?.source ?? o.source ?? 'pumpswap'),
      pass: true,
      priceUsd: entryMkt,
      journalInvestedUsd: typeof ot?.totalInvestedUsd === 'number' ? ot.totalInvestedUsd : null,
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
      priceUsd: typeof o.priceUsd === 'number' ? o.priceUsd : null,
    });
  }
  return evals;
}

async function harvestCohortSummary(simEntries: EvalRow[]): Promise<Record<string, unknown>> {
  applyProdEnv();
  const cfg = loadPaperTraderConfig();
  let never5 = 0;
  let hit5not10 = 0;
  let hit10plus = 0;
  let tp5 = 0;
  let sawPlus10 = 0;
  let harvestFlush = 0;
  let trueHarvestCohort = 0;
  const partialTotals: Record<string, number> = {};

  for (const row of simEntries) {
    const sim = await simulateTrade(cfg, row, 'prod_harvest_v2');
    const d = sim.debug;
    if (!d) continue;
    if (d.maxPnlPctVsAvg < 5 - 0.01) never5++;
    else if (d.maxPnlPctVsAvg < 10 - 0.01) hit5not10++;
    else hit10plus++;
    if (d.tp5Taken) tp5++;
    if (d.everPlus10) sawPlus10++;
    if (d.harvestComplete) harvestFlush++;
    const pr = d.partialsByReason ?? {};
    if (d.tp5Taken && !d.everPlus10 && (pr.HYBRID_HARVEST_HALF || d.harvestComplete)) {
      trueHarvestCohort++;
    }
    for (const [k, v] of Object.entries(pr)) {
      partialTotals[k] = (partialTotals[k] ?? 0) + v;
    }
  }

  return {
    neverReachedPlus5: never5,
    hit5Never10_byMaxPnl: hit5not10,
    hit10Plus_byMaxPnl: hit10plus,
    tp5Marked: tp5,
    everReachedPlus10_noHarvest: sawPlus10,
    trueHarvestCohort_tp5never10: trueHarvestCohort,
    harvestFlushComplete: harvestFlush,
    partialEventsByReason: partialTotals,
    note: 'trueHarvestCohort = tp5 и не было +10% и сработал harvest (не grid-only).',
  };
}

async function runLegacyAudit(simEntries: EvalRow[]): Promise<void> {
  applyProdEnv();
  const cfg = loadPaperTraderConfig();
  let noPartials = 0;
  let peak5NoPartials = 0;
  let exit24h = 0;
  let exit48h = 0;
  const samples: Record<string, unknown>[] = [];

  for (const row of simEntries.filter((e) => e.pass)) {
    const sim = await simulateTrade(cfg, row, 'legacy_v2_hybrid');
    if (sim.netUsd == null || !sim.debug) continue;
    const d = sim.debug;
    if (d.partialCount === 0) noPartials++;
    if (d.partialCount === 0 && d.maxPnlPctVsAvg >= 5) peak5NoPartials++;
    if (d.ageHAtExit >= 23.5 && d.ageHAtExit < 25) exit24h++;
    if (d.ageHAtExit >= 47.5) exit48h++;
    if (samples.length < 5 && d.partialCount === 0 && d.maxPnlPctVsAvg >= 10) {
      samples.push({
        symbol: row.symbol,
        mint: row.mint.slice(0, 10),
        simPnlUsd: sim.netUsd,
        journalInvestedUsd: row.journalInvestedUsd,
        ...d,
        timedTag: d.timedTag,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        audit: 'legacy_v2_hybrid',
        trades: simEntries.length,
        legacyNoPartialsBeforeExit: noPartials,
        legacyPeak5pctButNoPartials: peak5NoPartials,
        legacyExitNear24h: exit24h,
        legacyExitNear48h: exit48h,
        samplesPeakButNoTp: samples,
        whyLosses:
          'peak5NoPartials = PG path had +5% vs avg but sim took zero TP (bug or grid blocked). exit24h = salvage24 timed cut.',
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  NOTIONAL_USD = parseNotionalUsd();
  const jsonlPath = process.argv[2]?.trim() || path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');
  const days = Math.max(1, Number(process.argv[3] ?? 14) || 14);

  if (process.argv.includes('--audit')) {
    const simEntries = await loadOpensFromJournal(jsonlPath, days);
    await runLegacyAudit(simEntries);
    return;
  }

  const { entries: simEntries, journalSumUsd, journalScaledToNotionalUsd } =
    await loadClosedTradesFromJournal(jsonlPath, days);
  const legacy = await runMode('legacy_v2_hybrid', simEntries, { portfolioCooldown: false });
  const prod = await runMode('prod_harvest_v2', simEntries, { portfolioCooldown: false });
  const delta = +(prod.sumPnlUsd - legacy.sumPnlUsd).toFixed(2);
  const deltaCapped = +((prod.sumPnlUsdCapped as number) - (legacy.sumPnlUsdCapped as number)).toFixed(2);
  const winnerBySum = delta > 0 ? 'current_prod' : delta < 0 ? 'pre_harvest' : 'tie';
  const winnerByCapped =
    deltaCapped > 0 ? 'current_prod' : deltaCapped < 0 ? 'pre_harvest' : 'tie';

  console.log(
    JSON.stringify(
      {
        setup: {
          notionalUsdPerTrade: NOTIONAL_USD,
          closedTradesInWindow: simEntries.length,
          windowDays: days,
          entries: 'journal open→close pairs (FIFO per mint)',
          pricePath: 'PG snapshots merged, 30s steps, 48h horizon',
          entryPrice: 'journal fill when available, else PG @ open',
          tpGridProfileBoth: '0 (same as ecosystem live-oscar)',
          onlyDiff: 'current_prod adds harvest on +5% without +10%',
        },
        journal_actual: {
          sumPnlUsd: journalSumUsd,
          sumPnlScaledToNotionalUsd: journalScaledToNotionalUsd,
          note: 'Фактические close из jsonl; scaled = PnL × (notional / invested)',
        },
        harvestCohort: await harvestCohortSummary(simEntries),
        pre_harvest_no_harvest: {
          ...legacy,
          tradesSimulated: legacy.trades,
        },
        current_prod_with_harvest: {
          ...prod,
          tradesSimulated: prod.trades,
        },
        comparison: {
          winnerBySumPnlUsd: winnerBySum,
          winnerBySumPnlUsdCapped: winnerByCapped,
          winnerByMedianPnlUsd:
            (prod.medianPnlUsd ?? 0) > (legacy.medianPnlUsd ?? 0) ? 'current_prod' : 'pre_harvest',
          deltaCurrentMinusPreHarvestUsd: delta,
          deltaCappedUsd: deltaCapped,
          deltaPerTradeUsd: legacy.trades > 0 ? +(delta / (legacy.trades as number)).toFixed(2) : null,
        },
        disclaimer:
          'PG-replay, не копия journal exit. Одинаковые входы, $100, один TP profile. Harvest только +5% без +10%.',
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
