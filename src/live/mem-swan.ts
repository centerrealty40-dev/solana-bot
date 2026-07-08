/**
 * Live Oscar — memecoin **black-swan** liquidation detector.
 *
 * Distinct from `mem-regime.ts` (which gates *new entries* on a broad, frequent risk-off).
 * This detector fires **rarely** (~1–2×/month) on the specific, catastrophic event the
 * jul 6–7 2026 drain was: the **top volume runners dumping simultaneously and deeply**.
 *
 * Backtest (609 real Oscar positions, may–jul 2026, prices anchored to `*_pair_snapshots`):
 *   - Universe: top-N memecoins by peak 1h volume (the active runners Oscar trades — NOT
 *     deep-liquidity blue chips, which never showed the jul 7 drain).
 *   - Signal: equal-weight return of that universe over a `rollMin` (6h) window.
 *   - Trigger: ew ≤ −`ewDropPct` (≈ −16%). Fires **immediately** on depth (no breadth gate,
 *     no confirmation delay — confirmation/persistence sells at the bottom after the bounce).
 *   - Result: liquidating open positions at the trigger nets **+$5.8k (−16%, 24h) … +$14k
 *     (−18%, 48h)** over the 2 months, catching jul 7 early (+$6–7k). Broad/frequent or
 *     delayed variants were net-negative (Oscar is a dip-buyer; most dips bounce).
 *
 * Anti-phantom (never liquidate on blind/stale data):
 *   - require ≥ `minRunners` valid runners contributing to the index;
 *   - require cached metrics fresher than `maxStaleSec`.
 *
 * The index is computed on a background interval (never on any hot path) and read
 * synchronously from cached state. Default OFF; `shadow` journals only; `liquidate` sells.
 */
import { sql } from '../core/db/client.js';
import { child } from '../core/logger.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveOscarConfig } from './config.js';

const log = child('live-mem-swan');

const SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

export type MemSwanRunnerRow = {
  mint: string;
  priceNow: number;
  priceBase: number;
  v1hMax: number | null;
};

export type MemSwanParams = {
  topN: number;
  minRunnerV1hUsd: number;
  minRunners: number;
  ewDropPct: number;
};

export type MemSwanMetrics = {
  ts: number;
  runnerCount: number;
  ewReturnPct: number | null;
  medReturnPct: number | null;
  breadthRedPct: number | null;
};

export type MemSwanClassification = {
  valid: boolean;
  triggered: boolean;
};

export type MemSwanStatus =
  | { kind: 'disabled' }
  | { kind: 'unknown'; ageMs: number | null }
  | ({ kind: 'calm' } & MemSwanMetrics)
  | ({ kind: 'swan'; mode: 'shadow' | 'liquidate'; active: boolean } & MemSwanMetrics);

// ---------------------------------------------------------------------------
// Pure logic (unit-tested; no DB / no clock beyond injected `now`)
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

/**
 * Equal-weight return of the **top-N runners by peak 1h volume** over the roll window.
 * Rows carry `priceNow` and `priceBase` (price ~rollMin ago). Selects the top-N eligible
 * runners, then equal-weights their `priceNow/priceBase − 1`.
 */
export function computeSwanMetric(
  rows: MemSwanRunnerRow[],
  params: MemSwanParams,
  now: number = Date.now(),
): MemSwanMetrics {
  const eligible = rows.filter(
    (r) =>
      Number.isFinite(r.priceNow) &&
      Number.isFinite(r.priceBase) &&
      r.priceNow > 0 &&
      r.priceBase > 0 &&
      (r.v1hMax ?? 0) >= params.minRunnerV1hUsd,
  );
  eligible.sort((a, b) => (b.v1hMax ?? 0) - (a.v1hMax ?? 0));
  const top = eligible.slice(0, Math.max(1, params.topN));
  const rets: number[] = [];
  for (const r of top) {
    const ret = r.priceNow / r.priceBase - 1;
    // Clamp obvious data glitches / new-listing spikes.
    if (Number.isFinite(ret) && ret > -0.999 && ret < 20) rets.push(ret);
  }
  const runnerCount = rets.length;
  return {
    ts: now,
    runnerCount,
    ewReturnPct: runnerCount ? 100 * mean(rets) : null,
    medReturnPct: runnerCount ? 100 * median(rets) : null,
    breadthRedPct: runnerCount ? (100 * rets.filter((r) => r < 0).length) / runnerCount : null,
  };
}

/**
 * Swan when the equal-weight return is a deep drop (≤ −`ewDropPct`). `valid=false` when
 * too few runners contributed (blind data) — never triggers a liquidation.
 */
