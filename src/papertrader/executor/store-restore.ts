import fs from 'node:fs';
import { resolveReconcileOrphanReentryGateMeta, type LastExitMarketSnapshot } from '../discovery/dip-clones.js';
import type { OpenTrade, PartialSell, PositionLeg } from '../types.js';
import { markFollowupCompleted } from './followup.js';
import {
  ensureLiveOscarExitPolicyPinned,
  isWaveBExitPolicy,
  waveBMarkTrailLevelTaken,
  waveBOnTpGridRungExecuted,
  waveBReconcileMaxExecutedTpFromMarks,
  WAVE_B_FLAT_TP_HALF8_RUNNER,
  WAVE_B_V1_TP_GRID,
} from './exit-policy-wave-b.js';
import { ladderPnlThresholdMark } from './tp-ladder-state.js';
import { reconcileEntrySplitV2FromLegs } from './live-staged-entry-gates.js';
import { loadPaperTraderConfig } from '../config.js';
import { applyCanonicalStagedEntrySizing } from '../live-oscar-entry-sizing.js';
import { applyWaveBPostTp1ScratchJournalLine } from './wave-b-post-tp1-scratch-reentry.js';
import { reconcileE2OpenOnRestore } from './live-oscar-e2-open-reconcile.js';
import { resolveOpenMapKey, runnerProbeOpenMapKey } from '../live-oscar-runner-probe.js';
import { runnerLiteOpenMapKey } from '../live-oscar-runner-lite.js';

function ladderRememberLevel(used: Set<number>, pnlPct: number): void {
  ladderPnlThresholdMark(used, pnlPct);
}

/** Mirror `entryLegSignaturesFromOpenTradeJson` (live replay) — avoid importing live/replay (cycle). */
function entryLegSignaturesFromRestorePayload(raw: Record<string, unknown>): string[] {
  const el = raw.entryLegSignatures;
  const out: string[] = [];
  if (Array.isArray(el)) {
    for (const x of el) {
      if (typeof x === 'string' && x.length >= 32) out.push(x);
    }
  }
  if (out.length > 0) return out;
  const legacyPrimary = raw.repairedFromTxSignature;
  if (typeof legacyPrimary === 'string' && legacyPrimary.length >= 32) out.push(legacyPrimary);
  const legs = raw.repairedLegSignatures;
  if (Array.isArray(legs)) {
    for (const x of legs) {
      if (typeof x === 'string' && x.length >= 32) out.push(x);
    }
  }
  return out;
}

export interface RestoreState {
  evaluatedAt: Map<string, number>;
  lastEntryTsByMint: Map<string, number>;
  /** Последний убыточный exit по mint (replay журнала). */
  /** Max `exitTs` (ms) per mint after a full `close` — used for post-exit buy cooldown. */
  lastPostExitBuyCooldownTsByMint: Map<string, number>;
  /** Last full-exit market snapshot per mint — post-exit re-entry gate (dip / cooldown). */
  lastExitMarketSnapshotByMint: Map<string, LastExitMarketSnapshot>;
  /** Non-admin ledger exits only — canonical re-entry gate reference. */
  lastRealExitMarketSnapshotByMint: Map<string, LastExitMarketSnapshot>;
  open: Map<string, OpenTrade>;
}

/**
 * 1.11.167: безопасный coerce числа из произвольного входа. `Number(undefined)`
 * возвращает `NaN`, а `JSON.stringify(NaN) === 'null'` → партиал-селлы выглядели
 * с `sellFraction: null` в JSONL, что ломало downstream-аналитику. `coerceNum0`
 * приводит к 0 любые `NaN`/`Infinity`/нечисловые значения.
 */
