import fs from 'node:fs';
import type { Paper2OpenItem } from './dashboard-server.js';
import type { TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type CopyTraderDashboardStats = {
  pendingBuys: number;
  pendingSells: number;
  buysOk: number;
  buysFail: number;
  sellsOk: number;
  sellsFail: number;
  leaderSignals1h: number;
  ourFills1h: number;
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
};

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
    copyTrader: {
      pendingBuys: 0,
      pendingSells: 0,
      buysOk: 0,
      buysFail: 0,
      sellsOk: 0,
      sellsFail: 0,
      leaderSignals1h: 0,
      ourFills1h: 0,
    },
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
    txSignature: extra.txSignature ?? null,
    contextNote: extra.contextNote ?? null,
  });
}

function sanePnl(entryPx: number, exitPx: number, soldUsd: number): { pnlPct: number; pnlUsd: number } {
  if (!(entryPx > 0) || !(exitPx > 0) || !(soldUsd > 0)) return { pnlPct: 0, pnlUsd: 0 };
  const rawPct = ((exitPx / entryPx) - 1) * 100;
  const pnlPct = Math.max(-99.9, Math.min(500, rawPct));
  const pnlUsd = (soldUsd * pnlPct) / 100;
  return { pnlPct: +pnlPct.toFixed(2), pnlUsd: +pnlUsd.toFixed(2) };
}

function bumpFail(map: Map<string, number>, reason: string): void {
  const key = reason.trim() || 'unknown';
  map.set(key, (map.get(key) ?? 0) + 1);
}