export function classifySwan(m: MemSwanMetrics, params: MemSwanParams): MemSwanClassification {
  if (m.runnerCount < params.minRunners) return { valid: false, triggered: false };
  const triggered = m.ewReturnPct != null && m.ewReturnPct <= -params.ewDropPct;
  return { valid: true, triggered };
}

export function memSwanParams(cfg: LiveOscarConfig): MemSwanParams {
  return {
    topN: cfg.liveMemSwanTopN,
    minRunnerV1hUsd: cfg.liveMemSwanMinRunnerV1hUsd,
    minRunners: cfg.liveMemSwanMinRunners,
    ewDropPct: cfg.liveMemSwanEwDropPct,
  };
}

// ---------------------------------------------------------------------------
// In-memory state (read synchronously)
// ---------------------------------------------------------------------------

type MemSwanState = {
  active: boolean;
  calmMin: number;
  lastMetrics: MemSwanMetrics | null;
  lastComputeTs: number;
  lastValid: boolean;
  lastJournalTs: number;
  refresherStarted: boolean;
  refreshing: boolean;
  lastErrorLogTs: number;
  /** Consumed by the liquidation hook: set on the rising edge, cleared after handling. */
  pendingRiseTs: number | null;
};

const state: MemSwanState = {
  active: false,
  calmMin: 0,
  lastMetrics: null,
  lastComputeTs: 0,
  lastValid: false,
  lastJournalTs: 0,
  refresherStarted: false,
  refreshing: false,
  lastErrorLogTs: 0,
  pendingRiseTs: null,
};

export function resetMemSwanStateForTest(): void {
  state.active = false;
  state.calmMin = 0;
  state.lastMetrics = null;
  state.lastComputeTs = 0;
  state.lastValid = false;
  state.lastJournalTs = 0;
  state.refresherStarted = false;
  state.refreshing = false;
  state.lastErrorLogTs = 0;
  state.pendingRiseTs = null;
}

export function memSwanSnapshot(): {
  active: boolean;
  ageMs: number | null;
  metrics: MemSwanMetrics | null;
} {
  return {
    active: state.active,
    ageMs: state.lastComputeTs ? Date.now() - state.lastComputeTs : null,
    metrics: state.lastMetrics,
  };
}

/**
 * If a swan just started (rising edge) and data is fresh, return the rise timestamp
 * exactly once (so the liquidation hook acts once per episode), else null.
 */
export function consumeMemSwanRisingEdge(cfg: LiveOscarConfig): number | null {
  if (state.pendingRiseTs == null) return null;
  const ageMs = state.lastComputeTs ? Date.now() - state.lastComputeTs : null;
  if (ageMs == null || ageMs > cfg.liveMemSwanMaxStaleSec * 1000) return null;
  const ts = state.pendingRiseTs;
  state.pendingRiseTs = null;
  return ts;
}

// ---------------------------------------------------------------------------
// DB query (background refresher only)
// ---------------------------------------------------------------------------

let cachedCols: Record<string, string[]> | null = null;

function pick(cols: string[], cands: string[]): string | null {
  for (const c of cands) if (cols.includes(c)) return c;
  return null;
}

async function introspectColumns(): Promise<Record<string, string[]>> {
  if (cachedCols) return cachedCols;
  const out: Record<string, string[]> = {};
  for (const t of SNAPSHOT_TABLES) {
    const rows = (await sql`
      select column_name from information_schema.columns where table_name = ${t}
    `) as unknown as Array<{ column_name: string }>;
    out[t] = rows.map((r) => r.column_name);
  }
  cachedCols = out;
  return out;
}