function coerceNum0(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mapPartialSell(p: Record<string, unknown>): PartialSell {
  const solL =
    typeof p.solProceedsLamports === 'string' && /^\d+$/.test(p.solProceedsLamports)
      ? p.solProceedsLamports
      : undefined;
  const src = p.proceedsUsdSource;
  const proceedsUsdSource =
    src === 'chain_sol' || src === 'jupiter_quote' || src === 'model'
      ? (src as PartialSell['proceedsUsdSource'])
      : undefined;
  const priceN = coerceNum0(p.price);
  /** 1.11.168: optional retro-leakage поля — pass-through если есть. */
  const piRaw = p.priceImpactPct;
  const piNum = typeof piRaw === 'number' ? piRaw : Number(piRaw);
  const priceImpactPct = Number.isFinite(piNum) && piNum >= 0 && piNum <= 1 ? piNum : undefined;
  const slipRaw = p.slipRealizedPct;
  const slipNum = typeof slipRaw === 'number' ? slipRaw : Number(slipRaw);
  const slipRealizedPct = Number.isFinite(slipNum) ? slipNum : undefined;
  return {
    ts: coerceNum0(p.ts),
    price: priceN,
    marketPrice: coerceNum0(p.marketPrice ?? priceN),
    sellFraction: coerceNum0(p.sellFraction),
    reason: (p.reason ?? 'TP_LADDER') as PartialSell['reason'],
    proceedsUsd: coerceNum0(p.proceedsUsd),
    grossProceedsUsd: coerceNum0(p.grossProceedsUsd),
    pnlUsd: coerceNum0(p.pnlUsd),
    grossPnlUsd: coerceNum0(p.grossPnlUsd),
    ...(solL ? { solProceedsLamports: solL } : {}),
    ...(proceedsUsdSource ? { proceedsUsdSource } : {}),
    ...(priceImpactPct != null ? { priceImpactPct } : {}),
    ...(slipRealizedPct != null ? { slipRealizedPct } : {}),
  };
}

/** JSON snapshot → `OpenTrade` (paper JSONL `open` rows + Phase 7 live mirror events). */
export function restoreOpenTradeFromJson(o: Partial<OpenTrade> & { mint: string }): OpenTrade | null {
  try {
    const rawPartials = Array.isArray(o.partialSells) ? o.partialSells : [];
    const partialSells: PartialSell[] = rawPartials.map((p) =>
      mapPartialSell(
        typeof p === 'object' && p !== null ? (p as unknown as Record<string, unknown>) : {},
      ),
    );

    const ot: OpenTrade = {
      mint: o.mint,
      symbol: o.symbol ?? '?',
      lane: (o.lane ?? 'post_migration') as OpenTrade['lane'],
      source: o.source,
      metricType: (o.metricType ?? 'price') as OpenTrade['metricType'],
      dex: (o.dex ?? 'raydium') as OpenTrade['dex'],
      entryTs: Number(o.entryTs ?? Date.now()),
      entryMcUsd: Number(o.entryMcUsd ?? 0),
      entryMarketCapUsd:
        typeof o.entryMarketCapUsd === 'number' && Number(o.entryMarketCapUsd) > 0
          ? Number(o.entryMarketCapUsd)
          : null,
      entryMetrics: o.entryMetrics ?? {
        uniqueBuyers: 0,
        uniqueSellers: 0,
        sumBuySol: 0,
        sumSellSol: 0,
        topBuyerShare: 0,
        bcProgress: 0,
      },
      peakMcUsd: Number(o.peakMcUsd ?? o.entryMcUsd ?? 0),
      peakPnlPct: Number(o.peakPnlPct ?? 0),
      ...(typeof o.peakPnlPctAnchor === 'number' && Number.isFinite(o.peakPnlPctAnchor)
        ? { peakPnlPctAnchor: Number(o.peakPnlPctAnchor) }
        : {}),
      trailingArmed: Boolean(o.trailingArmed ?? false),
      legs: Array.isArray(o.legs)
        ? o.legs.map((l) => ({
            ts: Number(l.ts),
            price: Number(l.price),
            marketPrice: Number(l.marketPrice ?? l.price),
            sizeUsd: Number(l.sizeUsd),
            reason: (l.reason ?? 'open') as 'open' | 'dca' | 'scale_in',
            triggerPct: l.triggerPct,
          }))
        : [],
      partialSells,
      totalInvestedUsd: Number(o.totalInvestedUsd ?? 0),
      avgEntry: Number(o.avgEntry ?? o.entryMcUsd ?? 0),
      avgEntryMarket: Number(o.avgEntryMarket ?? o.entryMcUsd ?? 0),
      remainingFraction: Number(o.remainingFraction ?? 1),
      dcaUsedLevels: new Set<number>(Array.isArray(o.dcaUsedLevels) ? (o.dcaUsedLevels as number[]) : []),
      dcaUsedIndices: new Set<number>(
        Array.isArray((o as unknown as { dcaUsedIndices?: number[] }).dcaUsedIndices)
          ? (o as unknown as { dcaUsedIndices: number[] }).dcaUsedIndices
          : [],
      ),
      ladderUsedLevels: new Set<number>(
        Array.isArray(o.ladderUsedLevels) ? (o.ladderUsedLevels as number[]) : [],
      ),
      ladderUsedIndices: new Set<number>(
        Array.isArray((o as unknown as { ladderUsedIndices?: number[] }).ladderUsedIndices)
          ? (o as unknown as { ladderUsedIndices: number[] }).ladderUsedIndices
          : [],
      ),
      pairAddress:
        o.pairAddress != null && String(o.pairAddress).trim() ? String(o.pairAddress) : null,
      entryLiqUsd:
        typeof o.entryLiqUsd === 'number' && Number(o.entryLiqUsd) > 0 ? Number(o.entryLiqUsd) : null,
      entryVol1hUsd:
        typeof o.entryVol1hUsd === 'number' && Number(o.entryVol1hUsd) > 0 ? Number(o.entryVol1hUsd) : null,
      lastObservedPriceUsd:
        typeof o.lastObservedPriceUsd === 'number' && Number(o.lastObservedPriceUsd) > 0
          ? Number(o.lastObservedPriceUsd)
          : undefined,
    };
    const rawPayload = o as unknown as Record<string, unknown>;
    const mergedSigs = entryLegSignaturesFromRestorePayload(rawPayload);
    if (mergedSigs.length > 0) {
      ot.entryLegSignatures = mergedSigs;
    }
    const lam = (o as unknown as { liveAnchorMode?: unknown }).liveAnchorMode;
    if (lam === 'chain' || lam === 'simulate') {
      ot.liveAnchorMode = lam;
    } else if (!ot.liveAnchorMode && mergedSigs.length > 0) {
      ot.liveAnchorMode = 'chain';
    }
    if (!ot.totalInvestedUsd) ot.totalInvestedUsd = ot.legs.reduce((s, l) => s + l.sizeUsd, 0);

    const lsei = rawPayload.liveStagedEntry;
    if (lsei != null && typeof lsei === 'object') {
      const p = lsei as Record<string, unknown>;
      const signalTs = Number(p.signalTs);
      const signalPriceUsd = Number(p.signalPriceUsd);
      const firstDropPct = Number(p.firstDropPct);
      const firstLegUsd = Number(p.firstLegUsd);
      const secondDropPct = Number(p.secondDropPct);
      const secondLegUsd = Number(p.secondLegUsd);
      const thirdDropPct = Number(p.thirdDropPct);
      const thirdLegUsd = Number(p.thirdLegUsd);
      const killDropPct = Number(p.killDropPct);
      const isV2EntrySplit = p.entrySplitV2 === true;
      const secondLegUsdOk =
        Number.isFinite(secondLegUsd) && (isV2EntrySplit ? secondLegUsd >= 0 : secondLegUsd > 0);
      if (
        Number.isFinite(signalTs) &&
        signalTs > 0 &&
        signalPriceUsd > 0 &&
        Number.isFinite(firstDropPct) &&
        Number.isFinite(firstLegUsd) &&
        firstLegUsd > 0 &&
        Number.isFinite(secondDropPct) &&
        secondLegUsdOk &&
        Number.isFinite(killDropPct)
      ) {
        ot.liveStagedEntry = {
          signalTs,
          signalPriceUsd,
          firstDropPct,
          firstLegUsd,
          secondDropPct,
          secondLegUsd,
          ...(Number.isFinite(thirdDropPct) && Number.isFinite(thirdLegUsd) && thirdLegUsd > 0
            ? { thirdDropPct, thirdLegUsd }
            : {}),
          killDropPct,
          ...(p.mintFirstProbe === true ? { mintFirstProbe: true } : {}),
          secondLegDone: Boolean(p.secondLegDone),
          thirdLegDone: Boolean(p.thirdLegDone),
          ...(p.entrySplitV2 === true
            ? {
                entrySplitV2: true,
                entrySplitLegUsd: Number(p.entrySplitLegUsd) || firstLegUsd,
                entrySplitLeg2Usd:
                  Number(p.entrySplitLeg2Usd) ||
                  Number(p.entrySplitLegUsd) ||
                  firstLegUsd,
                entrySplitLeg3Usd: Number.isFinite(Number(p.entrySplitLeg3Usd))
                  ? Number(p.entrySplitLeg3Usd)
                  : 0,
                entrySplitLeg4Usd: Number.isFinite(Number(p.entrySplitLeg4Usd))
                  ? Number(p.entrySplitLeg4Usd)
                  : 0,
                entrySplitLeg5Usd: Number.isFinite(Number(p.entrySplitLeg5Usd))
                  ? Number(p.entrySplitLeg5Usd)
                  : 0,
                entrySplitLeg6Usd: Number.isFinite(Number(p.entrySplitLeg6Usd))
                  ? Number(p.entrySplitLeg6Usd)
                  : 0,
                entrySplitLeg7Usd: Number.isFinite(Number(p.entrySplitLeg7Usd))
                  ? Number(p.entrySplitLeg7Usd)
                  : 0,
                entrySplitLeg8Usd: Number.isFinite(Number(p.entrySplitLeg8Usd))
                  ? Number(p.entrySplitLeg8Usd)
                  : 0,
                entrySplitTargetDropPct: Number.isFinite(Number(p.entrySplitTargetDropPct))
                  ? Number(p.entrySplitTargetDropPct)
                  : 0,
                entrySplitDelayMs: Number(p.entrySplitDelayMs) || 10_000,
                entrySplitMaxUpPct: Number(p.entrySplitMaxUpPct) || 3,
                entrySplitMaxDownPct: Number(p.entrySplitMaxDownPct) || 10,
                entrySplitAnchorUsd: Number(p.entrySplitAnchorUsd) || signalPriceUsd,
                entrySplitLeg1Ts: Number(p.entrySplitLeg1Ts) || signalTs,
                entrySplitLeg2Done: Boolean(p.entrySplitLeg2Done),
                entrySplitLeg3Done: Boolean(p.entrySplitLeg3Done),
                entrySplitLeg4Done: Boolean(p.entrySplitLeg4Done),
                entrySplitLeg5Done: Boolean(p.entrySplitLeg5Done),
                entrySplitLeg6Done: Boolean(p.entrySplitLeg6Done),
                entrySplitLeg7Done: Boolean(p.entrySplitLeg7Done),
                entrySplitLeg8Done: Boolean(p.entrySplitLeg8Done),
                entrySplitLeg2Ts: Number.isFinite(Number(p.entrySplitLeg2Ts)) ? Number(p.entrySplitLeg2Ts) : undefined,
                entrySplitLeg3Ts: Number.isFinite(Number(p.entrySplitLeg3Ts)) ? Number(p.entrySplitLeg3Ts) : undefined,
                entrySplitLeg4Ts: Number.isFinite(Number(p.entrySplitLeg4Ts)) ? Number(p.entrySplitLeg4Ts) : undefined,
                entrySplitLeg5Ts: Number.isFinite(Number(p.entrySplitLeg5Ts)) ? Number(p.entrySplitLeg5Ts) : undefined,
                entrySplitLeg6Ts: Number.isFinite(Number(p.entrySplitLeg6Ts)) ? Number(p.entrySplitLeg6Ts) : undefined,
                entrySplitLeg7Ts: Number.isFinite(Number(p.entrySplitLeg7Ts)) ? Number(p.entrySplitLeg7Ts) : undefined,
                entrySplitLeg8Ts: Number.isFinite(Number(p.entrySplitLeg8Ts)) ? Number(p.entrySplitLeg8Ts) : undefined,
                avgSecondDropPct: Number(p.avgSecondDropPct) || secondDropPct,
                avgSecondLegUsd: Number(p.avgSecondLegUsd) || secondLegUsd,
                avgThirdDropPct: Number.isFinite(thirdDropPct) ? thirdDropPct : undefined,
                avgThirdLegUsd: Number.isFinite(thirdLegUsd) ? thirdLegUsd : undefined,
                avgFirstCooldownMs: Number(p.avgFirstCooldownMs) || 180_000,
                avgSecondCooldownMs: Number(p.avgSecondCooldownMs) || 300_000,
                avgFirstLegDone: Boolean(p.avgFirstLegDone ?? p.secondLegDone),
                avgSecondLegDone: Boolean(p.avgSecondLegDone ?? p.thirdLegDone),
                avgFirstLegTs: Number.isFinite(Number(p.avgFirstLegTs)) ? Number(p.avgFirstLegTs) : undefined,
                avgSplitV2: Boolean(p.avgSplitV2),
                avgSplitLeg2Usd: Number.isFinite(Number(p.avgSplitLeg2Usd)) ? Number(p.avgSplitLeg2Usd) : undefined,
                avgSplitLeg3Usd: Number.isFinite(Number(p.avgSplitLeg3Usd)) ? Number(p.avgSplitLeg3Usd) : undefined,
                avgSplitLeg4Usd: Number.isFinite(Number(p.avgSplitLeg4Usd)) ? Number(p.avgSplitLeg4Usd) : undefined,
                avgSplitLeg2Done: Boolean(p.avgSplitLeg2Done),
                avgSplitLeg3Done: Boolean(p.avgSplitLeg3Done),
                avgSplitLeg4Done: Boolean(p.avgSplitLeg4Done),
                avgSplitLeg2Ts: Number.isFinite(Number(p.avgSplitLeg2Ts)) ? Number(p.avgSplitLeg2Ts) : undefined,
                avgSplitLeg3Ts: Number.isFinite(Number(p.avgSplitLeg3Ts)) ? Number(p.avgSplitLeg3Ts) : undefined,
                avgSplitLeg4Ts: Number.isFinite(Number(p.avgSplitLeg4Ts)) ? Number(p.avgSplitLeg4Ts) : undefined,
              }
            : {}),
        };
        if (rawPayload.liveMintFirstProbe === true || p.mintFirstProbe === true) {
          ot.liveMintFirstProbe = true;
          const k = Number(rawPayload.liveMintFirstProbeKillDropPct ?? p.killDropPct);
          if (Number.isFinite(k) && k > 0) ot.liveMintFirstProbeKillDropPct = k;
        }
      }
    }

    const lpsi = rawPayload.livePendingScaleIn;
    if (lpsi != null && typeof lpsi === 'object') {
      const p = lpsi as Record<string, unknown>;
      const anchorMarketUsd = Number(p.anchorMarketUsd);
      const secondLegUsd = Number(p.secondLegUsd);
      const executeAfterTs = Number(p.executeAfterTs);
      const legacySym = Number(p.corridorPct);
      const upRaw = Number(p.corridorUpPct);
      const downRaw = Number(p.corridorDownPct);
      let corridorUpPct: number;
      let corridorDownPct: number;
      if (Number.isFinite(upRaw) && upRaw > 0 && Number.isFinite(downRaw) && downRaw > 0) {
        corridorUpPct = upRaw;
        corridorDownPct = downRaw;
      } else if (Number.isFinite(legacySym) && legacySym > 0) {
        corridorUpPct = legacySym;
        corridorDownPct = legacySym;
      } else {
        corridorUpPct = 0;
        corridorDownPct = 0;
      }
      const maxSwapAttempts = Number(p.maxSwapAttempts);
      if (
        anchorMarketUsd > 0 &&
        secondLegUsd > 0 &&
        Number.isFinite(executeAfterTs) &&
        corridorUpPct > 0 &&
        corridorDownPct > 0 &&
        Number.isFinite(maxSwapAttempts) &&
        maxSwapAttempts >= 1
      ) {
        ot.livePendingScaleIn = {
          anchorMarketUsd,
          secondLegUsd,
          executeAfterTs,
          corridorUpPct,
          corridorDownPct,
          maxSwapAttempts: Math.floor(maxSwapAttempts),
          swapAttempts: Math.max(0, Math.floor(Number(p.swapAttempts ?? 0))),
          nextAttemptAfterTs: Math.max(0, Number(p.nextAttemptAfterTs ?? 0)),
        };
      }
    }

    const tpReg = rawPayload.tpRegime;
    if (tpReg === 'unknown' || tpReg === 'up' || tpReg === 'down' || tpReg === 'sideways') {
      ot.tpRegime = tpReg;
    }
    const tpFeat = rawPayload.tpRegimeFeatures;
    if (tpFeat != null && typeof tpFeat === 'object') {
      const f = tpFeat as Record<string, unknown>;
      ot.tpRegimeFeatures = {
        netMovePct: Number(f.netMovePct ?? 0),
        rangePct: Number(f.rangePct ?? 0),
        sampleCount: Number(f.sampleCount ?? 0),
        table: f.table != null && String(f.table).trim() ? String(f.table) : null,
      };
    }
    const tpOv = rawPayload.tpGridOverrides;
    if (tpOv != null && typeof tpOv === 'object') {
      const g = tpOv as Record<string, unknown>;
      const overrides: NonNullable<OpenTrade['tpGridOverrides']> = {};
      if (g.gridStepPnl != null && Number.isFinite(Number(g.gridStepPnl))) {
        overrides.gridStepPnl = Number(g.gridStepPnl);
      }
      if (g.gridSellFraction != null && Number.isFinite(Number(g.gridSellFraction))) {
        overrides.gridSellFraction = Number(g.gridSellFraction);
      }
      if (Array.isArray(g.gridSellFractionByStep) && g.gridSellFractionByStep.length > 0) {
        overrides.gridSellFractionByStep = g.gridSellFractionByStep
          .map((x) => Number(x))
          .filter((x) => Number.isFinite(x))
          .map((x) => Math.min(1, Math.max(0, x)));
      }
      if (g.gridMaxRungs != null && Number.isFinite(Number(g.gridMaxRungs))) {
        overrides.gridMaxRungs = Math.floor(Number(g.gridMaxRungs));
      }
      if (
        g.gridFirstRungRetraceMinPnlPct != null &&
        Number.isFinite(Number(g.gridFirstRungRetraceMinPnlPct))
      ) {
        overrides.gridFirstRungRetraceMinPnlPct = Number(g.gridFirstRungRetraceMinPnlPct);
      }
      if (Object.keys(overrides).length > 0) ot.tpGridOverrides = overrides;
    }

    const dk = rawPayload.dynamicKillstopShadow;
    if (dk != null && typeof dk === 'object') {
      const d = dk as Record<string, unknown>;
      if (d.version === 'dynamic-killstop-shadow-v1' && typeof d.status === 'string' && typeof d.reason === 'string') {
        ot.dynamicKillstopShadow = dk as OpenTrade['dynamicKillstopShadow'];
      }
    }

    const lep = rawPayload.liveExitProfileMode;
    if (lep === 'A' || lep === 'B') ot.liveExitProfileMode = lep;

    const lkbs = rawPayload.liveKillstopBelowStreak;
    if (typeof lkbs === 'number' && Number.isFinite(lkbs) && lkbs >= 1) {
      ot.liveKillstopBelowStreak = Math.min(255, Math.floor(lkbs));
    }

    if (Boolean(rawPayload.liveBreakevenTrimDone)) {
      ot.liveBreakevenTrimDone = true;
    }
    if (Boolean(rawPayload.liveWaveBreakevenInsuranceTaken)) {
      ot.liveWaveBreakevenInsuranceTaken = true;
    }
    if (Boolean(rawPayload.liveWavePreArmNoHalf8PartialTaken)) {
      ot.liveWavePreArmNoHalf8PartialTaken = true;
    }
    const lpts = rawPayload.livePendingTpSell;
    if (lpts != null && typeof lpts === 'object') {
      const p = lpts as Record<string, unknown>;
      const reason = p.reason;
      const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : '';
      const sellFraction = Number(p.sellFraction ?? NaN);
      const retryUntilTs = Number(p.retryUntilTs ?? NaN);
      const createdTs = Number(p.createdTs ?? NaN);
      const updatedTs = Number(p.updatedTs ?? NaN);
      const ladderStepIndex = Number(p.ladderStepIndex ?? NaN);
      const ladderRungsTotal = Number(p.ladderRungsTotal ?? 0);
      const ladderPnlPct = Number(p.ladderPnlPct ?? NaN);
      const triggerPnlFrac = Number(p.triggerPnlFrac ?? ladderPnlPct);
      const protectBelowPnlFrac = Number(p.protectBelowPnlFrac ?? 0);
      if (
        id &&
        (reason === 'TP_LADDER' ||
          reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL' ||
          reason === 'WAVE_B_DIP10_FIRST_TP5_PARTIAL') &&
        sellFraction > 0 &&
        sellFraction <= 1 &&
        Number.isFinite(retryUntilTs) &&
        retryUntilTs > 0 &&
        Number.isFinite(ladderStepIndex) &&
        Number.isFinite(ladderPnlPct)
      ) {
        ot.livePendingTpSell = {
          id,
          createdTs: Number.isFinite(createdTs) && createdTs > 0 ? createdTs : retryUntilTs,
          updatedTs: Number.isFinite(updatedTs) && updatedTs > 0 ? updatedTs : retryUntilTs,
          retryUntilTs,
          attempts: Math.max(0, Math.floor(Number(p.attempts ?? 0))),
          sellFraction,
          reason,
          ladderStepIndex: Math.floor(ladderStepIndex),
          ladderRungsTotal: Number.isFinite(ladderRungsTotal) ? Math.max(0, Math.floor(ladderRungsTotal)) : 0,
          ladderPnlPct,
          tpGrid: Boolean(p.tpGrid),
          logLabelPct: typeof p.logLabelPct === 'string' && p.logLabelPct.trim() ? p.logLabelPct.trim() : String(reason),
          timelineLabelRu:
            typeof p.timelineLabelRu === 'string' && p.timelineLabelRu.trim()
              ? p.timelineLabelRu.trim()
              : undefined,
          triggerPnlFrac: Number.isFinite(triggerPnlFrac) ? triggerPnlFrac : ladderPnlPct,
          protectBelowPnlFrac: Number.isFinite(protectBelowPnlFrac) ? protectBelowPnlFrac : 0,
          terminalKind:
            p.terminalKind === 'sim_err' ||
            p.terminalKind === 'send_failed' ||
            p.terminalKind === 'confirm_timeout' ||
            p.terminalKind === 'preflight' ||
            p.terminalKind === 'other'
              ? p.terminalKind
              : undefined,
          terminalMessage: typeof p.terminalMessage === 'string' ? p.terminalMessage.slice(0, 400) : undefined,
        };
      }
    }
    if (Boolean(rawPayload.liveWaveDip10ReachedBeforeTp8)) {
      ot.liveWaveDip10ReachedBeforeTp8 = true;
    }
    if (Boolean(rawPayload.liveWaveDip10FirstTp5PartialTaken)) {
      ot.liveWaveDip10FirstTp5PartialTaken = true;
    }
    if (Boolean(rawPayload.liveE2Dip10BackfillAttempted)) {
      ot.liveE2Dip10BackfillAttempted = true;
    }
    if (Boolean(rawPayload.liveWavePostTp1DeriskTaken)) {
      ot.liveWavePostTp1DeriskTaken = true;
    }
    if (Boolean(rawPayload.liveWavePostTp1ScratchTaken)) {
      ot.liveWavePostTp1ScratchTaken = true;
    }
    if (rawPayload.liveWaveFlatTpMode === 'half8_runner' || rawPayload.liveWaveFlatTpMode === 'flat') {
      ot.liveWaveFlatTpMode = rawPayload.liveWaveFlatTpMode;
    }
    const ltve = rawPayload.liveThinVolEntryVol5mUsd;
    if (typeof ltve === 'number' && Number.isFinite(ltve) && ltve > 0) ot.liveThinVolEntryVol5mUsd = ltve;
    const ltvs = rawPayload.liveThinVolStreak;
    if (typeof ltvs === 'number' && Number.isFinite(ltvs) && ltvs >= 0) ot.liveThinVolStreak = ltvs;
    if (Boolean(rawPayload.liveThinVolFlushDone)) ot.liveThinVolFlushDone = true;
    const vwb = rawPayload.volWatchBaselineUsd;
    if (typeof vwb === 'number' && Number.isFinite(vwb) && vwb > 0) ot.volWatchBaselineUsd = vwb;
    const vwc = rawPayload.volWatchCollapseSinceTs;
    if (typeof vwc === 'number' && Number.isFinite(vwc) && vwc > 0) ot.volWatchCollapseSinceTs = vwc;

    const lepi = rawPayload.liveExitPolicyId;
    if (
      lepi === 'legacy_grid' ||
      lepi === 'wave_b_v1' ||
      lepi === 'variant_a_v1' ||
      lepi === 'variant_a_v2' ||
      lepi === 'variant_a_v3' ||
      lepi === 'scalp_wave_v1' ||
      lepi === 'runner_probe_v1' ||
      lepi === 'runner_lite_v1' ||
      lepi === 'preset_c_scalp_v1' ||
      lepi === 'fast_dip_scalp_v1'
    ) {
      ot.liveExitPolicyId = lepi;
    }
    const lomt = rawPayload.liveOscarMcapTier;
    if (lomt === 'micro' || lomt === 'low' || lomt === 'prod' || lomt === 'scalp_wave') {
      ot.liveOscarMcapTier = lomt;
    }
    const lotl = rawPayload.liveOscarTradeLane;
    if (
      lotl === 'prod' ||
      lotl === 'scalp_wave' ||
      lotl === 'runner_probe' ||
      lotl === 'runner_lite' ||
      lotl === 'fast_dip_scalp'
    ) {
      ot.liveOscarTradeLane = lotl;
    }
    const ps = rawPayload.positionSource;
    if (ps === 'runner_probe') ot.positionSource = 'runner_probe';
    else if (ps === 'runner_lite') ot.positionSource = 'runner_lite';
    else if (ot.liveOscarTradeLane === 'runner_probe' || ot.liveExitPolicyId === 'runner_probe_v1') {
      ot.positionSource = 'runner_probe';
    } else if (ot.liveOscarTradeLane === 'runner_lite' || ot.liveExitPolicyId === 'runner_lite_v1') {
      ot.positionSource = 'runner_lite';
    }

    if (Boolean(rawPayload.liveVariantAScratchHadTp)) ot.liveVariantAScratchHadTp = true;
    if (Boolean(rawPayload.liveVariantAScratchFlushedAtZero)) ot.liveVariantAScratchFlushedAtZero = true;
    const lvsp = rawPayload.liveVariantAScratchPrevPnlFrac;
    if (typeof lvsp === 'number' && Number.isFinite(lvsp)) ot.liveVariantAScratchPrevPnlFrac = lvsp;
    const lvsk = rawPayload.liveVariantAScratchPeakPnlFrac;
    if (typeof lvsk === 'number' && Number.isFinite(lvsk)) ot.liveVariantAScratchPeakPnlFrac = lvsk;

    const lvrp = rawPayload.liveVariantARemainderPeakPnlFrac;
    if (typeof lvrp === 'number' && Number.isFinite(lvrp)) ot.liveVariantARemainderPeakPnlFrac = lvrp;
    if (Boolean(rawPayload.liveVariantATrailArmed)) ot.liveVariantATrailArmed = true;
    if (Boolean(rawPayload.liveVariantASmart48Extended)) ot.liveVariantASmart48Extended = true;
    if (Boolean(rawPayload.liveVariantASalvage24Checked)) ot.liveVariantASalvage24Checked = true;
    if (Boolean(rawPayload.liveVariantAH48Checked)) ot.liveVariantAH48Checked = true;

    const lwmet = rawPayload.liveWaveMaxExecutedTpFrac;
    if (typeof lwmet === 'number' && Number.isFinite(lwmet)) ot.liveWaveMaxExecutedTpFrac = lwmet;
    if (rawPayload.liveWavePreArmReached === true) ot.liveWavePreArmReached = true;
    if (rawPayload.liveWaveImpulseBelowFirstRung === true) ot.liveWaveImpulseBelowFirstRung = true;

    const lwp = rawPayload.liveWavePeakPnlFrac;
    if (typeof lwp === 'number' && Number.isFinite(lwp)) ot.liveWavePeakPnlFrac = lwp;

    const lwa = rawPayload.liveWaveTrailAnchorPnlFrac;
    if (typeof lwa === 'number' && Number.isFinite(lwa)) ot.liveWaveTrailAnchorPnlFrac = lwa;

    const lwt = rawPayload.liveWaveTrailLevelsTaken;
    if (Array.isArray(lwt)) {
      ot.liveWaveTrailLevelsTaken = lwt
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x));
    }

    const dlap = rawPayload.dcaLastEvalPnlVsAvgFrac;
    if (typeof dlap === 'number' && Number.isFinite(dlap)) {
      ot.dcaLastEvalPnlVsAvgFrac = dlap;
    }

    const lps = rawPayload.lastPartialSellTs;
    if (typeof lps === 'number' && Number.isFinite(lps) && lps > 0) {
      ot.lastPartialSellTs = lps;
    } else if (partialSells.length > 0) {
      const lastTs = partialSells[partialSells.length - 1]!.ts;
      if (Number.isFinite(lastTs) && lastTs > 0) ot.lastPartialSellTs = lastTs;
    }

    /** Wave migration runs on first tracker tick when `PAPER_LIVE_OSCAR_EXIT_POLICY_WAVE_B=1`. */
    if (lepi !== 'wave_b_v1' && lepi !== 'variant_a_v1' && lepi !== 'variant_a_v2' && lepi !== 'variant_a_v3') {
      ensureLiveOscarExitPolicyPinned(ot);
    }

    reconcileEntrySplitV2FromLegs(ot);

    if (
      process.env.PAPER_STRATEGY_ID?.trim() === 'live-oscar' &&
      ot.liveStagedEntry?.entrySplitV2
    ) {
      applyCanonicalStagedEntrySizing(loadPaperTraderConfig(), ot.liveStagedEntry, ot.liveOscarMcapTier, ot.entryMarketCapUsd);
    }

    if (isWaveBExitPolicy(ot)) {
      waveBReconcileMaxExecutedTpFromMarks(ot, WAVE_B_V1_TP_GRID.gridStepPnl);
    }

    if (process.env.PAPER_STRATEGY_ID?.trim() === 'live-oscar') {
      reconcileE2OpenOnRestore(ot, loadPaperTraderConfig());
    }

    const tgKeys = rawPayload.presetCTgDedupeKeys;
    if (Array.isArray(tgKeys)) {
      const keys = tgKeys
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0);
      if (keys.length > 0) ot.presetCTgDedupeKeys = keys;
    }

    const scalpAnchor = rawPayload.presetCScalpAnchorPriceUsd;
    if (typeof scalpAnchor === 'number' && Number.isFinite(scalpAnchor) && scalpAnchor > 0) {
      ot.presetCScalpAnchorPriceUsd = scalpAnchor;
    }
    if (Boolean(rawPayload.presetCScalpTp25Taken)) ot.presetCScalpTp25Taken = true;
    if (Boolean(rawPayload.presetCScalpTp5Taken)) ot.presetCScalpTp5Taken = true;
    if (Boolean(rawPayload.presetCScalpTp10Taken)) ot.presetCScalpTp10Taken = true;
    if (Boolean(rawPayload.presetCScalpTrailArmed)) ot.presetCScalpTrailArmed = true;
    if (Boolean(rawPayload.presetCScalpDcaLegDone)) ot.presetCScalpDcaLegDone = true;
    if (Boolean(rawPayload.presetCScalpDca2LegDone)) ot.presetCScalpDca2LegDone = true;

    return ot;
  } catch {
    return null;
  }
}

