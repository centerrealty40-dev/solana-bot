import fs from 'node:fs';
import type { OpenTrade, PartialSell, PositionLeg } from '../types.js';
import { markFollowupCompleted } from './followup.js';
import { ladderPnlThresholdMark } from './tp-ladder-state.js';

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
  open: Map<string, OpenTrade>;
}

function mapPartialSell(p: Record<string, unknown>): PartialSell {
  return {
    ts: Number(p.ts),
    price: Number(p.price),
    marketPrice: Number(p.marketPrice ?? p.price),
    sellFraction: Number(p.sellFraction),
    reason: (p.reason ?? 'TP_LADDER') as PartialSell['reason'],
    proceedsUsd: Number(p.proceedsUsd ?? 0),
    grossProceedsUsd: Number(p.grossProceedsUsd ?? 0),
    pnlUsd: Number(p.pnlUsd ?? 0),
    grossPnlUsd: Number(p.grossPnlUsd ?? 0),
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

export function loadStore(storePath: string): RestoreState {
  const state: RestoreState = {
    evaluatedAt: new Map(),
    lastEntryTsByMint: new Map(),
    open: new Map(),
  };
  if (!fs.existsSync(storePath)) return state;
  const lines = fs.readFileSync(storePath, 'utf-8').split('\n').filter(Boolean);
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
        if (ot) state.open.set(e.mint, ot);
        const prev = state.lastEntryTsByMint.get(e.mint) || 0;
        if (e.entryTs > prev) state.lastEntryTsByMint.set(e.mint, e.entryTs);
      }
      if (e.kind === 'partial_sell' && e.mint) {
        applyPartialSellLedgerLine(state, e as unknown as Record<string, unknown>);
      }
      if (e.kind === 'dca_add' && e.mint) {
        applyDcaAddLedgerLine(state, e as unknown as Record<string, unknown>);
      }
      if (e.kind === 'close' && e.mint) {
        state.open.delete(e.mint);
      }
      if (
        e.kind === 'followup_snapshot' &&
        e.mint &&
        typeof e.entryTs === 'number' &&
        typeof e.offsetMin === 'number'
      ) {
        markFollowupCompleted(e.mint, e.entryTs, e.offsetMin);
      }
    } catch {
      // ignore corrupt line
    }
  }
  return state;
}
