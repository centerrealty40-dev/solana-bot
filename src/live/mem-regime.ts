/**
 * Live Oscar — memecoin-segment liquidity regime gate for **new** positions (`buy_open` only).
 *
 * Motivation (jul 6–8 2026 drain): SOL held flat while the whole memecoin runner
 * universe bled −20% peak→trough with breadth 55–71% red. BTC / SOL gates did not
 * fire because the outflow was *inside* the memecoin segment (retail rotated into
 * newly-launched Robinhood memecoins). We cannot see Robinhood directly, but the
 * **consequence** — a broad, synchronized risk-off across our own runner universe —
 * is visible in the same `*_pair_snapshots` tables Oscar already collects.
 *
 * This module builds an equal-weight breadth/momentum index off those snapshots on a
 * background interval (never on the buy hot path) and exposes a **synchronous** gate
 * status read (cached state). Mirrors `btc-gate.ts` in spirit; default OFF, shadow
 * before gate (NORM / platform P5).
 */
import { sql } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveOscarConfig } from './config.js';

const log = child('live-mem-regime');

/** DEX pair-snapshot tables that make up the memecoin universe. */
const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

/** Per-runner row returned by the aggregate query (or fed by tests). */
export type MemRegimeRunnerRow = {
  mint: string;
  priceNow: number;
  priceBase: number;
  v1hMax: number | null;
  liq: number | null;
};

export type MemRegimeParams = {
  minRunnerV1hUsd: number;
  minRunners: number;
  breadthRedPct: number;
  ewDropPct: number;
  medDropPct: number;
  requiredSignals: number;
};

export type MemRegimeMetrics = {
  ts: number;
  runnerCount: number;
  breadthRedPct: number | null;
  ewReturnPct: number | null;
  medReturnPct: number | null;
  liqUsd: number | null;
  vol1hUsd: number | null;
};

export type MemRegimeClassification = {
  valid: boolean;
  riskOff: boolean;
  signals: string[];
};

export type MemRegimeGateStatus =
  | { kind: 'disabled' }
  | { kind: 'unknown'; ageMs: number | null }
  | ({ kind: 'risk-on' } & MemRegimeMetrics)
  | ({
      kind: 'risk-off';
      mode: 'shadow' | 'gate';
      signals: string[];
      wouldBlock: boolean;
      blocked: boolean;
    } & MemRegimeMetrics);

// ---------------------------------------------------------------------------
// Pure logic (unit-tested; no DB / no clock beyond the injected `now`)
// ---------------------------------------------------------------------------

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Equal-weight breadth/momentum metrics over the runner universe. */
export function computeRegimeMetrics(
  rows: MemRegimeRunnerRow[],
  params: MemRegimeParams,
  now: number = Date.now(),
): MemRegimeMetrics {
  const runners = rows.filter(
    (r) =>
      Number.isFinite(r.priceNow) &&
      Number.isFinite(r.priceBase) &&
      r.priceNow > 0 &&
      r.priceBase > 0 &&
      (r.v1hMax ?? 0) >= params.minRunnerV1hUsd,
  );
  const rets: number[] = [];
  let liqUsd = 0;
  let vol1hUsd = 0;
  for (const r of runners) {
    const ret = r.priceNow / r.priceBase - 1;
    // Clamp obvious data glitches / new-listing spikes (±500%).
    if (Number.isFinite(ret) && Math.abs(ret) < 5) rets.push(ret);
    if (r.liq != null && Number.isFinite(r.liq)) liqUsd += r.liq;
    if (r.v1hMax != null && Number.isFinite(r.v1hMax)) vol1hUsd += r.v1hMax;
  }
  const runnerCount = rets.length;
  const breadthRedPct = runnerCount
    ? (100 * rets.filter((r) => r < 0).length) / runnerCount
    : null;
  return {
    ts: now,
    runnerCount,
    breadthRedPct,
    ewReturnPct: runnerCount ? 100 * mean(rets) : null,
    medReturnPct: runnerCount ? 100 * median(rets) : null,
    liqUsd: runners.length ? liqUsd : null,
    vol1hUsd: runners.length ? vol1hUsd : null,
  };
}