function applyPartialSellLedgerLine(state: RestoreState, raw: Record<string, unknown>): void {
  const mint = raw.mint != null ? String(raw.mint) : '';
  if (!mint) return;
  const ot = state.open.get(mint);
  if (!ot) return;

  ot.partialSells.push(mapPartialSell(raw));

  const sf = Number(raw.sellFraction ?? 0);
  if (sf > 0 && sf <= 1 && Number.isFinite(sf)) {
    ot.remainingFraction *= 1 - sf;
  }

  const reason = String(raw.reason ?? '');
  const stepIdx = Number(raw.ladderStepIndex ?? NaN);
  if (reason === 'TP_LADDER' && Number.isFinite(stepIdx) && stepIdx >= 0) {
    ot.ladderUsedIndices.add(Math.floor(stepIdx));
  }
  const lp = Number(raw.ladderPnlPct ?? NaN);
  if (reason === 'TP_LADDER' && Number.isFinite(lp)) {
    ladderRememberLevel(ot.ladderUsedLevels, lp);
    waveBOnTpGridRungExecuted(ot, lp);
  }
  if (reason === 'BREAKEVEN_TRIM') {
    ot.liveBreakevenTrimDone = true;
  }
  if (reason === 'WAVE_B_BREAKEVEN_INSURANCE') {
    ot.liveWaveBreakevenInsuranceTaken = true;
  }
  if (reason === 'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL') {
    ot.liveWavePreArmNoHalf8PartialTaken = true;
  }
  if (reason === 'WAVE_B_DIP10_FIRST_TP5_PARTIAL') {
    ot.liveWaveDip10FirstTp5PartialTaken = true;
    ot.liveWaveDip10ReachedBeforeTp8 = true;
    waveBOnTpGridRungExecuted(ot, WAVE_B_FLAT_TP_HALF8_RUNNER.gridStepPnl);
  }
  if (reason === 'WAVE_B_POST_TP1_DERISK') {
    ot.liveWavePostTp1DeriskTaken = true;
  }
  if (reason === 'WAVE_B_POST_TP1_SCRATCH') {
    ot.liveWavePostTp1ScratchTaken = true;
  }
  if (reason === 'TRAIL_STEP' && Number.isFinite(lp)) {
    waveBMarkTrailLevelTaken(ot, lp);
  }
}