function readStateCounts(statePath: string | undefined): { pendingBuys: number; pendingSells: number } {
  if (!statePath || !fs.existsSync(statePath)) return { pendingBuys: 0, pendingSells: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      pendingBuys?: unknown[];
      pendingSells?: unknown[];
    };
    return {
      pendingBuys: Array.isArray(parsed.pendingBuys) ? parsed.pendingBuys.length : 0,
      pendingSells: Array.isArray(parsed.pendingSells) ? parsed.pendingSells.length : 0,
    };
  } catch {
    return { pendingBuys: 0, pendingSells: 0 };
  }
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

  const stats: CopyTraderDashboardStats = {
    pendingBuys: 0,
    pendingSells: 0,
    buysOk: 0,
    buysFail: 0,
    sellsOk: 0,
    sellsFail: 0,
    leaderSignals1h: 0,
    ourFills1h: 0,
  };

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

    if (kind === 'leader_buy_scheduled' || kind === 'leader_add_scheduled') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      const isAdd = kind === 'leader_add_scheduled';
      if (ts >= since1h) stats.leaderSignals1h += 1;
      pushNote(tl, ts, isAdd ? `Leader add · queue $${sizeUsd}` : `Leader buy · queue $${sizeUsd}`, {
        spotPxUsd: Number(ev.leaderPriceUsd ?? 0) || null,
        amountUsd: sizeUsd > 0 ? sizeUsd : null,
        contextNote: typeof ev.leaderSignature === 'string' ? `leader tx ${ev.leaderSignature.slice(0, 8)}…` : null,
      });
      continue;
    }

    if (kind === 'leader_sell_scheduled') {
      const frac = Number(ev.leaderSellFraction ?? ev.ourSellFraction ?? 0);
      pushNote(tl, ts, `Leader sell · mirror ${(frac * 100).toFixed(0)}% queued`, {
        spotPxUsd: Number(ev.leaderPriceUsd ?? 0) || null,
      });
      continue;
    }

    if (kind === 'buy_deferred' || kind === 'add_deferred' || kind === 'buy_skipped') {
      if (ts >= since1h) evals1h += 1;
      const evalObj = ev.eval as { reasons?: unknown[] } | undefined;
      const reasons = Array.isArray(evalObj?.reasons) ? evalObj!.reasons!.map(String) : [];
      const reason = reasons[0] ?? String(ev.reason ?? kind);
      bumpFail(failReasonsCount, reason);
      pushNote(tl, ts, `${kind === 'add_deferred' ? 'Add' : 'Buy'} deferred · ${reason}`, {
        spotPxUsd: Number(ev.currentPriceUsd ?? 0) || null,
      });
      continue;
    }

    if (kind === 'buy_cancelled' || kind === 'add_cancelled' || kind === 'buy_expired' || kind === 'add_expired') {
      const reason = String(ev.reason ?? kind);
      bumpFail(failReasonsCount, reason);
      pushNote(tl, ts, `${kind.replace(/_/g, ' ')} · ${reason}`);
      continue;
    }

    if (kind === 'copy_buy' || kind === 'copy_add') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      const priceUsd = Number(ev.priceUsd ?? 0);
      const ok = ev.ok === true;
      const txSig = typeof ev.txSignature === 'string' ? ev.txSignature : null;
      const isAdd = kind === 'copy_add';

      if (ts >= since1h) {
        evals1h += 1;
        if (ok) passed1h += 1;
      }

      if (ok) {
        stats.buysOk += 1;
        if (ts >= since1h) stats.ourFills1h += 1;

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
            txSignature: txSig,
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
          };
          posState.set(mint, p);
          tl.push({
            ts,
            kind: 'open',
            label: `Entry buy $${sizeUsd} · OK`,
            mcUsd: null,
            spotPxUsd: priceUsd > 0 ? priceUsd : null,
            sizePct: null,
            pnlPct: null,
            pnlUsd: null,
            reason: null,
            remainingFraction: 1,
            amountUsd: sizeUsd,
            txSignature: txSig,
          });
          openMap.set(mint, openItemFromPos(p));
        }
      } else {
        stats.buysFail += 1;
        const reason = String(ev.reason ?? 'execution_failed');
        bumpFail(failReasonsCount, reason);
        pushNote(tl, ts, `${isAdd ? 'Add' : 'Buy'} FAILED · $${sizeUsd} · ${reason}`, {
          spotPxUsd: priceUsd > 0 ? priceUsd : null,
          amountUsd: sizeUsd > 0 ? sizeUsd : null,
          txSignature: txSig,
        });
      }
      continue;
    }

    if (kind === 'copy_sell') {
      const sizeUsd = Number(ev.sizeUsd ?? 0);
      const entryPx = Number(ev.entryPriceUsd ?? 0);
      const exitPx = Number(ev.exitPriceUsd ?? 0);
      const ok = ev.ok === true;
      const txSig = typeof ev.txSignature === 'string' ? ev.txSignature : null;
      const p = posState.get(mint);

      if (ok) {
        stats.sellsOk += 1;
        if (ts >= since1h) stats.ourFills1h += 1;
        const { pnlPct, pnlUsd } = sanePnl(entryPx || p?.avgEntryPx || 0, exitPx, sizeUsd);
        const soldFrac =
          p && p.remainingUsd > 0 ? Math.min(1, sizeUsd / p.remainingUsd) : 1;
        const isFull = !p || soldFrac >= 0.999 || sizeUsd >= (p?.remainingUsd ?? sizeUsd) * 0.999;

        tl.push({
          ts,
          kind: isFull ? 'close' : 'partial_sell',
          label: isFull ? `Exit sell $${sizeUsd} · OK` : `Partial sell $${sizeUsd} · OK`,
          mcUsd: null,
          spotPxUsd: exitPx > 0 ? exitPx : null,
          sizePct: soldFrac * 100,
          pnlPct,
          pnlUsd,
          reason: null,
          remainingFraction: p ? Math.max(0, p.remainingFraction * (1 - soldFrac)) : 0,
          amountUsd: sizeUsd,
          txSignature: txSig,
        });

        if (p) {
          p.remainingUsd = Math.max(0, p.remainingUsd - sizeUsd);
          p.remainingFraction = isFull ? 0 : Math.max(0, p.remainingFraction * (1 - soldFrac));
          if (isFull || p.remainingUsd < 0.5) {
            closePosition(mint, ts, pnlUsd >= 0 ? 'TP' : 'SL', pnlPct, pnlUsd);
          } else {
            openMap.set(mint, openItemFromPos(p));
          }
        }
      } else {
        stats.sellsFail += 1;
        const reason = String(ev.reason ?? 'sell_failed');
        bumpFail(failReasonsCount, reason);
        pushNote(tl, ts, `Sell FAILED · $${sizeUsd} · ${reason}`, {
          spotPxUsd: exitPx > 0 ? exitPx : null,
          amountUsd: sizeUsd > 0 ? sizeUsd : null,
          txSignature: txSig,
        });
      }
      continue;
    }

    if (kind === 'entry' || kind === 'execution_result') {
      const side = String(ev.side ?? '');
      const status = String(ev.status ?? '');
      const txSig = typeof ev.txSignature === 'string' ? ev.txSignature : null;
      if (side === 'buy' && status && status !== 'confirmed') {
        pushNote(tl, ts, `Buy tx ${status}${ev.error ? ` · ${String(ev.error).slice(0, 80)}` : ''}`, {
          txSignature: txSig,
        });
      }
    }
  }

  const stateCounts = readStateCounts(statePath);
  stats.pendingBuys = stateCounts.pendingBuys;
  stats.pendingSells = stateCounts.pendingSells;

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
