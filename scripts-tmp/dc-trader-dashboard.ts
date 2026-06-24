/**
 * DCA Trader (dc-trader) — dashboard loader for `/papertrader2` tile 3.
 * Reads `/opt/dc-trader/data/trader-journal.jsonl` + `trader-state.json`.
 * PnL SSOT: on-chain SOL (`pnlSol` / entrySolSpent − exitSolReceived) from journal sells.
 */
import fs from 'node:fs';
import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type DcTraderPositionRow = {
  positionId: string;
  mint: string;
  symbol: string;
  tokenName: string | null;
  vault: string;
  status: 'watching' | 'entered' | 'exited' | 'skipped';
  watchTs: number;
  entryTs: number | null;
  exitTs: number | null;
  entrySolSpent: number | null;
  entrySizeUsd: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  exitReason: string | null;
  depositSolEquiv: number | null;
  fills: number | null;
  cadenceSec: number | null;
  classification: string | null;
};

export type DcTraderExitBreakdown = Record<
  string,
  { count: number; sumPct: number; sumUsd: number; sumSol: number; avgPct: number }
>;

export type DcTraderDashboardStats = {
  watching: number;
  entered: number;
  exited: number;
  skipped: number;
  buysOk: number;
  buysTotal: number;
  sellsOk: number;
  sellsFail: number;
  signals1h: number;
  positions: DcTraderPositionRow[];
  /** Realized exit reasons from journal sells / sync (not Oscar TP/TRAIL). */
  exitBreakdown: DcTraderExitBreakdown;
};

export type DcTraderDashboardLoad = {
  /** Entered (bought) vaults only — shown as open positions. */
  open: Paper2OpenItem[];
  /** Watching vaults — separate collapsible Monitoring section in UI. */
  watchingOpen: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
  dcTrader: DcTraderDashboardStats;
};

type VaultState = {
  openSignature: string;
  vault: string;
  targetMint: string;
  tokenSymbol: string;
  tokenName?: string;
  status: string;
  openTsSec?: number;
  enteredAt?: string;
  entrySignature?: string;
  entrySolSpent?: number;
  entrySizeUsd?: number;
  entryPriceUsd?: number;
  depositSolEquiv?: number;
  lastFillCount?: number;
  lastClassification?: string;
  lastCadenceSec?: number;
  maxPctFromEntry?: number;
  minPctFromEntry?: number;
  exitTriggerReason?: string;
  skipReason?: string;
};

type JournalEv = Record<string, unknown>;

function* journalLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesBounded(filePath, TAIL_BYTES, FULL_SCAN_MAX);
}

