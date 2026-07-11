/**
 * Knife scalp exit — infinite TP grid + break-even / ladder-retrace + peak trail (Oscar-style).
 * Pure functions for unit tests; no I/O.
 */

export interface KnifeExitLadderConfig {
  /** Uniform grid step in % vs avg entry (e.g. 5 → +5%, +10%, +15%…). */
  gridStepPct: number;
  /** Sell fraction of **initial** qty at each rung; last value repeats for higher rungs. */
  gridSellFracs: number[];
  /** After the first partial TP, floor PnL% — exit remainder if price falls back (break-even). */
  beFloorPct: number;
  /** Min partial TP rungs before ladder-retrace floor (Oscar: ≥2). */
  retraceMinRungs: number;
  /** Peak trail arms when unrealized PnL reaches this % vs avg entry. */
  trailArmPct: number;
  /** Exit remainder when PnL falls this many % points from peak (after trail armed). */
  trailDropPct: number;
  killPct: number;
}

export interface KnifeLadderSnapshot {
  /** Sorted unique rung PnL thresholds already hit (e.g. [5, 10]). */
  firedRungPnls: number[];
  peakPnlPct: number;
  trailArmed: boolean;
}

const PNL_EPS = 1e-6;

export function knifePnlPct(price: number, avgEntry: number): number {
  if (!(avgEntry > 0) || !(price > 0)) return 0;
  return ((price / avgEntry - 1) * 100);
}

export function parseKnifeGridSellFracs(raw: unknown, fallback: number[]): number[] {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return fallback;
  const out = s
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0 && x <= 1);
  return out.length > 0 ? out : fallback;
}

export function sellFracForRungIndex(cfg: KnifeExitLadderConfig, rungIndex: number): number {
  const fracs = cfg.gridSellFracs;
  if (fracs.length === 0) return 0.35;
  const idx = Math.min(rungIndex, fracs.length - 1);
  return fracs[idx]!;
}

/** Next grid rung threshold (% vs avg) not yet fired. */
export function nextGridRungPnl(cfg: KnifeExitLadderConfig, firedCount: number): number {
  return cfg.gridStepPct * (firedCount + 1);
}

export function markRungFired(fired: number[], pnlPct: number): number[] {
  if (fired.some((x) => Math.abs(x - pnlPct) <= PNL_EPS)) return fired;
  return [...fired, pnlPct].sort((a, b) => a - b);
}

/**
 * Break-even / ladder-retrace floor (grid mode, Oscar `ladderRetraceFloorPnlFrac` simplified).
 * - 1 rung fired → `beFloorPct` (typically 0 = entry)
 * - ≥2 rungs → previous rung threshold
 */
export function ladderRetraceFloorPnlPct(
  cfg: KnifeExitLadderConfig,
  firedRungPnls: number[],
): number | null {
  if (firedRungPnls.length === 0) return null;
  const sorted = [...firedRungPnls].sort((a, b) => a - b);
  if (sorted.length === 1) return cfg.beFloorPct;
  if (sorted.length < cfg.retraceMinRungs) return cfg.beFloorPct;
  return sorted[sorted.length - 2]!;
}

export function ladderRetraceTriggered(
  cfg: KnifeExitLadderConfig,
  firedRungPnls: number[],
  currentPnlPct: number,
): boolean {
  const floor = ladderRetraceFloorPnlPct(cfg, firedRungPnls);
  if (floor === null) return false;
  if (firedRungPnls.length >= cfg.retraceMinRungs) {
    return currentPnlPct <= floor + PNL_EPS;
  }
  if (firedRungPnls.length >= 1) {
    return currentPnlPct <= cfg.beFloorPct + PNL_EPS;
  }
  return false;
}

export function peakTrailTriggered(
  cfg: KnifeExitLadderConfig,
  snap: KnifeLadderSnapshot,
  currentPnlPct: number,
): boolean {
  if (!snap.trailArmed || snap.peakPnlPct <= 0) return false;
  return currentPnlPct <= snap.peakPnlPct - cfg.trailDropPct + PNL_EPS;
}

export function updatePeakTrailArm(
  cfg: KnifeExitLadderConfig,
  snap: KnifeLadderSnapshot,
  currentPnlPct: number,
): KnifeLadderSnapshot {
  const peakPnlPct = Math.max(snap.peakPnlPct, currentPnlPct);
  const trailArmed = snap.trailArmed || peakPnlPct >= cfg.trailArmPct;
  return { ...snap, peakPnlPct, trailArmed };
}

/** Rung indices (0-based) whose thresholds are newly reachable at `currentPnlPct`. */
export function newlyReachableRungs(
  cfg: KnifeExitLadderConfig,
  firedRungPnls: number[],
  currentPnlPct: number,
): number[] {
  const firedCount = firedRungPnls.length;
  const out: number[] = [];
  let idx = firedCount;
  for (;;) {
    const thr = nextGridRungPnl(cfg, idx);
    if (currentPnlPct + PNL_EPS < thr) break;
    out.push(idx);
    idx += 1;
    if (idx > 200) break;
  }
  return out;
}

export function defaultKnifeExitLadderConfig(
  env: NodeJS.ProcessEnv = process.env,
): KnifeExitLadderConfig {
  const step = Number(env.KNIFE_TP_GRID_STEP_PCT ?? 5);
  return {
    gridStepPct: Number.isFinite(step) && step > 0 ? step : 5,
    gridSellFracs: parseKnifeGridSellFracs(env.KNIFE_TP_GRID_SELL_FRACS, [0.5, 0.45, 0.4, 0.35]),
    beFloorPct: Number.isFinite(Number(env.KNIFE_TP_GRID_BE_FLOOR_PCT))
      ? Number(env.KNIFE_TP_GRID_BE_FLOOR_PCT)
      : 0,
    retraceMinRungs: Math.max(2, Math.round(Number(env.KNIFE_TP_RETRACE_MIN_RUNGS ?? 2))),
    trailArmPct: Number(env.KNIFE_TRAIL_ARM_PCT ?? 10),
    trailDropPct: Number(env.KNIFE_TRAIL_DROP_PCT ?? 5),
    killPct: Number(env.KNIFE_KILL_PCT ?? 30),
  };
}