/**
 * Classify a regime from metrics. Risk-off when at least `requiredSignals` of:
 *  - breadth: share of red runners ≥ `breadthRedPct`
 *  - ew_drop: equal-weight mean return ≤ −`ewDropPct`
 *  - med_drop: median return ≤ −`medDropPct`
 * `valid=false` when the runner universe is too thin to trust (insufficient data).
 */
export function classifyRegime(
  m: MemRegimeMetrics,
  params: MemRegimeParams,
): MemRegimeClassification {
  if (m.runnerCount < params.minRunners) {
    return { valid: false, riskOff: false, signals: [] };
  }
  const signals: string[] = [];
  if (m.breadthRedPct != null && m.breadthRedPct >= params.breadthRedPct) {
    signals.push('breadth');
  }
  if (m.ewReturnPct != null && m.ewReturnPct <= -params.ewDropPct) {
    signals.push('ew_drop');
  }
  if (m.medReturnPct != null && m.medReturnPct <= -params.medDropPct) {
    signals.push('med_drop');
  }
  const required = Math.max(1, Math.min(3, params.requiredSignals));
  return { valid: true, riskOff: signals.length >= required, signals };
}

/** Hysteresis state machine — flips confirmed regime only after N consecutive windows. */
export type MemRegimeHysteresis = {
  confirmed: 'risk-on' | 'risk-off';
  offStreak: number;
  onStreak: number;
};

export function initHysteresis(): MemRegimeHysteresis {
  return { confirmed: 'risk-on', offStreak: 0, onStreak: 0 };
}

export function applyHysteresis(
  state: MemRegimeHysteresis,
  cls: MemRegimeClassification,
  confirmWindows: number,
): MemRegimeHysteresis {
  const confirm = Math.max(1, confirmWindows);
  // Insufficient data: keep the last confirmed state, reset streaks (no flip on noise).
  if (!cls.valid) {
    return { ...state, offStreak: 0, onStreak: 0 };
  }
  if (cls.riskOff) {
    const offStreak = state.offStreak + 1;
    return {
      confirmed: offStreak >= confirm ? 'risk-off' : state.confirmed,
      offStreak,
      onStreak: 0,
    };
  }
  const onStreak = state.onStreak + 1;
  return {
    confirmed: onStreak >= confirm ? 'risk-on' : state.confirmed,
    offStreak: 0,
    onStreak,
  };
}

// ---------------------------------------------------------------------------
// Config → params
// ---------------------------------------------------------------------------

export function memRegimeParams(cfg: LiveOscarConfig): MemRegimeParams {
  return {
    minRunnerV1hUsd: cfg.liveMemRegimeMinRunnerV1hUsd,
    minRunners: cfg.liveMemRegimeMinRunners,
    breadthRedPct: cfg.liveMemRegimeBreadthRedPct,
    ewDropPct: cfg.liveMemRegimeEwDropPct,
    medDropPct: cfg.liveMemRegimeMedDropPct,
    requiredSignals: cfg.liveMemRegimeRequiredSignals,
  };
}

// ---------------------------------------------------------------------------
// In-memory state (read synchronously by the gate)
// ---------------------------------------------------------------------------

type MemRegimeState = {
  hys: MemRegimeHysteresis;
  lastMetrics: MemRegimeMetrics | null;
  lastComputeTs: number;
  lastSignals: string[];
  lastJournalTs: number;
  refresherStarted: boolean;
  refreshing: boolean;
  lastErrorLogTs: number;
};

const state: MemRegimeState = {
  hys: initHysteresis(),
  lastMetrics: null,
  lastComputeTs: 0,
  lastSignals: [],
  lastJournalTs: 0,
  refresherStarted: false,
  refreshing: false,
  lastErrorLogTs: 0,
};

/** Testing helper — reset module state between cases. */
export function resetMemRegimeStateForTest(): void {
  state.hys = initHysteresis();
  state.lastMetrics = null;
  state.lastComputeTs = 0;
  state.lastSignals = [];
  state.lastJournalTs = 0;
  state.refresherStarted = false;
  state.refreshing = false;
  state.lastErrorLogTs = 0;
}