function tsMs(ev: JournalEv): number {
  const t = ev.ts;
  if (typeof t === 'number' && t > 0) return t;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pushTimeline(
  tl: TimelineEvent[],
  ev: Partial<TimelineEvent> & { ts: number; kind: TimelineEvent['kind']; label: string },
): void {
  tl.push({
    mcUsd: ev.mcUsd ?? null,
    spotPxUsd: ev.spotPxUsd ?? null,
    sizePct: ev.sizePct ?? null,
    pnlPct: ev.pnlPct ?? null,
    pnlUsd: ev.pnlUsd ?? null,
    reason: ev.reason ?? null,
    remainingFraction: ev.remainingFraction ?? null,
    amountUsd: ev.amountUsd ?? null,
    contextNote: ev.contextNote ?? null,
    txSignature: ev.txSignature ?? null,
    ts: ev.ts,
    kind: ev.kind,
    label: ev.label,
  });
}

type BuySnapshot = { entrySolSpent: number; entrySizeUsd: number | null; entryPriceUsd: number | null; marketSolUsd: number | null };

/** PnL SSOT: on-chain SOL (exitSol − entrySol). Ignore legacy price-band pnlPct when SOL missing. */
function pnlFromSell(
  ev: JournalEv,
  buy: BuySnapshot | null,
): {
  pnlSol: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
} {
  const entrySol = num(ev.entrySolSpent) ?? buy?.entrySolSpent ?? null;
  const exitSol = num(ev.exitSolReceived);
  let pnlSol = num(ev.pnlSol);
  if (pnlSol == null && entrySol != null && exitSol != null) {
    pnlSol = +(exitSol - entrySol).toFixed(9);
  }
  if (pnlSol == null || entrySol == null || entrySol <= 0) {
    return { pnlSol: null, pnlPct: null, pnlUsd: null };
  }
  const pnlPct = +((pnlSol / entrySol) * 100).toFixed(4);
  const solUsd = num(ev.marketSolUsd) ?? buy?.marketSolUsd ?? null;
  let pnlUsd: number | null = null;
  if (solUsd != null && solUsd > 0) {
    pnlUsd = +(pnlSol * solUsd).toFixed(2);
  } else {
    const entryUsd = num(ev.entrySizeUsd) ?? buy?.entrySizeUsd ?? null;
    if (entryUsd != null && entryUsd > 0) pnlUsd = +((entryUsd * pnlPct) / 100).toFixed(2);
  }
  return { pnlSol, pnlPct, pnlUsd };
}

function fmtSolContext(sol: number | null): string | null {
  if (sol == null || !Number.isFinite(sol)) return null;
  return `${sol >= 0 ? '+' : ''}${sol.toFixed(4)} SOL on-chain`;
}

function buildTimelineForSig(sig: string, events: JournalEv[], vault: VaultState): TimelineEvent[] {
  const tl: TimelineEvent[] = [];
  const sorted = events.slice().sort((a, b) => tsMs(a) - tsMs(b));
  let lastBand: string | null = null;
  const vaultAddr = vault.vault || (typeof sorted[0]?.vault === 'string' ? String(sorted[0].vault) : '');

  for (const ev of sorted) {
    const ts = tsMs(ev);
    if (!ts) continue;
    const action = String(ev.action ?? '');

    if (action === 'watch' || action === 'watch_telegram') {
      const dep = num(ev.depositSolEquiv);
      const src = action === 'watch_telegram' ? 'Telegram alerter' : 'DCA deposit';
      pushTimeline(tl, {
        ts,
        kind: 'strategy_note',
        label: 'Watch · vault detected',
        contextNote: [
          src,
          dep != null ? `deposit ~${dep.toFixed(1)} SOL eq` : null,
          vaultAddr ? `vault ${vaultAddr.slice(0, 8)}…` : null,
          ev.classification ? String(ev.classification) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        txSignature: typeof ev.signature === 'string' ? ev.signature : sig,
      });
      continue;
    }

    if (action === 'buy') {
      const usd = num(ev.usd);
      const px = num(ev.entryPriceUsd);
      const entrySol = num(ev.entrySolSpent) ?? vault.entrySolSpent ?? null;
      pushTimeline(tl, {
        ts,
        kind: 'open',
        label: `Buy · $${usd != null ? usd.toFixed(0) : '?'}`,
        amountUsd: usd,
        spotPxUsd: px,
        txSignature: typeof ev.entrySig === 'string' ? ev.entrySig : typeof ev.signature === 'string' ? ev.signature : null,
        contextNote: [
          entrySol != null ? `spent ${entrySol.toFixed(4)} SOL` : null,
          ev.fills != null ? `${ev.fills} vault fills` : null,
          ev.cadenceSec != null ? `cadence ${ev.cadenceSec}s` : null,
          ev.entryMode ? String(ev.entryMode) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      continue;
    }

    if (action === 'price_band') {
      const band = String(ev.band ?? '');
      if (band && band === lastBand) continue;
      lastBand = band;
      const pct = num(ev.pctFromEntry);
      pushTimeline(tl, {
        ts,
        kind: 'strategy_note',
        label: `Band ${band || '?'} · ${pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : 'hold'}`,
        pnlPct: pct,
        spotPxUsd: num(ev.currentPrice),
        contextNote: 'price band +3% ladder from entry',
      });
      continue;
    }

    if (action === 'price_band_summary') {
      pushTimeline(tl, {
        ts,
        kind: 'strategy_note',
        label: `Hold summary · ${String(ev.exitReason ?? 'exit')}`,
        pnlPct: num(ev.maxPctFromEntry),
        contextNote: [
          ev.holdSec != null ? `hold ${Math.round(Number(ev.holdSec) / 60)}m` : null,
          ev.highestBand != null ? `peak band ${ev.highestBand}` : null,
          ev.lowestBand != null ? `low band ${ev.lowestBand}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      continue;
    }

    if (action === 'sell') {
      const ok = ev.ok === true;
      const buySnap: BuySnapshot | null =
        vault.entrySolSpent != null
          ? {
              entrySolSpent: vault.entrySolSpent,
              entrySizeUsd: vault.entrySizeUsd ?? null,
              entryPriceUsd: vault.entryPriceUsd ?? null,
              marketSolUsd: null,
            }
          : null;
      const { pnlSol, pnlPct, pnlUsd } = pnlFromSell(ev, buySnap);
      pushTimeline(tl, {
        ts,
        kind: ok ? 'close' : 'strategy_note',
        label: ok
          ? `Sell · ${pnlPct != null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : 'closed'}`
          : `Sell failed · ${String(ev.reason ?? 'retry').slice(0, 40)}`,
        pnlPct,
        pnlUsd,
        amountUsd: ok ? num(ev.entrySizeUsd) ?? vault.entrySizeUsd ?? null : null,
        reason: ok ? String(ev.exitReason ?? 'sell') : String(ev.reason ?? 'sell_fail'),
        txSignature:
          typeof ev.exitSig === 'string'
            ? ev.exitSig
            : typeof ev.signature === 'string'
              ? ev.signature
              : null,
        contextNote: fmtSolContext(pnlSol),
      });
      continue;
    }

    if (action === 'sell_fail') {
      pushTimeline(tl, {
        ts,
        kind: 'strategy_note',
        label: `Sell retry · ${String(ev.reason ?? 'fail').slice(0, 48)}`,
        pnlPct: num(ev.pnlPct),
        pnlUsd: num(ev.pnlUsd),
        contextNote: fmtSolContext(num(ev.pnlSol)),
      });
      continue;
    }

    if (action === 'sync_wallet_flat' || action === 'sync_vault_closed') {
      const buySnap: BuySnapshot | null =
        vault.entrySolSpent != null
          ? {
              entrySolSpent: vault.entrySolSpent,
              entrySizeUsd: vault.entrySizeUsd ?? null,
              entryPriceUsd: vault.entryPriceUsd ?? null,
              marketSolUsd: null,
            }
          : null;
      const { pnlSol, pnlPct, pnlUsd } = pnlFromSell(ev, buySnap);
      pushTimeline(tl, {
        ts,
        kind: 'close',
        label: action === 'sync_vault_closed' ? 'Exit · vault closed' : 'Exit · wallet flat',
        reason: String(ev.exitReason ?? (action === 'sync_vault_closed' ? 'vault_closed' : 'wallet_flat')),
        pnlPct,
        pnlUsd,
        txSignature: typeof ev.signature === 'string' ? ev.signature : null,
        contextNote: fmtSolContext(pnlSol),
      });
    }
  }

  return tl;
}

function emptyLoad(): DcTraderDashboardLoad {
  const now = Date.now();
  return {
    open: [],
    watchingOpen: [],
    closed: [],
    firstTs: now,
    lastTs: now,
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map(),
    dcTrader: {
      watching: 0,
      entered: 0,
      exited: 0,
      skipped: 0,
      buysOk: 0,
      buysTotal: 0,
      sellsOk: 0,
      sellsFail: 0,
      signals1h: 0,
      positions: [],
      exitBreakdown: {},
    },
  };
}

function mapVaultStatus(raw: string): DcTraderPositionRow['status'] {
  if (raw === 'entered') return 'entered';
  if (raw === 'exited') return 'exited';
  if (raw === 'skipped') return 'skipped';
  return 'watching';
}

function exitReasonLabel(vault: VaultState, lastSell: JournalEv | null): string {
  if (lastSell?.exitReason) return String(lastSell.exitReason);
  if (vault.exitTriggerReason) return vault.exitTriggerReason;
  if (vault.skipReason) return vault.skipReason;
  return 'EXIT';
}

/** Parse dc-trader journal + state for `/api/paper2` panel 3. */
export function loadDcTraderForDashboard(
  journalPath: string,
  statePath?: string,
): DcTraderDashboardLoad {
  if (!fs.existsSync(journalPath) && !(statePath && fs.existsSync(statePath))) {
    return emptyLoad();
  }

  const since1h = Date.now() - 3_600_000;
  let firstTs = Date.now();
  let lastTs = 0;
  const failReasonsCount = new Map<string, number>();

  const stats: DcTraderDashboardStats = {
    watching: 0,
    entered: 0,
    exited: 0,
    skipped: 0,
    buysOk: 0,
    buysTotal: 0,
    sellsOk: 0,
    sellsFail: 0,
    signals1h: 0,
    positions: [],
    exitBreakdown: {},
  };

  const eventsBySig = new Map<string, JournalEv[]>();
  const lastSellBySig = new Map<string, JournalEv>();
  const sellsBySig = new Map<string, JournalEv[]>();
  const buyBySig = new Map<string, BuySnapshot>();
  const syncExitBySig = new Map<string, JournalEv>();

  if (fs.existsSync(journalPath)) {
    for (const line of journalLines(journalPath)) {
      let ev: JournalEv;
      try {
        ev = JSON.parse(line) as JournalEv;
      } catch {
        continue;
      }
      const ts = tsMs(ev);
      if (ts) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      const sig = typeof ev.signature === 'string' ? ev.signature : '';
      if (!sig) continue;
      const bucket = eventsBySig.get(sig) ?? [];
      bucket.push(ev);
      eventsBySig.set(sig, bucket);

      const action = String(ev.action ?? '');
      if (action === 'watch' || action === 'watch_telegram') {
        if (ts >= since1h) stats.signals1h += 1;
      }
      if (action === 'buy') {
        stats.buysTotal += 1;
        stats.buysOk += 1;
        const entrySol = num(ev.entrySolSpent) ?? num(ev.solSpent);
        const entryUsd = num(ev.usd);
        if (entrySol != null && entrySol > 0) {
          buyBySig.set(sig, {
            entrySolSpent: entrySol,
            entrySizeUsd: entryUsd,
            entryPriceUsd: num(ev.entryPriceUsd),
            marketSolUsd: num(ev.marketSolUsd),
          });
        }
      }
      if (action === 'sell') {
        if (ev.ok === true) {
          stats.sellsOk += 1;
          lastSellBySig.set(sig, ev);
          const arr = sellsBySig.get(sig) ?? [];
          arr.push(ev);
          sellsBySig.set(sig, arr);
        } else {
          stats.sellsFail += 1;
          const reason = String(ev.reason ?? 'sell_fail').slice(0, 80);
          failReasonsCount.set(reason, (failReasonsCount.get(reason) ?? 0) + 1);
        }
      }
      if (action === 'sell_fail') {
        stats.sellsFail += 1;
        const reason = String(ev.reason ?? 'sell_fail').slice(0, 80);
        failReasonsCount.set(reason, (failReasonsCount.get(reason) ?? 0) + 1);
      }
      if (action === 'sync_wallet_flat' || action === 'sync_vault_closed') {
        syncExitBySig.set(sig, ev);
      }
    }
  }

  let vaults: VaultState[] = [];
  if (statePath && fs.existsSync(statePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { vaults?: VaultState[] };
      vaults = Array.isArray(raw.vaults) ? raw.vaults : [];
    } catch {
      vaults = [];
    }
  }

  const open: Paper2OpenItem[] = [];
  const watchingOpen: Paper2OpenItem[] = [];
  const closed: Array<Record<string, unknown>> = [];
  const openTimelines = new Map<string, TimelineEvent[]>();
  const positions: DcTraderPositionRow[] = [];

  for (const vault of vaults) {
    const sig = vault.openSignature;
    if (!sig) continue;
    const rawStatus = String(vault.status ?? 'watching');
    const status = mapVaultStatus(rawStatus);
    const mint = String(vault.targetMint ?? '').trim();
    const symbol = String(vault.tokenSymbol ?? (mint.slice(0, 6) || '?'));
    const posKey = mint || sig;
    const journalEvents = eventsBySig.get(sig) ?? [];
    const timeline = buildTimelineForSig(sig, journalEvents, vault);
    const buySnap = buyBySig.get(sig) ?? null;
    const hasBuy = buySnap != null;

    const watchTs =
      (vault.openTsSec != null && vault.openTsSec > 0 ? vault.openTsSec * 1000 : 0) ||
      (journalEvents.find((e) => e.action === 'watch') ? tsMs(journalEvents.find((e) => e.action === 'watch')!) : 0) ||
      firstTs;

    const entryTs = vault.enteredAt ? Date.parse(vault.enteredAt) : null;
    const lastSell = lastSellBySig.get(sig) ?? null;
    const syncExit = syncExitBySig.get(sig) ?? null;
    const exitTs = lastSell ? tsMs(lastSell) : syncExit ? tsMs(syncExit) : null;

    const entrySolSpent = vault.entrySolSpent ?? buySnap?.entrySolSpent ?? null;
    const entrySizeUsd = vault.entrySizeUsd ?? buySnap?.entrySizeUsd ?? null;
    const entryPx = vault.entryPriceUsd ?? buySnap?.entryPriceUsd ?? null;

    let pnlSol: number | null = null;
    let pnlPct: number | null = null;
    let pnlUsd: number | null = null;

    if (status === 'exited') {
      const okSells = sellsBySig.get(sig) ?? [];
      if (okSells.length) {
        let sumSol: number | null = null;
        let sumUsd: number | null = null;
        let lastPct: number | null = null;
        for (const s of okSells) {
          const p = pnlFromSell(s, buySnap);
          if (p.pnlSol != null) sumSol = (sumSol ?? 0) + p.pnlSol;
          if (p.pnlUsd != null) sumUsd = (sumUsd ?? 0) + p.pnlUsd;
          if (p.pnlPct != null) lastPct = p.pnlPct;
        }
        pnlSol = sumSol;
        pnlUsd = sumUsd;
        pnlPct = lastPct;
        if (pnlSol != null) pnlSol = +pnlSol.toFixed(9);
        if (pnlUsd != null) pnlUsd = +pnlUsd.toFixed(2);
      }
      // wallet_flat / sync without on-chain sell PnL → leave null (never use maxPctFromEntry)
    } else if (status === 'entered' && hasBuy) {
      const lastBand = [...journalEvents].reverse().find((e) => e.action === 'price_band');
      const bandPct = num(lastBand?.pctFromEntry);
      if (entrySolSpent != null && bandPct != null) {
        pnlSol = +((entrySolSpent * bandPct) / 100).toFixed(9);
        pnlPct = bandPct;
        const solUsd = buySnap?.marketSolUsd ?? num(lastBand?.marketSolUsd);
        if (solUsd != null && solUsd > 0) pnlUsd = +(pnlSol * solUsd).toFixed(2);
        else if (entrySizeUsd != null) pnlUsd = +((entrySizeUsd * bandPct) / 100).toFixed(2);
      }
    }

    if (status === 'watching') stats.watching += 1;
    else if (status === 'entered') stats.entered += 1;
    else if (status === 'exited') stats.exited += 1;
    else if (status === 'skipped') stats.skipped += 1;

    positions.push({
      positionId: sig,
      mint: mint || sig.slice(0, 12),
      symbol,
      tokenName: vault.tokenName ?? null,
      vault: vault.vault,
      status,
      watchTs,
      entryTs: entryTs && Number.isFinite(entryTs) ? entryTs : null,
      exitTs,
      entrySolSpent,
      entrySizeUsd,
      pnlSol,
      pnlPct,
      pnlUsd,
      exitReason: status === 'exited' ? exitReasonLabel(vault, lastSell) : null,
      depositSolEquiv: vault.depositSolEquiv ?? null,
      fills: vault.lastFillCount ?? null,
      cadenceSec: vault.lastCadenceSec ?? null,
      classification: vault.lastClassification ?? null,
    });

    if (status === 'skipped' || !mint) continue;

    const dcMeta = {
      positionId: sig,
      vault: vault.vault,
      tokenName: vault.tokenName ?? null,
      dcStatus: status,
      pnlSol,
      pnlPct,
      pnlUsd,
      entrySolSpent,
      entrySizeUsd,
      depositSolEquiv: vault.depositSolEquiv ?? null,
      fills: vault.lastFillCount ?? null,
      cadenceSec: vault.lastCadenceSec ?? null,
      classification: vault.lastClassification ?? null,
      watchTs,
      exitTs,
      hasBuy,
    };

    if (status === 'exited') {
      if (!hasBuy) continue;
      const exitReason = exitReasonLabel(vault, lastSell);
      const exitKey = exitReason || 'unknown';
      const eb = stats.exitBreakdown[exitKey] ?? { count: 0, sumPct: 0, sumUsd: 0, sumSol: 0, avgPct: 0 };
      eb.count += 1;
      if (pnlPct != null) eb.sumPct += pnlPct;
      if (pnlUsd != null) eb.sumUsd += pnlUsd;
      if (pnlSol != null) eb.sumSol += pnlSol;
      stats.exitBreakdown[exitKey] = eb;

      closed.push({
        mint,
        symbol,
        entryTs: entryTs ?? watchTs,
        exitTs: exitTs ?? lastTs,
        exitReason,
        pnlPct: pnlPct ?? 0,
        pnlUsd: pnlUsd ?? 0,
        netPnlUsd: pnlUsd ?? 0,
        pnlSol: pnlSol ?? null,
        entrySolSpent,
        entrySizeUsd,
        marketSolUsd: buySnap?.marketSolUsd ?? num(lastSell?.marketSolUsd) ?? null,
        baselinePriceUsd: entryPx,
        entryPx,
        durationMin: entryTs && exitTs ? Math.max(0, Math.round((exitTs - entryTs) / 60_000)) : 0,
        ...dcMeta,
        __timeline: timeline,
      });
      continue;
    }

    if (status === 'entered' && !hasBuy) continue;

    openTimelines.set(posKey, timeline);
    const investedUsd = entrySizeUsd ?? 0;
    const openRow: Paper2OpenItem = {
      mint: posKey,
      symbol,
      entryTs: entryTs ?? watchTs,
      entryMcUsd: entryPx ?? 0,
      entryRealMcUsd: null,
      baselinePriceUsd: entryPx,
      openedAtIso: entryTs ? new Date(entryTs).toISOString() : new Date(watchTs).toISOString(),
      lane: 'dc-trader',
      source: null,
      metricType: 'price',
      features: null,
      btc: null,
      peakMcUsd: entryPx ?? 0,
      peakPnlPct: vault.maxPctFromEntry ?? pnlPct ?? 0,
      trailingArmed: false,
      totalInvestedUsd: investedUsd,
      entryPriorityFeeUsd: null,
      entryPriceVerifySlipPct: null,
      entryPriceVerifyImpactPct: null,
      entryPriceVerifySource: null,
      pairAddress: null,
      entryLiqUsd: null,
      remainingFraction: status === 'entered' ? 1 : 0,
      liveOscarTradeLane: null,
      isScalpWave: false,
      ...dcMeta,
    };
    if (status === 'watching') watchingOpen.push(openRow);
    else if (status === 'entered') open.push(openRow);
  }

  for (const k of Object.keys(stats.exitBreakdown)) {
    const eb = stats.exitBreakdown[k]!;
    eb.avgPct = eb.count ? eb.sumPct / eb.count : 0;
  }

  open.sort((a, b) => (b.entryTs ?? 0) - (a.entryTs ?? 0));
  watchingOpen.sort((a, b) => (b.watchTs ?? b.entryTs ?? 0) - (a.watchTs ?? a.entryTs ?? 0));

  positions.sort((a, b) => (b.entryTs ?? b.watchTs) - (a.entryTs ?? a.watchTs));
  stats.positions = positions.slice(0, 40);

  const failReasons = [...failReasonsCount.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    open,
    watchingOpen,
    closed,
    firstTs,
    lastTs: lastTs || firstTs,
    resetTs: 0,
    evals1h: stats.signals1h,
    passed1h: stats.buysOk,
    failReasons,
    openTimelines,
    dcTrader: stats,
  };
}
