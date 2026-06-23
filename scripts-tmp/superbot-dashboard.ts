import fs from 'node:fs';
import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

export type SuperbotDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Array<Record<string, unknown>>;
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
  hbOpen: number;
  hbClosed: number;
  superbot?: {
    signalsSeen: number;
    racesAttempted: number;
    racesBlocked: number;
    executionMode: string | null;
    streamConnected: boolean;
  };
};

type TriggerCtx = {
  extSellUsd: number;
  extSellSignature: string;
  triggerPool: string;
  sellerWallet: string | null;
  extPriceUsd: number | null;
  ts: number;
};

type OpenPos = {
  mint: string;
  symbol: string;
  pool: string;
  entryTs: number;
  entryPriceUsd: number;
  entryMcapUsd: number | null;
  totalInvestedUsd: number;
  remainingFraction: number;
  trigger: TriggerCtx;
  buyTx: string | null;
  timeline: TimelineEvent[];
  peakPnlPct: number;
  shadowOnly: boolean;
};

function* journalLines(filePath: string): Generator<string> {
  yield* iterJsonlLinesBounded(filePath, TAIL_BYTES, FULL_SCAN_MAX);
}

function fmtMsk(ts: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ts));
}

function shortWallet(w: string | null | undefined): string {
  const s = String(w ?? '').trim();
  if (s.length < 8) return s || 'unknown';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function exitReasonLabel(raw: string): string {
  const r = raw.trim().toLowerCase();
  if (r === 'tp1_partial' || r === 'tp1') return 'TP1';
  if (r === 'tp2_full' || r === 'tp2') return 'TP2';
  if (r === 'stop_loss' || r === 'sl') return 'SL';
  if (r === 'take_profit') return 'TP';
  return raw.toUpperCase();
}

function normalizeExitReason(raw: string): string {
  const r = raw.trim().toLowerCase();
  if (r === 'stop_loss' || r === 'sl') return 'SL';
  if (r === 'tp1_partial' || r === 'tp1') return 'TP';
  if (r === 'tp2_full' || r === 'tp2') return 'TP';
  return 'NO_DATA';
}

function triggerNote(t: TriggerCtx): string {
  const usd = t.extSellUsd > 0 ? `$${t.extSellUsd.toFixed(0)}` : 'n/a';
  return `Preset C dips (legacy race journal): внешняя продажа ${usd} от ${shortWallet(t.sellerWallet)} · pool ${shortWallet(t.triggerPool)}`;
}

function pushTimeline(tl: TimelineEvent[], ev: TimelineEvent): void {
  tl.push(ev);
}

/** @internal MSK formatter for tests and API consumers. */
export function formatSuperbotMskTs(ts: number): string {
  return fmtMsk(ts);
}

function triggerFromEvent(o: Record<string, unknown>, ts: number): TriggerCtx {
  return {
    extSellUsd: num(o.extSellUsd ?? o.sellUsd) ?? 0,
    extSellSignature: str(o.extSellSignature ?? o.sellSignature) ?? '',
    triggerPool: str(o.triggerPool ?? o.pool) ?? '',
    sellerWallet: str(o.sellerWallet),
    extPriceUsd: num(o.priceUsd ?? o.extPriceUsd),
    ts,
  };
}

function emptyLoad(): SuperbotDashboardLoad {
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
    hbOpen: 0,
    hbClosed: 0,
  };
}