/** Current confirmed regime + last metrics (for heartbeat / diagnostics). */
export function memRegimeSnapshot(): {
  confirmed: 'risk-on' | 'risk-off';
  ageMs: number | null;
  metrics: MemRegimeMetrics | null;
  signals: string[];
} {
  return {
    confirmed: state.hys.confirmed,
    ageMs: state.lastComputeTs ? Date.now() - state.lastComputeTs : null,
    metrics: state.lastMetrics,
    signals: state.lastSignals,
  };
}

// ---------------------------------------------------------------------------
// DB query (off the hot path — only from the background refresher)
// ---------------------------------------------------------------------------

let cachedColsByTable: Record<string, string[]> | null = null;

function pick(cols: string[], cands: string[]): string | null {
  for (const c of cands) if (cols.includes(c)) return c;
  return null;
}

async function introspectColumns(): Promise<Record<string, string[]>> {
  if (cachedColsByTable) return cachedColsByTable;
  const out: Record<string, string[]> = {};
  for (const t of SNAPSHOT_TABLES) {
    const rows = (await sql`
      select column_name from information_schema.columns where table_name = ${t}
    `) as unknown as Array<{ column_name: string }>;
    out[t] = rows.map((r) => r.column_name);
  }
  cachedColsByTable = out;
  return out;
}

function buildAggregateQuery(colsByTable: Record<string, string[]>, windowMin: number, lookbackMin: number): string | null {
  const w = Math.max(15, Math.min(360, Math.floor(windowMin)));
  const lb = Math.max(5, Math.min(300, Math.floor(lookbackMin)));
  const parts: string[] = [];
  for (const t of SNAPSHOT_TABLES) {
    const cols = colsByTable[t];
    if (!cols || cols.length === 0) continue;
    const tcol = pick(cols, ['ts', 'bucket_ts', 'created_at']);
    const price = pick(cols, ['price_usd']);
    const mint = pick(cols, ['base_mint', 'mint']);
    if (!tcol || !price || !mint) continue;
    const liq = pick(cols, ['liquidity_usd', 'liq_usd']);
    const v1h = pick(cols, ['volume_1h', 'vol_1h']);
    parts.push(
      `select ${tcol} as ts, ${mint} as mint, ${price} as price, ` +
        `${liq || 'null'} as liq, ${v1h || 'null'} as v1h ` +
        `from ${t} where ${tcol} >= now() - interval '${w} minutes' and ${price} > 0`,
    );
  }
  if (parts.length === 0) return null;
  return `
    with s as (
      ${parts.join('\nunion all\n')}
    ),
    agg as (
      select mint,
        (array_agg(price order by ts desc))[1] as price_now,
        (array_agg(price order by ts desc) filter (where ts <= now() - interval '${lb} minutes'))[1] as price_base,
        max(v1h) as v1h_max,
        (array_agg(liq order by ts desc) filter (where liq is not null))[1] as liq
      from s
      group by mint
    )
    select mint, price_now, price_base, v1h_max, liq
    from agg
    where price_now > 0 and price_base > 0`;
}

async function fetchRunnerRows(cfg: LiveOscarConfig): Promise<MemRegimeRunnerRow[]> {
  const lookbackMin = cfg.liveMemRegimeLookbackMin;
  const windowMin = lookbackMin + cfg.liveMemRegimeBaselineTolMin;
  const colsByTable = await introspectColumns();
  const query = buildAggregateQuery(colsByTable, windowMin, lookbackMin);
  if (!query) return [];
  const rows = (await sql.unsafe(query)) as unknown as Array<{
    mint: string;
    price_now: string | number | null;
    price_base: string | number | null;
    v1h_max: string | number | null;
    liq: string | number | null;
  }>;
  return rows.map((r) => ({
    mint: String(r.mint),
    priceNow: Number(r.price_now) || 0,
    priceBase: Number(r.price_base) || 0,
    v1hMax: r.v1h_max == null ? null : Number(r.v1h_max),
    liq: r.liq == null ? null : Number(r.liq),
  }));
}

// ---------------------------------------------------------------------------
// Refresh loop + journaling
// ---------------------------------------------------------------------------

function num(n: number | null): number | null {
  return n == null ? null : Number(n.toFixed(3));
}

