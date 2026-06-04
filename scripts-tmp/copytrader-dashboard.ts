import fs from 'node:fs';
import type { Paper2OpenItem } from './dashboard-server.js';
import type { TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type CopyTraderCycleRow = {
  cycleId: string;
  mint: string;
  symbol: string;
  startedTs: number;
  closedTs?: number;
  status:
    | 'pending_our_buy'
    | 'open'
    | 'pending_our_sell'
    | 'closed'
    | 'missed'
    | 'leader_only';
  leaderEntry: { sig: string; ts: number; sizeUsd: number; priceUsd: number | null };
  leaderExit?: { sig: string; ts: number; sellFraction: number | null };
  ourEntry?: {
    ok: boolean;
    ts: number;
    sig: string | null;
    sizeUsd: number;
    failReason: string | null;
  };
  ourExit?: {
    ok: boolean;
    ts: number;
    sig: string | null;
    sizeUsd: number;
    pnlUsd: number | null;
    pnlPct: number | null;
    failReason: string | null;
  };
  buyAttempts: number;
};

export type CopyTraderDashboardStats = {
  pendingBuys: number;
  pendingSells: number;
  buysOk: number;
  buysFail: number;
  sellsOk: number;
  sellsFail: number;
  leaderSignals1h: number;
  ourFills1h: number;
  cycles: CopyTraderCycleRow[];
};

export type CopyTraderDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
  copyTrader: CopyTraderDashboardStats;
};

type PosState = {
  mint: string;
  symbol: string;
  entryTs: number;
  totalInvestedUsd: number;
  remainingUsd: number;
  avgEntryPx: number;
  remainingFraction: number;
  leaderEntrySig: string;
};

type ActiveCycle = CopyTraderCycleRow;

function* journalLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesBounded(filePath, TAIL_BYTES, FULL_SCAN_MAX);
}

function emptyLoad(): CopyTraderDashboardLoad {
  const now = Date.now();
  return {
    open: [],
    closed: [],
    firstTs: now,
    lastTs: now,
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map(),
    copyTrader: emptyStats(),
  };
}

function emptyStats(): CopyTraderDashboardStats {
  return {
    pendingBuys: 0,
    pendingSells: 0,
    buysOk: 0,
    buysFail: 0,
    sellsOk: 0,
    sellsFail: 0,
    leaderSignals1h: 0,
    ourFills1h: 0,
    cycles: [],
  };
}

function leaderSig(ev: Record<string, unknown>): string | null {
  const s = ev.leaderSignature;
  return typeof s === 'string' && s.length >= 64 ? s : null;
}

function ourSig(ev: Record<string, unknown>): string | null {
  const s = ev.txSignature;
  return typeof s === 'string' && s.length >= 64 ? s : null;
}

function txFields(leader: string | null, ours: string | null): Partial<TimelineEvent> {
  return {
    leaderTxSignature: leader,
    ourTxSignature: ours,
    txSignature: leader ?? ours ?? null,
  };
}

function pushNote(
  tl: TimelineEvent[],
  ts: number,
  label: string,
  extra: Partial<TimelineEvent> = {},
): void {
  tl.push({
    ts,
    kind: 'strategy_note',
    label,
    mcUsd: null,
    spotPxUsd: extra.spotPxUsd ?? null,
    sizePct: null,
    pnlPct: null,
    pnlUsd: null,
    reason: extra.reason ?? null,
    remainingFraction: null,
    amountUsd: extra.amountUsd ?? null,
    contextNote: extra.contextNote ?? null,
    leaderTxSignature: extra.leaderTxSignature ?? null,
    ourTxSignature: extra.ourTxSignature ?? null,
    txSignature: extra.txSignature ?? extra.leaderTxSignature ?? extra.ourTxSignature ?? null,
  });
}

/** Legacy journal rows stored USD proceeds in exitPriceUsd instead of token price. */
function normalizeExitPrice(entryPx: number, exitPx: number, sizeUsd: number): number {
  if (!(entryPx > 0) || !(exitPx > 0) || !(sizeUsd > 0)) return exitPx;
  if (exitPx > entryPx * 10 && exitPx >= sizeUsd * 0.25) {
    return entryPx * (exitPx / sizeUsd);
  }
  return exitPx;
}

