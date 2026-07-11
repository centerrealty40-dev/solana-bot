/**
 * Live Oscar — **own-book** black-swan / portfolio-bleed liquidation.
 *
 * Independent failure domain from `mem-swan.ts` (external top-N runner index over PG snapshots).
 * This one keys off OUR OWN open positions' live marks (`curMetric`, sourced snapshot → Jupiter →
 * Shyft), so it still fires when the external index goes blind (PG collector outage): the tracker
 * must mark our positions to manage them, and Jupiter is a separate source from the PG snapshot
 * universe.
 *
 * Signal: equal-weight return of our open positions over a rolling window (`rollMin`, ~2h),
 * anchored to an in-memory per-mint mark history. Trigger: EW ≤ −`ewDropPct` (~−25%) with
 * ≥ `minPositions` contributing (anti-phantom). Fires on the rising edge (once per episode) →
 * force-close ALL open positions.
 *
 * Backtest (608 real Oscar positions, may–jul 2026, prices from `*_pair_snapshots`, hold 24h):
 *   6h window / EW ≤ −25% / ≥8 positions → ~12 episodes over 2mo (≈6/mo), liquidate-vs-hold
 *   **+$13.5k** (89/43 favorable). It does NOT catch market swans where we're lightly exposed
 *   (those the external index handles) — it fires precisely when OUR capital is bleeding hard.
 *
 * Warmup: history is in-memory, so after a restart there is no baseline for ~`rollMin`; during
 * that window the external `mem-swan` index (PG-backfilled) provides coverage. Default OFF;
 * `shadow` journals only; `liquidate` sells.
 */
import { memSwanDropTriggered } from './mem-swan.js';
import { child } from '../core/logger.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { LiveOscarConfig } from './config.js';
import type { OpenTrade } from '../papertrader/types.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import { mintFromOpenMapKey } from '../papertrader/live-oscar-runner-probe.js';

const log = child('live-mem-swan-port');

export type PortfolioParams = {
  rollMin: number;
  baselineTolMin: number;
  ewDropPct: number;
  minPositions: number;
  breadthRedMinPct: number;
  breadthEwDropPct: number;
};

export type PortfolioMetrics = {
  ts: number;
  positionCount: number;
  ewReturnPct: number | null;
  medReturnPct: number | null;
  breadthRedPct: number | null;
};

export type PortfolioClassification = { valid: boolean; triggered: boolean };

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)
// ---------------------------------------------------------------------------

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}
function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Equal-weight return over positions with a valid now+base price. */
export function computePortfolioMetric(
  pairs: Array<{ pnow: number; pbase: number }>,
  now: number = Date.now(),
): PortfolioMetrics {
  const rets: number[] = [];
  for (const p of pairs) {
    if (!(p.pnow > 0) || !(p.pbase > 0)) continue;
    const r = p.pnow / p.pbase - 1;
    if (Number.isFinite(r) && r > -0.999 && r < 20) rets.push(r);
  }
  const c = rets.length;
  return {
    ts: now,
    positionCount: c,
    ewReturnPct: c ? 100 * mean(rets) : null,
    medReturnPct: c ? 100 * median(rets) : null,
    breadthRedPct: c ? (100 * rets.filter((r) => r < 0).length) / c : null,
  };
}

export function classifyPortfolioSwan(m: PortfolioMetrics, params: PortfolioParams): PortfolioClassification {
  if (m.positionCount < params.minPositions) return { valid: false, triggered: false };
  return { valid: true, triggered: memSwanDropTriggered(m, params) };
}

export function memSwanPortParams(cfg: LiveOscarConfig): PortfolioParams {
  return {
    rollMin: cfg.liveMemSwanPortRollMin,
    baselineTolMin: cfg.liveMemSwanPortBaselineTolMin,
    ewDropPct: cfg.liveMemSwanPortEwDropPct,
    minPositions: cfg.liveMemSwanPortMinPositions,
    breadthRedMinPct: cfg.liveMemSwanPortBreadthRedMinPct,
    breadthEwDropPct: cfg.liveMemSwanPortBreadthEwDropPct,
  };
}

// ---------------------------------------------------------------------------
// In-memory per-mint mark history + state
// ---------------------------------------------------------------------------

type Sample = [tsSec: number, px: number];

type PortState = {
  rings: Map<string, Sample[]>;
  pending: Map<string, number>; // marks recorded during the current tick's loop
  lastMarks: Map<string, number>; // finalized marks from the last processed tick (for sell price)
  active: boolean;
  calmSinceTs: number; // wall-clock ms when the current valid-calm streak began (0 = none)
  lastMetrics: PortfolioMetrics | null;
  lastComputeTs: number;
  lastValid: boolean;
  lastJournalTs: number;
  pendingRiseTs: number | null;
};