function buildQuery(colsByTable: Record<string, string[]>, windowMin: number, rollMin: number): string | null {
  const w = Math.max(60, Math.min(1440, Math.floor(windowMin)));
  const lb = Math.max(30, Math.min(1440, Math.floor(rollMin)));
  const parts: string[] = [];
  for (const t of SNAPSHOT_TABLES) {
    const cols = colsByTable[t];
    if (!cols || cols.length === 0) continue;
    const tcol = pick(cols, ['ts', 'bucket_ts', 'created_at']);
    const price = pick(cols, ['price_usd']);
    const mint = pick(cols, ['base_mint', 'mint']);
    if (!tcol || !price || !mint) continue;
    const v1h = pick(cols, ['volume_1h', 'vol_1h']);
    parts.push(
      `select ${tcol} as ts, ${mint} as mint, ${price} as price, ${v1h || 'null'} as v1h ` +
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
        max(v1h) as v1h_max
      from s
      group by mint
    )
    select mint, price_now, price_base, v1h_max
    from agg
    where price_now > 0 and price_base > 0`;
}

async function fetchRunnerRows(cfg: LiveOscarConfig): Promise<MemSwanRunnerRow[]> {
  const rollMin = cfg.liveMemSwanRollMin;
  const windowMin = rollMin + cfg.liveMemSwanBaselineTolMin;
  const colsByTable = await introspectColumns();
  const query = buildQuery(colsByTable, windowMin, rollMin);
  if (!query) return [];
  const rows = (await sql.unsafe(query)) as unknown as Array<{
    mint: string;
    price_now: string | number | null;
    price_base: string | number | null;
    v1h_max: string | number | null;
  }>;
  return rows.map((r) => ({
    mint: String(r.mint),
    priceNow: Number(r.price_now) || 0,
    priceBase: Number(r.price_base) || 0,
    v1hMax: r.v1h_max == null ? null : Number(r.v1h_max),
  }));
}

// ---------------------------------------------------------------------------
// Refresh loop + journaling
// ---------------------------------------------------------------------------

function num(n: number | null): number | null {
  return n == null ? null : Number(n.toFixed(3));
}

function journal(reason: string, m: MemSwanMetrics, extra: Record<string, unknown>): void {
  try {
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason,
      detail: {
        active: state.active,
        runnerCount: m.runnerCount,
        ewReturnPct: num(m.ewReturnPct),
        medReturnPct: num(m.medReturnPct),
        breadthRedPct: num(m.breadthRedPct),
        ...extra,
      },
    });
  } catch {
    /* best-effort */
  }
}

export async function refreshMemSwanStateOnce(cfg: LiveOscarConfig): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const rows = await fetchRunnerRows(cfg);
    const params = memSwanParams(cfg);
    const metrics = computeSwanMetric(rows, params);
    const cls = classifySwan(metrics, params);
    const wasActive = state.active;

    if (cls.valid && cls.triggered) {
      state.calmMin = 0;
      if (!state.active) {
        state.active = true;
        state.pendingRiseTs = metrics.ts; // rising edge — hook acts once
      }
    } else if (cls.valid) {
      // Only valid (non-blind) calm windows count toward resume.
      state.calmMin += Math.max(20, cfg.liveMemSwanRefreshSec) / 60;
      if (state.active && state.calmMin >= cfg.liveMemSwanResumeMin) {
        state.active = false;
      }
    }
    // Blind (invalid) windows: hold current state, do not resume, never trigger.

    state.lastMetrics = metrics;
    state.lastComputeTs = metrics.ts;
    state.lastValid = cls.valid;

    const transitioned = state.active !== wasActive;
    const everySec = Math.max(60, cfg.liveMemSwanJournalEverySec);
    const dueTick = metrics.ts - state.lastJournalTs >= everySec * 1000;
    if (transitioned) {
      journal('mem_swan_transition', metrics, { to: state.active ? 'swan' : 'calm', mode: cfg.liveMemSwanMode });
      state.lastJournalTs = metrics.ts;
    } else if (dueTick) {
      journal('mem_swan_tick', metrics, { mode: cfg.liveMemSwanMode, valid: cls.valid });
      state.lastJournalTs = metrics.ts;
    }
  } catch (err) {
    const now = Date.now();
    if (now - state.lastErrorLogTs > 5 * 60_000) {
      state.lastErrorLogTs = now;
      log.warn({ err: String((err as Error)?.message ?? err) }, 'mem-swan refresh failed');
    }
    // Fail-safe: on DB error, do not flip state (never liquidate on blind data).
  } finally {
    state.refreshing = false;
  }
}

export function ensureMemSwanRefresher(cfg: LiveOscarConfig): void {
  if (state.refresherStarted) return;
  if (!cfg.liveMemSwanEnabled || cfg.liveMemSwanMode === 'off') return;
  state.refresherStarted = true;
  void refreshMemSwanStateOnce(cfg);
  const everyMs = Math.max(20_000, cfg.liveMemSwanRefreshSec * 1000);
  const timer = setInterval(() => {
    void refreshMemSwanStateOnce(cfg);
  }, everyMs);
  if (typeof timer.unref === 'function') timer.unref();
}

// ---------------------------------------------------------------------------
// Synchronous status (read cached state)
// ---------------------------------------------------------------------------

export function resolveMemSwanStatus(cfg: LiveOscarConfig): MemSwanStatus {
  const mode = cfg.liveMemSwanMode;
  if (!cfg.liveMemSwanEnabled || mode === 'off') return { kind: 'disabled' };
  ensureMemSwanRefresher(cfg);

  const ageMs = state.lastComputeTs ? Date.now() - state.lastComputeTs : null;
  const maxStaleMs = cfg.liveMemSwanMaxStaleSec * 1000;
  if (ageMs == null || ageMs > maxStaleMs || state.lastMetrics == null) {
    return { kind: 'unknown', ageMs };
  }
  if (state.active) {
    return { kind: 'swan', mode, active: true, ...state.lastMetrics };
  }
  return { kind: 'calm', ...state.lastMetrics };
}
