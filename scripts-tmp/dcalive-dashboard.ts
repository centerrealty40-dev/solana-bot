/**
 * DCA Live (dcafr-live / dcalive) — dashboard loader for `/papertrader2`.
 * Reads `dcalive_positions` + `dcalive_fills` from PG; optional JSONL for execution_blocked tallies.
 * Timelines mirror Live Oscar panel shape (open / DCA avg-down / TP partial / close + strategy notes).
 */
import fs from 'node:fs';
import type postgres from 'postgres';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';
import type { Paper2OpenItem, TimelineEvent } from './dashboard-server.js';

const TAIL_BYTES = Number(process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024);
const FULL_SCAN_MAX = Number(process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024);

type Paper2ClosedRow = Record<string, unknown>;

export type DcaliveDashboardLoad = {
  open: Paper2OpenItem[];
  closed: Paper2ClosedRow[];
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  openTimelines: Map<string, TimelineEvent[]>;
};

type PgPositionRow = {
  id: number;
  mint: string;
  symbol: string | null;
  source: string;
  planned_cycles: number;
  cycle_usd: number;
  cycle_freq_sec: number;
  deposit_usd: number;
  open_ts: Date | null;
  est_gain_pct: number | null;
  state: string;
  qty_token: number;
  cost_usd: number;
  avg_entry_price: number;
  init_entry_price: number;
  realized_usd: number;
  max_capital_usd: number;
  dd_steps_hit: number;
  tp_steps_hit: number;
  close_reason: string | null;
  entered_at: Date | null;
  closed_at: Date | null;
  updated_at: Date;
};

type PgFillRow = {
  position_id: number;
  side: string;
  reason: string;
  price_usd: number;
  qty_token: number;
  usd: number;
  cycle_index: number | null;
  realized_usd: number | null;
  tx_signature: string | null;
  dry_run: boolean;
  ts: Date;
};

const STRATEGY_ID = 'dca-live'; // panel id for timeline context (reserved)

function tsMs(d: Date | null | undefined): number {
  if (!d) return 0;
  const n = d.getTime();
  return Number.isFinite(n) ? n : 0;
}