function sanePnl(entryPx: number, exitPx: number, soldUsd: number): { pnlPct: number; pnlUsd: number } {
  const px = normalizeExitPrice(entryPx, exitPx, soldUsd);
  if (!(entryPx > 0) || !(px > 0) || !(soldUsd > 0)) return { pnlPct: 0, pnlUsd: 0 };
  const rawPct = ((px / entryPx) - 1) * 100;
  const pnlPct = Math.max(-99.9, Math.min(500, rawPct));
  const pnlUsd = (soldUsd * pnlPct) / 100;
  return { pnlPct: +pnlPct.toFixed(2), pnlUsd: +pnlUsd.toFixed(2) };
}

/** Prefer journal pnlPct from copy-trader executor; fallback to price inference. */
function pnlFromCopySellEvent(
  ev: Record<string, unknown>,
  entryPx: number,
  exitPx: number,
  soldUsd: number,
): { pnlPct: number; pnlUsd: number } {
  const journalPct = Number(ev.pnlPct);
  if (ev.ok === true && Number.isFinite(journalPct) && soldUsd > 0) {
    const pnlPct = Math.max(-99.9, Math.min(500, journalPct));
    const pnlUsd = (soldUsd * pnlPct) / 100;
    return { pnlPct: +pnlPct.toFixed(2), pnlUsd: +pnlUsd.toFixed(2) };
  }
  return sanePnl(entryPx, exitPx, soldUsd);
}

function bumpFail(map: Map<string, number>, reason: string): void {
  const key = reason.trim() || 'unknown';
  map.set(key, (map.get(key) ?? 0) + 1);
}

function readStateCounts(statePath: string | undefined): {
  pendingBuys: number;
  pendingSells: number;
  pendingBuyMints: Set<string>;
} {
  if (!statePath || !fs.existsSync(statePath)) {
    return { pendingBuys: 0, pendingSells: 0, pendingBuyMints: new Set() };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      pendingBuys?: Array<{ mint?: string }>;
      pendingSells?: unknown[];
    };
    const pendingBuys = Array.isArray(parsed.pendingBuys) ? parsed.pendingBuys : [];
    const pendingBuyMints = new Set(
      pendingBuys.map((p) => (typeof p.mint === 'string' ? p.mint : '')).filter(Boolean),
    );
    return {
      pendingBuys: pendingBuys.length,
      pendingSells: Array.isArray(parsed.pendingSells) ? parsed.pendingSells.length : 0,
      pendingBuyMints,
    };
  } catch {
    return { pendingBuys: 0, pendingSells: 0, pendingBuyMints: new Set() };
  }
}

/** Drop stale leader-only cycles; keep closed trades and truly pending queue rows. */
export function compactCopyTraderCyclesForDashboard(
  cycles: CopyTraderCycleRow[],
  pendingBuyMints: Set<string>,
): CopyTraderCycleRow[] {
  const sorted = [...cycles].sort((a, b) => b.startedTs - a.startedTs);
  const closedMintSeen = new Set<string>();
  const out: CopyTraderCycleRow[] = [];
  for (const c of sorted) {
    if (c.status === 'closed' && c.ourEntry?.ok) {
      if (closedMintSeen.has(c.mint)) continue;
      closedMintSeen.add(c.mint);
      out.push(c);
      continue;
    }
    if (c.status === 'open' || c.status === 'pending_our_sell') {
      out.push(c);
      continue;
    }
    if (c.status === 'pending_our_buy' && pendingBuyMints.has(c.mint)) {
      out.push(c);
    }
  }
  return out;
}

function abandonPendingCycle(cycle: ActiveCycle, ts: number): void {
  if (cycle.ourEntry?.ok) return;
  if (cycle.status === 'closed') return;
  cycle.status = 'missed';
  cycle.closedTs = ts;
}

function finalizeCycle(cycle: ActiveCycle, cycles: CopyTraderCycleRow[]): void {
  if (cycles.some((c) => c.cycleId === cycle.cycleId)) return;
  cycles.push({ ...cycle });
}