const state: PortState = {
  rings: new Map(),
  pending: new Map(),
  lastMarks: new Map(),
  active: false,
  calmSinceTs: 0,
  lastMetrics: null,
  lastComputeTs: 0,
  lastValid: false,
  lastJournalTs: 0,
  pendingRiseTs: null,
};

export function resetMemSwanPortStateForTest(): void {
  state.rings = new Map();
  state.pending = new Map();
  state.lastMarks = new Map();
  state.active = false;
  state.calmSinceTs = 0;
  state.lastMetrics = null;
  state.lastComputeTs = 0;
  state.lastValid = false;
  state.lastJournalTs = 0;
  state.pendingRiseTs = null;
}

/** Record one fresh per-position mark during the tracker's per-mint loop. Cheap. */
export function recordMemSwanPortfolioMark(mint: string, px: number): void {
  if (px > 0 && Number.isFinite(px)) state.pending.set(mint, px);
}

/** Newest ring sample with ts ≤ target and within tol seconds before target. */
function ringBaseAt(ring: Sample[], targetSec: number, tolSec: number): number | null {
  let lo = 0;
  let hi = ring.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ring[mid]![0] <= targetSec) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans < 0) return null;
  if (targetSec - ring[ans]![0] > tolSec) return null;
  return ring[ans]![1];
}

export function memSwanPortSnapshot(): {
  active: boolean;
  ageMs: number | null;
  metrics: PortfolioMetrics | null;
} {
  return {
    active: state.active,
    ageMs: state.lastComputeTs ? Date.now() - state.lastComputeTs : null,
    metrics: state.lastMetrics,
  };
}

export function consumeMemSwanPortRisingEdge(cfg: LiveOscarConfig): number | null {
  if (state.pendingRiseTs == null) return null;
  const ageMs = state.lastComputeTs ? Date.now() - state.lastComputeTs : null;
  if (ageMs == null || ageMs > cfg.liveMemSwanPortMaxStaleSec * 1000) return null;
  const ts = state.pendingRiseTs;
  state.pendingRiseTs = null;
  return ts;
}

function num(n: number | null): number | null {
  return n == null ? null : Number(n.toFixed(3));
}