export function loadSuperbotJsonlForDashboard(filePath: string): SuperbotDashboardLoad {
  if (!fs.existsSync(filePath)) return emptyLoad();

  const openMap = new Map<string, OpenPos>();
  const closed: Array<Record<string, unknown>> = [];
  const failReasonsCount = new Map<string, number>();
  const openTimelines = new Map<string, TimelineEvent[]>();
  const pendingTrigger = new Map<string, TriggerCtx>();

  let firstTs = Date.now();
  let lastTs = 0;
  let resetTs = 0;
  const since1h = Date.now() - 3_600_000;
  let evals1h = 0;
  let passed1h = 0;
  let hbOpen = 0;
  let hbClosed = 0;
  let signalsSeen = 0;
  let racesAttempted = 0;
  let racesBlocked = 0;
  let executionMode: string | null = null;
  let streamConnected = false;

  const poolKey = (mint: string, pool: string) => `${mint}:${pool}`;

  for (const line of journalLines(filePath)) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = typeof o.ts === 'number' ? o.ts : 0;
    if (ts) {
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }

    const kind = String(o.kind ?? '');
    const mint = str(o.mint);
    const pool = str(o.pool ?? o.triggerPool) ?? '';

    if (kind === 'boot') {
      executionMode = str(o.mode) ?? executionMode;
      continue;
    }

    if (kind === 'heartbeat') {
      hbOpen = Number(o.openCount ?? 0);
      hbClosed = closed.length;
      streamConnected = Boolean(o.streamConnected);
      signalsSeen = Number(o.signalsSeen ?? signalsSeen);
      racesAttempted = Number(o.racesAttempted ?? racesAttempted);
      racesBlocked = Number(o.racesBlocked ?? racesBlocked);
      continue;
    }

    if (kind === 'ext_sell_detected' && mint) {
      const trig = triggerFromEvent(o, ts);
      pendingTrigger.set(poolKey(mint, pool || trig.triggerPool), trig);
      if (ts >= since1h) evals1h += 1;
      continue;
    }

    if (kind === 'race_blocked' && mint) {
      racesBlocked += 1;
      const reason = str(o.blockReason) ?? 'blocked';
      failReasonsCount.set(reason, (failReasonsCount.get(reason) ?? 0) + 1);
      continue;
    }

    if (kind === 'race_buy_fail' && mint) {
      if (ts >= since1h) evals1h += 1;
      const reason = str(o.reason) ?? 'race_buy_fail';
      failReasonsCount.set(reason, (failReasonsCount.get(reason) ?? 0) + 1);
      continue;
    }

    const entryKinds = new Set(['race_buy_ok', 'shadow_would_buy']);
    if (entryKinds.has(kind) && mint) {
      if (ts >= since1h) {
        evals1h += 1;
        passed1h += 1;
      }
      const trig =
        pendingTrigger.get(poolKey(mint, pool)) ??
        triggerFromEvent(o, ts);
      const entryPrice = num(o.buyPrice ?? o.fillPriceUsd) ?? num(o.priceUsd) ?? 0;
      const legUsd = num(o.legUsd) ?? 0;
      const mcap = num(o.mcapAtBuy ?? o.marketCapUsd);
      const buyTx = str(o.txSignature ?? o.buyTxSignature);
      const shadowOnly = kind === 'shadow_would_buy';
      const symbol = str(o.symbol) ?? mint.slice(0, 6);
      const detectMs = num(o.detectMs);
      const raceMs = num(o.detectToRaceMs);

      const timeline: TimelineEvent[] = [];
      pushTimeline(timeline, {
        ts: trig.ts || ts,
        kind: 'strategy_note',
        label: triggerNote(trig),
        mcUsd: mcap,
        spotPxUsd: trig.extPriceUsd,
        sizePct: null,
        pnlPct: null,
        pnlUsd: null,
        reason: 'ext_sell',
        remainingFraction: null,
        amountUsd: trig.extSellUsd > 0 ? trig.extSellUsd : null,
        txSignature: trig.extSellSignature || null,
      });

      const lagBits: string[] = [];
      if (detectMs != null) lagBits.push(`detect ${detectMs}ms`);
      if (raceMs != null) lagBits.push(`race ${raceMs}ms`);
      const lagTail = lagBits.length ? ` · ${lagBits.join(', ')}` : '';

      pushTimeline(timeline, {
        ts,
        kind: 'open',
        label: shadowOnly
          ? `Shadow: купили бы $${legUsd.toFixed(0)} @ ${entryPrice > 0 ? entryPrice.toFixed(8) : 'n/a'}${lagTail}`
          : `Preset C · вход $${legUsd.toFixed(0)} @ ${entryPrice > 0 ? entryPrice.toFixed(8) : 'n/a'}${lagTail}`,
        mcUsd: mcap,
        spotPxUsd: entryPrice > 0 ? entryPrice : null,
        sizePct: null,
        pnlPct: null,
        pnlUsd: null,
        reason: shadowOnly ? 'shadow_would_buy' : 'race_buy',
        remainingFraction: 1,
        amountUsd: legUsd > 0 ? legUsd : null,
        txSignature: buyTx,
      });

      if (shadowOnly) {
        const closedRow = {
          mint,
          symbol,
          entryTs: ts,
          exitTs: ts,
          entryPriceUsd: entryPrice,
          exitPriceUsd: entryPrice,
          pnlPct: 0,
          pnlUsd: 0,
          netPnlUsd: 0,
          exitReason: 'NO_DATA',
          durationMin: 0,
          totalInvestedUsd: legUsd,
          peakPnlPct: 0,
          __timeline: timeline,
          shadowOnly: true,
        };
        closed.unshift(closedRow);
        pendingTrigger.delete(poolKey(mint, pool));
        continue;
      }

      openMap.set(mint, {
        mint,
        symbol,
        pool: pool || trig.triggerPool,
        entryTs: ts,
        entryPriceUsd: entryPrice,
        entryMcapUsd: mcap,
        totalInvestedUsd: legUsd,
        remainingFraction: 1,
        trigger: trig,
        buyTx,
        timeline,
        peakPnlPct: 0,
        shadowOnly: false,
      });
      openTimelines.set(mint, timeline);
      pendingTrigger.delete(poolKey(mint, pool));
      continue;
    }

    if (kind === 'position_partial_sell' && mint) {
      const pos = openMap.get(mint);
      if (!pos) continue;
      const sellPrice = num(o.sellPriceUsd) ?? 0;
      const pnlPct = num(o.pnlPct) ?? 0;
      const frac = num(o.sellFraction) ?? 0.7;
      pos.peakPnlPct = Math.max(pos.peakPnlPct, pnlPct);
      pos.remainingFraction = Math.max(0, 1 - frac);
      pushTimeline(pos.timeline, {
        ts,
        kind: 'partial_sell',
        label: `${exitReasonLabel(String(o.sellReason ?? 'TP1'))} · wave B ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% → partial ${Math.round(frac * 100)}% @ ${sellPrice > 0 ? sellPrice.toFixed(8) : 'n/a'}`,
        mcUsd: num(o.mcapAtSell ?? o.marketCapUsd),
        spotPxUsd: sellPrice > 0 ? sellPrice : null,
        sizePct: frac * 100,
        pnlPct,
        pnlUsd: num(o.proceedsUsd),
        reason: exitReasonLabel(String(o.sellReason ?? 'TP1')),
        remainingFraction: pos.remainingFraction,
        amountUsd: num(o.proceedsUsd),
        txSignature: str(o.txSignature),
      });
      openTimelines.set(mint, pos.timeline);
      continue;
    }

    const closeKinds = new Set(['position_close', 'round_trip']);
    if (closeKinds.has(kind) && mint) {
      const pos = openMap.get(mint);
      const sellPrice = num(o.sellPriceUsd ?? o.exitPriceUsd) ?? 0;
      const pnlPct = num(o.pnlPct) ?? 0;
      const pnlUsd = num(o.pnlUsd ?? o.netPnlUsd) ?? 0;
      const sellReason = exitReasonLabel(String(o.sellReason ?? o.exitReason ?? 'close'));
      const inv = num(o.investedUsd) ?? pos?.totalInvestedUsd ?? 0;
      const entryTs = pos?.entryTs ?? ts;
      const timeline = pos?.timeline ?? [];

      if (pos) {
        pushTimeline(timeline, {
          ts,
          kind: 'close',
          label: `Preset C · wave B · ${sellReason} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% → закрыли @ ${sellPrice > 0 ? sellPrice.toFixed(8) : 'n/a'}`,
          mcUsd: num(o.mcapAtSell ?? o.marketCapUsd),
          spotPxUsd: sellPrice > 0 ? sellPrice : null,
          sizePct: null,
          pnlPct,
          pnlUsd,
          reason: sellReason,
          remainingFraction: 0,
          amountUsd: inv > 0 ? inv : null,
          txSignature: str(o.txSignature ?? o.sellTxSignature),
        });
      }

      closed.unshift({
        mint,
        symbol: pos?.symbol ?? str(o.symbol) ?? mint.slice(0, 6),
        entryTs,
        exitTs: ts,
        entryPriceUsd: pos?.entryPriceUsd ?? num(o.buyPrice) ?? 0,
        exitPriceUsd: sellPrice,
        pnlPct,
        pnlUsd,
        netPnlUsd: pnlUsd,
        exitReason: normalizeExitReason(String(o.sellReason ?? o.exitReason ?? sellReason)),
        durationMin: Math.round((ts - entryTs) / 60_000),
        totalInvestedUsd: inv,
        peakPnlPct: pos?.peakPnlPct ?? Math.max(0, pnlPct),
        entryMcapAtBuyUsd: pos?.entryMcapUsd ?? num(o.mcapAtBuy),
        __timeline: timeline,
        extSellUsd: pos?.trigger.extSellUsd ?? num(o.extSellUsd),
        sellerWallet: pos?.trigger.sellerWallet ?? str(o.sellerWallet),
        triggerPool: pos?.trigger.triggerPool ?? pool,
      });

      openMap.delete(mint);
      openTimelines.delete(mint);
      hbClosed = closed.length;
      continue;
    }
  }

  const open: Paper2OpenItem[] = [...openMap.values()].map((p) => ({
    mint: p.mint,
    symbol: p.symbol,
    entryTs: p.entryTs,
    entryMcUsd: p.entryMcapUsd ?? 0,
    entryRealMcUsd: p.entryMcapUsd,
    baselinePriceUsd: p.entryPriceUsd > 0 ? p.entryPriceUsd : null,
    openedAtIso: new Date(p.entryTs).toISOString(),
    lane: 'pumpswap',
    source: 'pumpswap',
    metricType: 'mc',
    features: null,
    btc: null,
    peakMcUsd: 0,
    peakPnlPct: p.peakPnlPct,
    trailingArmed: false,
    totalInvestedUsd: p.totalInvestedUsd,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: null,
    entryPriceVerifyImpactPct: null,
    entryPriceVerifySource: null,
    pairAddress: p.pool || null,
    entryLiqUsd: null,
    remainingFraction: p.remainingFraction,
  }));

  const failReasons = [...failReasonsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  return {
    open,
    closed,
    firstTs,
    lastTs,
    resetTs,
    evals1h,
    passed1h,
    failReasons,
    openTimelines,
    hbOpen,
    hbClosed,
    superbot: {
      signalsSeen,
      racesAttempted,
      racesBlocked,
      executionMode,
      streamConnected,
    },
  };
}

export function aggregateSuperbotJsonlForDashboard(filePath: string): {
  strategyId: string;
  file: string;
  openCount: number;
  closedCount: number;
  evals1h: number;
  passed1h: number;
  superbot?: SuperbotDashboardLoad['superbot'];
} {
  const ll = loadSuperbotJsonlForDashboard(filePath);
  return {
    strategyId: 'superbot',
    file: filePath,
    openCount: Math.max(ll.open.length, ll.hbOpen),
    closedCount: Math.max(ll.closed.length, ll.hbClosed),
    evals1h: ll.evals1h,
    passed1h: ll.passed1h,
    superbot: ll.superbot,
  };
}