function pushTimeline(tl: TimelineEvent[], ev: Partial<TimelineEvent> & { ts: number; kind: TimelineEvent['kind']; label: string }): void {
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

function signalContextNote(row: PgPositionRow): string {
  const parts: string[] = [];
  if (row.deposit_usd > 0) parts.push(`ордер ~$${Math.round(row.deposit_usd)}`);
  if (row.planned_cycles > 0) parts.push(`${row.planned_cycles} циклов`);
  if (row.cycle_usd > 0) parts.push(`$${Math.round(row.cycle_usd)}/цикл`);
  if (row.est_gain_pct != null && Number.isFinite(row.est_gain_pct)) {
    parts.push(`impact ~${row.est_gain_pct.toFixed(1)}%`);
  }
  if (row.source) parts.push(`источник ${row.source}`);
  return parts.join(' · ');
}

function skipLabel(reason: string | null): string {
  const r = (reason || 'skipped').trim();
  if (r === 'ended_before_entry') return 'Сигнал: ордер завершён до входа';
  if (r === 'open_too_old') return 'Сигнал: слишком поздно (возраст open)';
  if (r.startsWith('too_late(')) return `Сигнал: поздно (${r.slice(9, -1)} циклов keeper)`;
  if (r.startsWith('est_gain_below_min')) return 'Сигнал: price impact ниже минимума';
  return `Сигнал пропущен: ${r}`;
}

function mapExitReason(reason: string | null): string {
  const r = (reason || 'CLOSE').trim();
  if (r === 'completed') return 'TIMEOUT';
  if (r === 'take_profit' || r.startsWith('tp_')) return 'TP';
  if (r.includes('cancel') || r.includes('loss')) return 'SL';
  if (r.startsWith('exit_pre')) return 'TP';
  return r.toUpperCase().slice(0, 24);
}

function buildPositionTimeline(pos: PgPositionRow, fills: PgFillRow[]): TimelineEvent[] {
  const tl: TimelineEvent[] = [];
  let ddSeen = 0;
  let remainingFraction = 1;

  if (fills.length === 0 && pos.state === 'skipped') {
    const openTs = tsMs(pos.open_ts) || tsMs(pos.updated_at);
    pushTimeline(tl, {
      ts: openTs,
      kind: 'strategy_note',
      label: skipLabel(pos.close_reason),
      contextNote: signalContextNote(pos),
    });
    return tl;
  }

  if (fills.length === 0 && ['scoring', 'armed'].includes(pos.state)) {
    const openTs = tsMs(pos.open_ts) || tsMs(pos.updated_at);
    pushTimeline(tl, {
      ts: openTs,
      kind: 'strategy_note',
      label: 'Сигнал в очереди · scoring/armed',
      contextNote: signalContextNote(pos),
    });
    return tl;
  }

  for (const fill of fills) {
    if (fill.side === 'buy' && fill.reason === 'avg_down') ddSeen += 1;
    const ts = tsMs(fill.ts);
    if (fill.side === 'buy') {
      if (fill.reason === 'entry_pre_cycle1' || fill.reason === 'entry') {
        pushTimeline(tl, {
          ts,
          kind: 'open',
          label:
            fill.reason === 'entry_pre_cycle1'
              ? 'Вход до 1-го цикла keeper · DCA frontrun'
              : 'Вход по сигналу · DCA frontrun',
          spotPxUsd: fill.price_usd,
          amountUsd: fill.usd,
          remainingFraction: 1,
          contextNote: signalContextNote(pos),
          txSignature: fill.tx_signature,
        });
      } else if (fill.reason === 'avg_down') {
        pushTimeline(tl, {
          ts,
          kind: 'dca_add',
          label: `DCA frontrun · докупка $${Math.round(fill.usd)} (avg-down шаг ${ddSeen})`,
          spotPxUsd: fill.price_usd,
          amountUsd: fill.usd,
          reason: 'dca',
          contextNote: 'Усреднение −5% от якоря входа (DCALIVE_AVG_DOWN_STEP_PCT)',
          txSignature: fill.tx_signature,
        });
      } else {
        pushTimeline(tl, {
          ts,
          kind: 'strategy_note',
          label: `Покупка · ${fill.reason} · $${Math.round(fill.usd)}`,
          amountUsd: fill.usd,
          txSignature: fill.tx_signature,
        });
      }
    } else if (fill.side === 'sell') {
      if (fill.reason === 'take_profit') {
        remainingFraction = Math.max(0, remainingFraction - 0.2);
        const realized = Number(fill.realized_usd ?? 0);
        pushTimeline(tl, {
          ts,
          kind: 'partial_sell',
          label: 'TP-сетка DCA · +5% шаг · 20% остатка',
          spotPxUsd: fill.price_usd,
          sizePct: 0.2,
          pnlUsd: realized,
          amountUsd: fill.usd,
          remainingFraction,
          reason: 'TP_LADDER',
          contextNote: 'DCALIVE_TP_STEP_PCT / DCALIVE_TP_SELL_FRACTION',
          txSignature: fill.tx_signature,
        });
      } else {
        remainingFraction = 0;
        const realized = Number(fill.realized_usd ?? pos.realized_usd ?? 0);
        pushTimeline(tl, {
          ts,
          kind: 'close',
          label: `Выход · ${fill.reason}`,
          spotPxUsd: fill.price_usd,
          pnlUsd: realized,
          amountUsd: fill.usd,
          remainingFraction: 0,
          reason: mapExitReason(fill.reason),
          txSignature: fill.tx_signature,
        });
      }
    }
  }

  if (
    ['closed', 'skipped'].includes(pos.state) &&
    fills.length > 0 &&
    tl[tl.length - 1]?.kind !== 'close'
  ) {
    const ts = tsMs(pos.closed_at) || tsMs(pos.updated_at);
    pushTimeline(tl, {
      ts,
      kind: 'close',
      label: `Закрыто · ${pos.close_reason || 'closed'}`,
      pnlUsd: pos.realized_usd,
      reason: mapExitReason(pos.close_reason),
      remainingFraction: 0,
    });
  }

  return tl;
}

function positionToOpenItem(pos: PgPositionRow, fills: PgFillRow[]): Paper2OpenItem {
  const entryTs = tsMs(pos.entered_at) || tsMs(pos.open_ts) || tsMs(pos.updated_at);
  const firstBuy = fills.find((f) => f.side === 'buy');
  const baseline = firstBuy?.price_usd ?? pos.avg_entry_price ?? pos.init_entry_price;
  const invested = pos.cost_usd > 0 ? pos.cost_usd : pos.max_capital_usd;
  return {
    mint: pos.mint,
    symbol: pos.symbol ?? pos.mint.slice(0, 8),
    entryTs,
    entryMcUsd: 0,
    entryRealMcUsd: null,
    baselinePriceUsd: baseline > 0 ? baseline : null,
    openedAtIso: entryTs ? new Date(entryTs).toISOString() : null,
    lane: 'dca_frontrun',
    source: pos.source || 'swap_exec_dca',
    metricType: 'price',
    features: {
      deposit_usd: pos.deposit_usd,
      planned_cycles: pos.planned_cycles,
      cycle_usd: pos.cycle_usd,
      est_gain_pct: pos.est_gain_pct,
    },
    btc: null,
    peakMcUsd: 0,
    peakPnlPct: 0,
    trailingArmed: false,
    totalInvestedUsd: invested,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: null,
    entryPriceVerifyImpactPct:
      pos.est_gain_pct != null && Number.isFinite(pos.est_gain_pct) ? +pos.est_gain_pct.toFixed(2) : null,
    entryPriceVerifySource: null,
    pairAddress: null,
    entryLiqUsd: null,
    remainingFraction: pos.qty_token > 0 && pos.cost_usd > 0 ? 1 : 0,
  };
}

function positionToClosedRow(pos: PgPositionRow, fills: PgFillRow[], timeline: TimelineEvent[]): Paper2ClosedRow {
  const entryTs = tsMs(pos.entered_at) || tsMs(pos.open_ts) || tsMs(pos.updated_at);
  const exitTs = tsMs(pos.closed_at) || tsMs(pos.updated_at) || entryTs;
  const durationMin = entryTs > 0 && exitTs >= entryTs ? Math.round((exitTs - entryTs) / 60_000) : 0;
  const pnlUsd = pos.realized_usd;
  const pnlPct = pos.max_capital_usd > 0 ? (pnlUsd / pos.max_capital_usd) * 100 : 0;
  return {
    mint: pos.mint,
    symbol: pos.symbol ?? pos.mint.slice(0, 8),
    entryTs,
    exitTs,
    exitReason: pos.state === 'skipped' ? 'SKIP' : mapExitReason(pos.close_reason),
    pnlPct,
    pnlUsd,
    durationMin,
    __timeline: timeline,
    skipReason: pos.state === 'skipped' ? pos.close_reason : undefined,
    estGainPct: pos.est_gain_pct,
    depositUsd: pos.deposit_usd,
  };
}

function scanJournalFailReasons(journalPath: string | undefined, since1h: number): {
  evals1h: number;
  passed1h: number;
  failReasons: Map<string, number>;
} {
  const failReasons = new Map<string, number>();
  let evals1h = 0;
  let passed1h = 0;
  if (!journalPath || !fs.existsSync(journalPath)) {
    return { evals1h, passed1h, failReasons };
  }
  for (const line of iterJsonlLinesBounded(journalPath, TAIL_BYTES, FULL_SCAN_MAX)) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tsS = String(o.ts ?? '');
    let ts = 0;
    try {
      ts = Date.parse(tsS);
    } catch {
      ts = 0;
    }
    if (ts >= since1h) {
      if (o.kind === 'execution_blocked' || o.kind === 'sim_failed') evals1h += 1;
      if (o.kind === 'buy' || o.kind === 'sell') passed1h += 1;
    }
    if (o.kind === 'execution_blocked' && typeof o.reason === 'string') {
      const key = o.reason;
      failReasons.set(key, (failReasons.get(key) ?? 0) + 1);
    }
  }
  return { evals1h, passed1h, failReasons };
}