function journal(reason: string, m: PortfolioMetrics, extra: Record<string, unknown>): void {
  try {
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason,
      detail: {
        active: state.active,
        positionCount: m.positionCount,
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

/**
 * Finalize the marks recorded during the last tick into per-mint rings, compute the own-book
 * EW return over the roll window, classify, and update state (rising edge on calm→swan). Called
 * once per tracker tick (uses the previous tick's collected marks).
 */
export function ingestMemSwanPortfolioTick(cfg: LiveOscarConfig): void {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const params = memSwanPortParams(cfg);
  const rollSec = params.rollMin * 60;
  const tolSec = params.baselineTolMin * 60;
  const keepSec = rollSec + tolSec + 120;

  // Finalize pending marks into rings.
  const finalized = state.pending;
  state.pending = new Map();
  if (finalized.size > 0) {
    state.lastMarks = new Map(finalized);
    for (const [mint, px] of finalized) {
      let ring = state.rings.get(mint);
      if (!ring) {
        ring = [];
        state.rings.set(mint, ring);
      }
      ring.push([nowSec, px]);
      // Prune old samples.
      const cutoff = nowSec - keepSec;
      let drop = 0;
      while (drop < ring.length && ring[drop]![0] < cutoff) drop++;
      if (drop > 0) ring.splice(0, drop);
    }
    // Drop rings for mints no longer open (not marked this tick).
    for (const mint of [...state.rings.keys()]) {
      if (!finalized.has(mint)) state.rings.delete(mint);
    }
  }

  // Build now/base pairs from rings.
  const targetBase = nowSec - rollSec;
  const pairs: Array<{ pnow: number; pbase: number }> = [];
  for (const [mint, px] of state.lastMarks) {
    const ring = state.rings.get(mint);
    if (!ring || ring.length === 0) continue;
    const pbase = ringBaseAt(ring, targetBase, tolSec);
    if (pbase == null) continue;
    pairs.push({ pnow: px, pbase });
  }

  const metrics = computePortfolioMetric(pairs, now);
  const cls = classifyPortfolioSwan(metrics, params);
  const wasActive = state.active;

  if (cls.valid && cls.triggered) {
    state.calmSinceTs = 0;
    if (!state.active) {
      state.active = true;
      state.pendingRiseTs = now;
    }
  } else if (cls.valid) {
    if (state.calmSinceTs === 0) state.calmSinceTs = now;
    if (state.active && now - state.calmSinceTs >= cfg.liveMemSwanPortResumeMin * 60_000) {
      state.active = false;
      state.calmSinceTs = 0;
    }
  }
  // Invalid (too few contributing positions / warmup): hold state, never trigger, never resume.

  state.lastMetrics = metrics;
  state.lastComputeTs = now;
  state.lastValid = cls.valid;

  const transitioned = state.active !== wasActive;
  const everySec = Math.max(60, cfg.liveMemSwanPortJournalEverySec);
  const dueTick = now - state.lastJournalTs >= everySec * 1000;
  if (transitioned) {
    journal('mem_swan_port_transition', metrics, { to: state.active ? 'swan' : 'calm', mode: cfg.liveMemSwanPortMode });
    state.lastJournalTs = now;
  } else if (dueTick) {
    journal('mem_swan_port_tick', metrics, { mode: cfg.liveMemSwanPortMode, valid: cls.valid });
    state.lastJournalTs = now;
  }
}

// ---------------------------------------------------------------------------
// Liquidation sweep (tick top, uses previous tick's marks)
// ---------------------------------------------------------------------------

export interface MemSwanPortSweepArgs {
  liveCfg?: LiveOscarConfig | null;
  open: Map<string, OpenTrade>;
  forceExitLive: (openKey: string, marketSell: number) => Promise<boolean>;
}

export async function runMemSwanPortfolioSweep(args: MemSwanPortSweepArgs): Promise<void> {
  const { liveCfg, open } = args;
  if (!liveCfg || liveCfg.executionMode !== 'live') return;
  if (!liveCfg.liveMemSwanPortEnabled || liveCfg.liveMemSwanPortMode === 'off') return;

  ingestMemSwanPortfolioTick(liveCfg);

  const riseTs = consumeMemSwanPortRisingEdge(liveCfg);
  if (riseTs == null) return;

  const m = state.lastMetrics;
  const detail = {
    ewReturnPct: num(m?.ewReturnPct ?? null),
    medReturnPct: num(m?.medReturnPct ?? null),
    breadthRedPct: num(m?.breadthRedPct ?? null),
    positionCount: m?.positionCount ?? null,
    ewDropThresholdPct: liveCfg.liveMemSwanPortEwDropPct,
    rollMin: liveCfg.liveMemSwanPortRollMin,
    minPositions: liveCfg.liveMemSwanPortMinPositions,
  };

  const entries = [...open.entries()];
  const openMints = entries.map(([, ot]) => ot.symbol || ot.mint.slice(0, 8));

  if (liveCfg.liveMemSwanPortMode === 'shadow') {
    appendLiveJsonlEvent({
      kind: 'risk_note',
      reason: 'mem_swan_port_would_liquidate',
      detail: { ...detail, openCount: entries.length, openMints },
    });
    log.warn({ ...detail, openCount: entries.length }, 'mem-swan-port SHADOW: would liquidate all open positions');
    return;
  }

  appendLiveJsonlEvent({
    kind: 'risk_block',
    limit: 'mem_swan_port_liquidate',
    detail: { ...detail, openCount: entries.length, openMints },
  });
  log.warn({ ...detail, openCount: entries.length }, 'mem-swan-port LIQUIDATE: closing all open positions');

  let liquidated = 0;
  let failed = 0;
  let noPrice = 0;
  for (const [openKey, ot] of entries) {
    if (ot.mint === WRAPPED_SOL_MINT) continue;
    const bareMint = mintFromOpenMapKey(openKey);
    const px = state.lastMarks.get(bareMint) ?? state.lastMarks.get(ot.mint);
    if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) {
      noPrice++;
      continue;
    }
    try {
      const ok = await args.forceExitLive(openKey, px);
      if (ok) liquidated++;
      else failed++;
    } catch (e) {
      failed++;
      log.warn({ mint: ot.mint.slice(0, 8), err: String((e as Error)?.message ?? e) }, 'mem-swan-port sell failed');
    }
    const delay = liveCfg.liveTrackerInterMintDelayMs;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  appendLiveJsonlEvent({
    kind: 'risk_note',
    reason: 'mem_swan_port_liquidate_done',
    detail: { ...detail, attempted: entries.length, liquidated, failed, noPrice },
  });
  log.warn({ attempted: entries.length, liquidated, failed, noPrice }, 'mem-swan-port LIQUIDATE done');
}