function journalTick(reason: string, metrics: MemRegimeMetrics, extra: Record<string, unknown>): void {
  try {
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason,
      detail: {
        confirmed: state.hys.confirmed,
        signals: state.lastSignals,
        runnerCount: metrics.runnerCount,
        breadthRedPct: num(metrics.breadthRedPct),
        ewReturnPct: num(metrics.ewReturnPct),
        medReturnPct: num(metrics.medReturnPct),
        liqUsd: metrics.liqUsd == null ? null : Math.round(metrics.liqUsd),
        vol1hUsd: metrics.vol1hUsd == null ? null : Math.round(metrics.vol1hUsd),
        ...extra,
      },
    });
  } catch {
    /* journal write is best-effort */
  }
}

/** One refresh cycle: query snapshots, recompute metrics, apply hysteresis, journal. */
export async function refreshMemRegimeStateOnce(cfg: LiveOscarConfig): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const rows = await fetchRunnerRows(cfg);
    const params = memRegimeParams(cfg);
    const metrics = computeRegimeMetrics(rows, params);
    const cls = classifyRegime(metrics, params);
    const prevConfirmed = state.hys.confirmed;
    state.hys = applyHysteresis(state.hys, cls, cfg.liveMemRegimeConfirmWindows);
    state.lastMetrics = metrics;
    state.lastComputeTs = metrics.ts;
    state.lastSignals = cls.signals;

    const transitioned = state.hys.confirmed !== prevConfirmed;
    const everySec = Math.max(60, cfg.liveMemRegimeJournalEverySec);
    const dueTick = metrics.ts - state.lastJournalTs >= everySec * 1000;
    if (transitioned) {
      journalTick('mem_regime_transition', metrics, {
        from: prevConfirmed,
        to: state.hys.confirmed,
        mode: cfg.liveMemRegimeMode,
      });
      state.lastJournalTs = metrics.ts;
    } else if (dueTick) {
      journalTick('mem_regime_tick', metrics, { mode: cfg.liveMemRegimeMode });
      state.lastJournalTs = metrics.ts;
    }
  } catch (err) {
    const now = Date.now();
    if (now - state.lastErrorLogTs > 5 * 60_000) {
      state.lastErrorLogTs = now;
      log.warn({ err: String((err as Error)?.message ?? err) }, 'mem-regime refresh failed');
    }
    // Fail-open: do not flip regime on transient DB errors.
  } finally {
    state.refreshing = false;
  }
}

/** Idempotently start the background refresher (called lazily from the gate). */
export function ensureMemRegimeRefresher(cfg: LiveOscarConfig): void {
  if (state.refresherStarted) return;
  if (!cfg.liveMemRegimeEnabled || cfg.liveMemRegimeMode === 'off') return;
  state.refresherStarted = true;
  void refreshMemRegimeStateOnce(cfg);
  const everyMs = Math.max(20_000, cfg.liveMemRegimeRefreshSec * 1000);
  const timer = setInterval(() => {
    void refreshMemRegimeStateOnce(cfg);
  }, everyMs);
  // Do not keep the event loop alive purely for the regime refresher.
  if (typeof timer.unref === 'function') timer.unref();
}

// ---------------------------------------------------------------------------
// Synchronous gate (read cached state; safe on the buy hot path)
// ---------------------------------------------------------------------------

export function resolveMemRegimeGateStatus(cfg: LiveOscarConfig): MemRegimeGateStatus {
  const mode = cfg.liveMemRegimeMode;
  if (!cfg.liveMemRegimeEnabled || mode === 'off') return { kind: 'disabled' };

  ensureMemRegimeRefresher(cfg);

  const ageMs = state.lastComputeTs ? Date.now() - state.lastComputeTs : null;
  const maxStaleMs = cfg.liveMemRegimeMaxStaleSec * 1000;
  if (ageMs == null || ageMs > maxStaleMs || state.lastMetrics == null) {
    return { kind: 'unknown', ageMs };
  }

  if (state.hys.confirmed === 'risk-off') {
    return {
      kind: 'risk-off',
      mode,
      signals: state.lastSignals,
      wouldBlock: true,
      blocked: mode === 'gate',
      ...state.lastMetrics,
    };
  }
  return { kind: 'risk-on', ...state.lastMetrics };
}
