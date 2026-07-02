import { shouldRemainderFlush } from '../oscar-remainder-flush.js';
import type { HlOscarPerpConfig } from './config.js';
import type { OscarOpenPosition } from './position-types.js';

/**
 * HL Oscar perp exit ladder (wave B runner).
 *
 * TP: sell `tpSellFrac` (50%) of **remaining** at each rung in `tpRungs` (env: HL_OSCAR_TP_RUNGS).
 * Trail arms at `trailArmFrac` (env: HL_OSCAR_TRAIL_ARM_PCT); −2.5% from peak → sell 20% of remaining per step.
 * Breakeven full exit at ≤0% avg after trail armed (first TP or trail arm).
 * Kill −45% and optional time stop are config-driven (`positionKillDropPct`, `timeStopHours`; `0` = off).
 */
export const OSCAR_EXIT_DEFAULTS = {
  tpRungs: [0.08, 0.12, 0.16] as const,
  tpSellFrac: 0.5,
  trailArmFrac: 0.08,
  trailStepDropFrac: 0.025,
  trailSellFrac: 0.2,
} as const;

/** @deprecated Use config-driven exit params via `resolveOscarExitParams`. */
export const OSCAR_EXIT = OSCAR_EXIT_DEFAULTS;

export type OscarExitParams = {
  tpRungs: readonly number[];
  tpSellFrac: number;
  trailArmFrac: number;
  trailStepDropFrac: number;
  trailSellFrac: number;
};

export function resolveOscarExitParams(cfg: HlOscarPerpConfig): OscarExitParams {
  return {
    tpRungs: cfg.tpRungs.length > 0 ? cfg.tpRungs : [...OSCAR_EXIT_DEFAULTS.tpRungs],
    tpSellFrac: cfg.tpSellFrac,
    trailArmFrac: cfg.trailArmFrac,
    trailStepDropFrac: cfg.trailStepDropFrac,
    trailSellFrac: cfg.trailSellFrac,
  };
}

/** Position kill as negative PnL fraction (e.g. 45 → −0.45). */
export function positionKillFrac(cfg: HlOscarPerpConfig): number {
  return -(cfg.positionKillDropPct / 100);
}

export type OscarExitAction =
  | { kind: 'none' }
  | { kind: 'partial'; fraction: number; reason: string; level?: number }
  | { kind: 'full'; reason: string; triggerPx?: number };

function pnlFrac(avgEntry: number, price: number): number {
  return price / avgEntry - 1;
}

export function computeOscarExitActions(
  pos: OscarOpenPosition,
  cfg: HlOscarPerpConfig,
  markPx: number,
  lowPx: number,
  highPx: number,
  nowMs: number,
): OscarExitAction[] {
  const exit = resolveOscarExitParams(cfg);
  const actions: OscarExitAction[] = [];
  const avg = pos.avgEntryPx;
  if (!(avg > 0)) return actions;

  const stagedKillPx = pos.signalPrice * (1 - cfg.stagedKillDropPct / 100);
  if (lowPx <= stagedKillPx && pos.remainingFraction > 1e-6) {
    actions.push({ kind: 'full', reason: 'STAGED_KILL', triggerPx: stagedKillPx });
    return actions;
  }

  const pnlLow = pnlFrac(avg, lowPx);
  const pnlHigh = pnlFrac(avg, highPx);
  const pnlMark = pnlFrac(avg, markPx);
  const killFrac = positionKillFrac(cfg);

  if (pnlLow <= killFrac + 1e-9) {
    actions.push({
      kind: 'full',
      reason: 'KILL',
      triggerPx: avg * (1 + killFrac),
    });
    return actions;
  }

  if (shouldRemainderFlush(pos.remainingFraction, cfg.remainderClosePct)) {
    actions.push({ kind: 'full', reason: 'REMAINDER_FLUSH' });
    return actions;
  }

  pos.peakPnlFrac = Math.max(pos.peakPnlFrac, pnlHigh);
  if (pnlHigh + 1e-9 >= exit.trailArmFrac) pos.preArmReached = true;

  for (let rung = 0; rung < exit.tpRungs.length; rung++) {
    const thr = exit.tpRungs[rung]!;
    if (pos.tpLevelsTaken.has(rung)) continue;
    if (pnlHigh + 1e-9 >= thr) {
      pos.tpLevelsTaken.add(rung);
      pos.maxTpTaken = Math.max(pos.maxTpTaken, thr);
      actions.push({
        kind: 'partial',
        fraction: exit.tpSellFrac,
        reason: 'TP',
        level: rung + 1,
      });
    }
  }

  const trailActive = pos.maxTpTaken + 1e-9 >= exit.trailArmFrac || pos.preArmReached;
  if (trailActive) {
    pos.trailAnchor = Math.max(pos.trailAnchor, pos.peakPnlFrac, pnlHigh);
    const dropFromPeak = pos.trailAnchor - pnlLow;
    if (dropFromPeak >= exit.trailStepDropFrac) {
      const steps = Math.floor(dropFromPeak / exit.trailStepDropFrac);
      for (let s = 1; s <= steps; s++) {
        const key = Math.round((pos.trailAnchor - s * exit.trailStepDropFrac) * 1000);
        if (pos.trailLevelsTaken.has(key)) continue;
        pos.trailLevelsTaken.add(key);
        actions.push({
          kind: 'partial',
          fraction: exit.trailSellFrac,
          reason: 'TRAIL',
        });
      }
    }
  }

  if (
    trailActive &&
    pos.maxTpTaken + 1e-9 >= exit.trailArmFrac &&
    pnlMark <= 0 &&
    pos.remainingFraction > 1e-6
  ) {
    actions.push({ kind: 'full', reason: 'BREAKEVEN' });
    return actions;
  }

  const ageH = (nowMs - pos.entryTs) / 3_600_000;
  if (cfg.timeStopHours > 0 && ageH >= cfg.timeStopHours && pos.remainingFraction > 1e-6) {
    actions.push({ kind: 'full', reason: 'TIME_STOP' });
  }

  return actions;
}