export async function loadDcaliveForDashboard(
  sql: ReturnType<typeof postgres>,
  journalPath?: string,
): Promise<DcaliveDashboardLoad> {
  const now = Date.now();
  const since1h = now - 3_600_000;
  const empty: DcaliveDashboardLoad = {
    open: [],
    closed: [],
    firstTs: now,
    lastTs: now,
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map(),
  };

  let positions: PgPositionRow[] = [];
  try {
    positions = await sql<PgPositionRow[]>`
      SELECT
        id, mint, symbol, source, planned_cycles, cycle_usd, cycle_freq_sec, deposit_usd,
        open_ts, est_gain_pct, state, qty_token, cost_usd, avg_entry_price, init_entry_price,
        realized_usd, max_capital_usd, dd_steps_hit, tp_steps_hit, close_reason,
        entered_at, closed_at, updated_at
      FROM dcalive_positions
      ORDER BY updated_at DESC
      LIMIT 500
    `;
  } catch (e) {
    console.warn('[dashboard] dcalive PG load failed', String(e).slice(0, 200));
    return empty;
  }

  if (positions.length === 0) {
    const jr = scanJournalFailReasons(journalPath, since1h);
    return {
      ...empty,
      evals1h: jr.evals1h,
      passed1h: jr.passed1h,
      failReasons: [...jr.failReasons.entries()].map(([reason, count]) => ({ reason, count })),
    };
  }

  const ids = positions.map((p) => p.id);
  let fills: PgFillRow[] = [];
  try {
    fills = await sql<PgFillRow[]>`
      SELECT position_id, side, reason, price_usd, qty_token, usd, cycle_index,
             realized_usd, tx_signature, dry_run, ts
      FROM dcalive_fills
      WHERE position_id = ANY(${ids})
      ORDER BY ts ASC
    `;
  } catch {
    fills = [];
  }

  const fillsByPos = new Map<number, PgFillRow[]>();
  for (const f of fills) {
    const arr = fillsByPos.get(f.position_id) ?? [];
    arr.push(f);
    fillsByPos.set(f.position_id, arr);
  }

  const open: Paper2OpenItem[] = [];
  const closed: Paper2ClosedRow[] = [];
  const openTimelines = new Map<string, TimelineEvent[]>();
  let firstTs = now;
  let lastTs = 0;

  for (const pos of positions) {
    const posFills = fillsByPos.get(pos.id) ?? [];
    const timeline = buildPositionTimeline(pos, posFills);
    const entryTs = tsMs(pos.entered_at) || tsMs(pos.open_ts) || tsMs(pos.updated_at);
    const exitTs = tsMs(pos.closed_at) || tsMs(pos.updated_at);
    if (entryTs > 0 && entryTs < firstTs) firstTs = entryTs;
    if (exitTs > lastTs) lastTs = exitTs;
    if (entryTs > lastTs) lastTs = entryTs;

    if (['managing', 'closing', 'armed', 'scoring'].includes(pos.state)) {
      open.push(positionToOpenItem(pos, posFills));
      openTimelines.set(pos.mint, timeline);
    } else {
      closed.push(positionToClosedRow(pos, posFills, timeline));
    }
  }

  const jr = scanJournalFailReasons(journalPath, since1h);
  for (const [reason, count] of jr.failReasons.entries()) {
    jr.failReasons.set(reason, count);
  }
  for (const pos of positions) {
    if (pos.state === 'skipped' && pos.close_reason) {
      const key = pos.close_reason;
      jr.failReasons.set(key, (jr.failReasons.get(key) ?? 0) + 1);
    }
  }

  return {
    open,
    closed,
    firstTs,
    lastTs: lastTs || firstTs,
    resetTs: 0,
    evals1h: jr.evals1h,
    passed1h: jr.passed1h,
    failReasons: [...jr.failReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([reason, count]) => ({ reason, count })),
    openTimelines,
  };
}