/** Parse `data/copytrader/journal.jsonl` (+ optional state.json) for `/api/paper2` copy-trader panel. */
export function loadCopyTraderJsonlForDashboard(
  journalPath: string,
  statePath?: string,
): CopyTraderDashboardLoad {
  if (!fs.existsSync(journalPath)) return emptyLoad();

  const since1h = Date.now() - 3_600_000;
  let firstTs = Date.now();
  let lastTs = 0;
  const failReasonsCount = new Map<string, number>();
  let evals1h = 0;
  let passed1h = 0;

  const stats = emptyStats();
  const cyclesOut: CopyTraderCycleRow[] = [];
  const activeCycleByMint = new Map<string, ActiveCycle>();

  const openMap = new Map<string, Paper2OpenItem>();
  const posState = new Map<string, PosState>();
  const timelines = new Map<string, TimelineEvent[]>();
  const closed: Array<Record<string, unknown>> = [];

  const tlFor = (mint: string): TimelineEvent[] => {
    let row = timelines.get(mint);
    if (!row) {
      row = [];
      timelines.set(mint, row);
    }
    return row;
  };

  const getCycle = (mint: string): ActiveCycle | undefined => activeCycleByMint.get(mint);

  const startEntryCycle = (
    mint: string,
    symbol: string,
    ts: number,
    sig: string,
    sizeUsd: number,
    priceUsd: number | null,
  ): ActiveCycle => {
    const prev = activeCycleByMint.get(mint);
    if (prev && prev.status !== 'closed') {
      abandonPendingCycle(prev, ts);
      finalizeCycle(prev, cyclesOut);
      activeCycleByMint.delete(mint);
    }
    const cycle: ActiveCycle = {
      cycleId: `cy_${ts}_${mint.slice(0, 8)}`,
      mint,
      symbol,
      startedTs: ts,
      status: 'pending_our_buy',
      leaderEntry: { sig, ts, sizeUsd, priceUsd },
      buyAttempts: 0,
    };
    activeCycleByMint.set(mint, cycle);
    return cycle;
  };

  const openItemFromPos = (p: PosState): Paper2OpenItem => ({
    mint: p.mint,
    symbol: p.symbol,
    entryTs: p.entryTs,
    entryMcUsd: p.avgEntryPx,
    entryRealMcUsd: null,
    baselinePriceUsd: p.avgEntryPx > 0 ? p.avgEntryPx : null,
    openedAtIso: p.entryTs ? new Date(p.entryTs).toISOString() : null,
    lane: 'copy-trader',
    source: null,
    metricType: 'price',
    features: null,
    btc: null,
    peakMcUsd: p.avgEntryPx,
    peakPnlPct: 0,
    trailingArmed: false,
    totalInvestedUsd: p.totalInvestedUsd,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: null,
    entryPriceVerifyImpactPct: null,
    entryPriceVerifySource: null,
    pairAddress: null,
    entryLiqUsd: null,
    remainingFraction: p.remainingFraction,
  });

  const closePosition = (mint: string, exitTs: number, exitReason: string, pnlPct: number, pnlUsd: number): void => {
    const p = posState.get(mint);
    if (!p) return;
    const tl = tlFor(mint).slice();
    closed.push({
      mint,
      symbol: p.symbol,
      entryTs: p.entryTs,
      exitTs,
      exitReason,
      pnlPct,
      pnlUsd,
      netPnlUsd: pnlUsd,
      durationMin: Math.max(0, Math.round((exitTs - p.entryTs) / 60_000)),
      leaderEntrySig: p.leaderEntrySig,
      __timeline: tl,
    });
    posState.delete(mint);
    openMap.delete(mint);
    timelines.delete(mint);
  };

  for (const line of journalLines(journalPath)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const kind = String(ev.kind ?? '');
    const mint = typeof ev.mint === 'string' ? ev.mint : '';
    const symbol = typeof ev.symbol === 'string' ? ev.symbol : mint.slice(0, 6);
    const tl = mint ? tlFor(mint) : [];
    const lSig = leaderSig(ev);

    if (kind === 'leader_buy_scheduled') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      if (ts >= since1h) stats.leaderSignals1h += 1;
      if (lSig) {
        startEntryCycle(mint, symbol, ts, lSig, sizeUsd, Number(ev.leaderPriceUsd ?? 0) || null);
      }
      pushNote(tl, ts, `Leader buy · queue $${sizeUsd}`, {
        spotPxUsd: Number(ev.leaderPriceUsd ?? 0) || null,
        amountUsd: sizeUsd > 0 ? sizeUsd : null,
        ...txFields(lSig, null),
        contextNote: 'Ордер лидера — Solscan ниже',
      });
      continue;
    }

    if (kind === 'leader_add_scheduled') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      if (ts >= since1h) stats.leaderSignals1h += 1;
      pushNote(tl, ts, `Leader add · queue $${sizeUsd}`, {
        spotPxUsd: Number(ev.leaderPriceUsd ?? 0) || null,
        amountUsd: sizeUsd > 0 ? sizeUsd : null,
        ...txFields(lSig, null),
        contextNote: 'Добор лидера — Solscan ниже',
      });
      continue;
    }

    if (kind === 'leader_sell_scheduled') {
      const frac = Number(ev.leaderSellFraction ?? ev.ourSellFraction ?? 0);
      const cycle = getCycle(mint);
      if (cycle && lSig) {
        cycle.leaderExit = { sig: lSig, ts, sellFraction: Number.isFinite(frac) ? frac : null };
        if (cycle.ourEntry?.ok) cycle.status = 'pending_our_sell';
        else cycle.status = 'leader_only';
      }
      pushNote(tl, ts, `Leader sell · mirror ${(frac * 100).toFixed(0)}% queued`, {
        spotPxUsd: Number(ev.leaderPriceUsd ?? 0) || null,
        ...txFields(lSig, null),
        contextNote: 'Выход лидера — Solscan ниже',
      });
      continue;
    }

    if (kind === 'buy_deferred' || kind === 'add_deferred' || kind === 'buy_skipped') {
      if (ts >= since1h) evals1h += 1;
      const evalObj = ev.eval as { reasons?: unknown[] } | undefined;
      const reasons = Array.isArray(evalObj?.reasons) ? evalObj!.reasons!.map(String) : [];
      const reason = reasons[0] ?? String(ev.reason ?? kind);
      bumpFail(failReasonsCount, reason);
      const cycle = getCycle(mint);
      if (cycle) cycle.buyAttempts += 1;
      pushNote(tl, ts, `${kind === 'add_deferred' ? 'Add' : 'Buy'} deferred · ${reason}`, {
        spotPxUsd: Number(ev.currentPriceUsd ?? 0) || null,
        ...txFields(lSig ?? cycle?.leaderEntry.sig ?? null, null),
      });
      continue;
    }

    if (kind === 'buy_cancelled' || kind === 'add_cancelled' || kind === 'buy_expired' || kind === 'add_expired') {
      const reason = String(ev.reason ?? kind);
      bumpFail(failReasonsCount, reason);
      const cycle = getCycle(mint);
      if (cycle && kind.startsWith('buy') && !cycle.ourEntry?.ok) {
        cycle.status = 'missed';
        cycle.closedTs = ts;
        finalizeCycle(cycle, cyclesOut);
        activeCycleByMint.delete(mint);
      }
      pushNote(tl, ts, `${kind.replace(/_/g, ' ')} · ${reason}`, {
        ...txFields(lSig ?? cycle?.leaderEntry.sig ?? null, null),
      });
      continue;
    }

    if (kind === 'copy_buy' || kind === 'copy_add') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      const priceUsd = Number(ev.priceUsd ?? 0);
      const ok = ev.ok === true;
      const oSig = ourSig(ev);
      const isAdd = kind === 'copy_add';
      let cycle = getCycle(mint);
      if (!cycle && lSig && !isAdd) {
        cycle = startEntryCycle(mint, symbol, ts, lSig, sizeUsd, priceUsd > 0 ? priceUsd : null);
      }

      if (ts >= since1h) {
        evals1h += 1;
        if (ok) passed1h += 1;
      }

      const leaderRef = lSig ?? cycle?.leaderEntry.sig ?? null;

      if (ok) {
        stats.buysOk += 1;
        if (ts >= since1h) stats.ourFills1h += 1;
        if (cycle) {
          cycle.ourEntry = { ok: true, ts, sig: oSig, sizeUsd, failReason: null };
          cycle.status = 'open';
        }

        if (isAdd && posState.has(mint)) {
          const p = posState.get(mint)!;
          const newTotal = p.totalInvestedUsd + sizeUsd;
          const newAvg =
            newTotal > 0 && priceUsd > 0
              ? (p.avgEntryPx * p.totalInvestedUsd + priceUsd * sizeUsd) / newTotal
              : p.avgEntryPx;
          p.totalInvestedUsd = newTotal;
          p.remainingUsd = newTotal;
          p.avgEntryPx = newAvg;
          tl.push({
            ts,
            kind: 'dca_add',
            label: `Add buy $${sizeUsd} · OK`,
            mcUsd: null,
            spotPxUsd: priceUsd > 0 ? priceUsd : null,
            sizePct: null,
            pnlPct: null,
            pnlUsd: null,
            reason: null,
            remainingFraction: p.remainingFraction,
            amountUsd: sizeUsd,
            ...txFields(leaderRef, oSig),
          });
          openMap.set(mint, openItemFromPos(p));
        } else {
          if (posState.has(mint)) {
            timelines.set(mint, []);
            tl.length = 0;
          }
          const p: PosState = {
            mint,
            symbol,
            entryTs: ts,
            totalInvestedUsd: sizeUsd,
            remainingUsd: sizeUsd,
            avgEntryPx: priceUsd,
            remainingFraction: 1,
            leaderEntrySig: leaderRef ?? '',
          };
          posState.set(mint, p);
          tl.push({
            ts,
            kind: 'open',
            label: `Our entry buy $${sizeUsd} · OK`,
            mcUsd: null,
            spotPxUsd: priceUsd > 0 ? priceUsd : null,
            sizePct: null,
            pnlPct: null,
            pnlUsd: null,
            reason: null,
            remainingFraction: 1,
            amountUsd: sizeUsd,
            ...txFields(leaderRef, oSig),
            contextNote: oSig ? 'Наш tx — ссылка «Our tx»' : null,
          });
          openMap.set(mint, openItemFromPos(p));
        }
      } else {
        stats.buysFail += 1;
        const reason = String(ev.reason ?? 'execution_failed');
        bumpFail(failReasonsCount, reason);
        if (cycle) {
          cycle.buyAttempts += 1;
          cycle.ourEntry = { ok: false, ts, sig: oSig, sizeUsd, failReason: reason };
        }
        pushNote(tl, ts, `${isAdd ? 'Add' : 'Buy'} FAILED · $${sizeUsd} · ${reason}`, {
          spotPxUsd: priceUsd > 0 ? priceUsd : null,
          amountUsd: sizeUsd > 0 ? sizeUsd : null,
          ...txFields(leaderRef, oSig),
        });
      }
      continue;
    }

    if (kind === 'copy_sell') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      const entryPx = Number(ev.entryPriceUsd ?? 0);
      let exitPx = Number(ev.exitPriceUsd ?? 0);
      const ok = ev.ok === true;
      const oSig = ourSig(ev);
      const p = posState.get(mint);
      const cycle = getCycle(mint);
      const leaderRef = lSig ?? cycle?.leaderExit?.sig ?? cycle?.leaderEntry.sig ?? null;

      if (ok) {
        stats.sellsOk += 1;
        if (ts >= since1h) stats.ourFills1h += 1;
        const entryPxUse = entryPx || p?.avgEntryPx || 0;
        const { pnlPct, pnlUsd } = pnlFromCopySellEvent(ev, entryPxUse, exitPx, sizeUsd);
        const soldFrac =
          p && p.remainingUsd > 0 ? Math.min(1, sizeUsd / p.remainingUsd) : 1;
        const isFull = !p || soldFrac >= 0.999 || sizeUsd >= (p?.remainingUsd ?? sizeUsd) * 0.999;

        tl.push({
          ts,
          kind: isFull ? 'close' : 'partial_sell',
          label: isFull ? `Our exit sell $${sizeUsd} · OK` : `Our partial sell $${sizeUsd} · OK`,
          mcUsd: null,
          spotPxUsd: exitPx > 0 ? exitPx : null,
          sizePct: soldFrac * 100,
          pnlPct,
          pnlUsd,
          reason: null,
          remainingFraction: p ? Math.max(0, p.remainingFraction * (1 - soldFrac)) : 0,
          amountUsd: sizeUsd,
          ...txFields(leaderRef, oSig),
        });

        if (cycle) {
          cycle.ourExit = {
            ok: true,
            ts,
            sig: oSig,
            sizeUsd,
            pnlUsd,
            pnlPct,
            failReason: null,
          };
        }

        if (p) {
          p.remainingUsd = Math.max(0, p.remainingUsd - sizeUsd);
          p.remainingFraction = isFull ? 0 : Math.max(0, p.remainingFraction * (1 - soldFrac));
          if (isFull || p.remainingUsd < 0.5) {
            if (cycle) {
              cycle.status = 'closed';
              cycle.closedTs = ts;
              finalizeCycle(cycle, cyclesOut);
              activeCycleByMint.delete(mint);
            }
            closePosition(mint, ts, pnlUsd >= 0 ? 'TP' : 'SL', pnlPct, pnlUsd);
          } else {
            if (cycle) cycle.status = 'open';
            openMap.set(mint, openItemFromPos(p));
          }
        } else {
          openMap.delete(mint);
          const sym = typeof ev.symbol === 'string' ? ev.symbol : mint.slice(0, 6);
          const entryTs =
            typeof cycle?.ourEntry?.ts === 'number' ? cycle.ourEntry.ts : ts - 60_000;
          closed.push({
            mint,
            symbol: sym,
            entryTs,
            exitTs: ts,
            exitReason: pnlUsd >= 0 ? 'TP' : 'SL',
            pnlPct,
            pnlUsd,
            netPnlUsd: pnlUsd,
            durationMin: Math.max(0, Math.round((ts - entryTs) / 60_000)),
            leaderEntrySig: cycle?.leaderEntry.sig ?? leaderRef ?? '',
            __timeline: tl.slice(),
          });
          if (cycle) {
            cycle.status = 'closed';
            cycle.closedTs = ts;
            finalizeCycle(cycle, cyclesOut);
            activeCycleByMint.delete(mint);
          }
        }
      } else {
        stats.sellsFail += 1;
        const reason = String(ev.reason ?? 'sell_failed');
        bumpFail(failReasonsCount, reason);
        if (cycle) {
          cycle.ourExit = {
            ok: false,
            ts,
            sig: oSig,
            sizeUsd,
            pnlUsd: null,
            pnlPct: null,
            failReason: reason,
          };
        }
        pushNote(tl, ts, `Sell FAILED · $${sizeUsd} · ${reason}`, {
          spotPxUsd: exitPx > 0 ? exitPx : null,
          amountUsd: sizeUsd > 0 ? sizeUsd : null,
          ...txFields(leaderRef, oSig),
        });
      }
      continue;
    }

    if (kind === 'entry' || kind === 'execution_result') {
      const side = String(ev.side ?? '');
      const status = String(ev.status ?? '');
      const oSig = ourSig(ev);
      const cycle = getCycle(mint);
      if (side === 'buy' && status && status !== 'confirmed') {
        pushNote(tl, ts, `Our buy tx ${status}${ev.error ? ` · ${String(ev.error).slice(0, 80)}` : ''}`, {
          ...txFields(cycle?.leaderEntry.sig ?? lSig, oSig),
        });
      }
    }
  }

  for (const cycle of activeCycleByMint.values()) {
    abandonPendingCycle(cycle, lastTs || Date.now());
    finalizeCycle(cycle, cyclesOut);
  }

  cyclesOut.sort((a, b) => b.startedTs - a.startedTs);

  const stateCounts = readStateCounts(statePath);
  stats.pendingBuys = stateCounts.pendingBuys;
  stats.pendingSells = stateCounts.pendingSells;
  stats.cycles = compactCopyTraderCyclesForDashboard(cyclesOut, stateCounts.pendingBuyMints).slice(0, 40);

  const failReasons = [...failReasonsCount.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    open: [...openMap.values()],
    closed,
    firstTs,
    lastTs: lastTs || firstTs,
    resetTs: 0,
    evals1h,
    passed1h,
    failReasons,
    openTimelines: timelines,
    copyTrader: stats,
  };
}