function applyDcaAddLedgerLine(state: RestoreState, raw: Record<string, unknown>): void {
  const mint = raw.mint != null ? String(raw.mint) : '';
  if (!mint) return;
  const ot = state.open.get(mint);
  if (!ot) return;

  const ts = Number(raw.ts ?? Date.now());
  const price = Number(raw.price ?? 0);
  const marketPrice = Number(raw.marketPrice ?? raw.price ?? 0);
  const sizeUsd = Number(raw.sizeUsd ?? 0);
  if (!(sizeUsd > 0)) return;

  const leg: PositionLeg = {
    ts,
    price: price > 0 ? price : marketPrice,
    marketPrice: marketPrice > 0 ? marketPrice : price,
    sizeUsd,
    reason: 'dca',
    triggerPct:
      raw.triggerPct !== undefined && raw.triggerPct !== null ? Number(raw.triggerPct) : undefined,
  };
  ot.legs.push(leg);

  const trig = leg.triggerPct;
  if (trig !== undefined && Number.isFinite(trig)) {
    ladderRememberLevel(ot.dcaUsedLevels, trig);
  }
  const stepIdx = Number(raw.dcaStepIndex ?? NaN);
  if (Number.isFinite(stepIdx) && stepIdx >= 0) {
    ot.dcaUsedIndices.add(Math.floor(stepIdx));
  }

  if (typeof raw.totalInvestedUsd === 'number' && raw.totalInvestedUsd > 0) {
    ot.totalInvestedUsd = raw.totalInvestedUsd;
  } else {
    ot.totalInvestedUsd += sizeUsd;
  }
  if (typeof raw.avgEntry === 'number' && raw.avgEntry > 0) ot.avgEntry = raw.avgEntry;
  if (typeof raw.avgEntryMarket === 'number' && raw.avgEntryMarket > 0) {
    ot.avgEntryMarket = raw.avgEntryMarket;
  }
  ot.remainingFraction = 1;
}

function restoreLastExitMarketSnapshotFromCloseLine(
  state: RestoreState,
  mint: string,
  rawClose: Record<string, unknown>,
): void {
  const exitTs = Number(rawClose.exitTs ?? rawClose.ts ?? 0);
  if (!(exitTs > 0)) return;
  let theo = Number(rawClose.theoretical_exit_price ?? 0);
  let eff = Number(rawClose.effective_exit_price ?? 0);
  let netPnlUsd = Number(rawClose.netPnlUsd ?? NaN);
  let exitReason = String(rawClose.exitReason ?? '');
  const ot = state.open.get(mint);
  if (exitReason === 'RECONCILE_ORPHAN' && ot) {
    const resolved = resolveReconcileOrphanReentryGateMeta(ot, {
      netPnlUsd: Number.isFinite(netPnlUsd) ? netPnlUsd : 0,
      exitReason,
      theoretical_exit_price: theo,
      effective_exit_price: eff,
    });
    if (resolved) {
      theo = resolved.marketUsd;
      eff = resolved.marketUsd;
      netPnlUsd = resolved.netPnlUsd;
      exitReason = resolved.exitReason;
    }
  }
  const px = theo > 0 ? theo : eff;
  if (!(px > 0)) return;
  const next: LastExitMarketSnapshot = {
    exitTs,
    marketUsd: px,
    netPnlUsd: Number.isFinite(netPnlUsd) ? netPnlUsd : undefined,
    exitReason: exitReason || undefined,
  };
  const prev = state.lastExitMarketSnapshotByMint.get(mint);
  if (
    prev &&
    next.exitReason &&
    (next.exitReason === 'RECONCILE_ORPHAN' || next.exitReason === 'PERIODIC_HEAL') &&
    prev.exitReason &&
    prev.exitReason !== 'RECONCILE_ORPHAN' &&
    prev.exitReason !== 'PERIODIC_HEAL' &&
    exitTs - prev.exitTs <= 10 * 60_000
  ) {
    return;
  }
  if (!prev || exitTs >= prev.exitTs) state.lastExitMarketSnapshotByMint.set(mint, next);
  if (
    next.exitReason &&
    next.exitReason !== 'RECONCILE_ORPHAN' &&
    next.exitReason !== 'PERIODIC_HEAL'
  ) {
    const realPrev = state.lastRealExitMarketSnapshotByMint.get(mint);
    if (!realPrev || exitTs >= realPrev.exitTs) {
      state.lastRealExitMarketSnapshotByMint.set(mint, next);
    }
  }
}

export function loadStore(storePath: string): RestoreState {
  const state: RestoreState = {
    evaluatedAt: new Map(),
    lastEntryTsByMint: new Map(),
    lastPostExitBuyCooldownTsByMint: new Map(),
    lastExitMarketSnapshotByMint: new Map(),
    lastRealExitMarketSnapshotByMint: new Map(),
    open: new Map(),
  };
  if (!fs.existsSync(storePath)) return state;
  const lines = fs.readFileSync(storePath, 'utf-8').split('\n').filter(Boolean);
  const waveBMaxTpFracByMint = new Map<string, number>();
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln) as {
        kind?: string;
        mint?: string;
        ts?: number;
        entryTs?: number;
        offsetMin?: number;
      };
      if (e.kind === 'eval' && e.mint) {
        const ts = Number(e.ts || 0);
        const prev = state.evaluatedAt.get(e.mint) || 0;
        if (ts > prev) state.evaluatedAt.set(e.mint, ts);
      }
      if (e.kind === 'open' && e.mint && typeof e.entryTs === 'number') {
        const ot = restoreOpenTradeFromJson(e as Partial<OpenTrade> & { mint: string });
        if (ot) state.open.set(resolveOpenMapKey(ot), ot);
        const prev = state.lastEntryTsByMint.get(e.mint) || 0;
        if (e.entryTs > prev) state.lastEntryTsByMint.set(e.mint, e.entryTs);
      }
      if (e.kind === 'partial_sell' && e.mint) {
        const rawPs = e as unknown as Record<string, unknown>;
        applyPartialSellLedgerLine(state, rawPs);
        if (String(rawPs.reason ?? '') === 'TP_LADDER') {
          const lp = Number(rawPs.ladderPnlPct ?? NaN);
          if (Number.isFinite(lp)) {
            const prev = waveBMaxTpFracByMint.get(e.mint) ?? 0;
            if (lp > prev) waveBMaxTpFracByMint.set(e.mint, lp);
          }
        }
      }
      if (e.kind === 'dca_add' && e.mint) {
        applyDcaAddLedgerLine(state, e as unknown as Record<string, unknown>);
      }
      if (e.kind === 'close' && e.mint) {
        const rawClose = e as Record<string, unknown>;
        const exitTs = Number(rawClose.exitTs ?? rawClose.ts ?? 0);
        if (exitTs > 0) {
          const prev = state.lastPostExitBuyCooldownTsByMint.get(e.mint) ?? 0;
          if (exitTs >= prev) state.lastPostExitBuyCooldownTsByMint.set(e.mint, exitTs);
        }
        restoreLastExitMarketSnapshotFromCloseLine(state, e.mint, rawClose);
        state.open.delete(e.mint);
        state.open.delete(runnerProbeOpenMapKey(e.mint));
        state.open.delete(runnerLiteOpenMapKey(e.mint));
      }
      if (
        e.kind === 'followup_snapshot' &&
        e.mint &&
        typeof e.entryTs === 'number' &&
        typeof e.offsetMin === 'number'
      ) {
        markFollowupCompleted(e.mint, e.entryTs, e.offsetMin);
      }
      if (
        e.kind === 'wave_b_post_tp1_scratch_pending' ||
        e.kind === 'wave_b_post_tp1_scratch_consumed'
      ) {
        applyWaveBPostTp1ScratchJournalLine(e as unknown as Record<string, unknown>);
      }
    } catch {
      // ignore corrupt line
    }
  }
  for (const [mint, maxTp] of waveBMaxTpFracByMint) {
    const ot = state.open.get(mint);
    if (ot) waveBOnTpGridRungExecuted(ot, maxTp);
  }
  return state;
}
