import { shouldRemainderFlush } from '../oscar-remainder-flush.js';
import type { HlOscarPerpConfig } from './config.js';
import type { OscarOpenPosition } from './position-types.js';

/**
 * HL Oscar perp exit ladder (wave B runner).
 *
 * TP: sell `tpSellFrac` (50%) of **remaining** at each rung in `tpRungs` (+5%, +7.5%, +10%).
 * Trail arms at first +5% touch; −2.5% from peak → sell 20% of remaining per step.
 * Breakeven full exit at ≤0% avg after trail armed (first TP or +5% peak).
 * Kill −45% and time stop 12h are config-driven (`positionKillDropPct`, `timeStopHours`).
 */
export const OSCAR_EXIT = {
  /** Take-profit thresholds vs avg entry (PnL fraction). */
  tpRungs: [0.05, 0.075, 0.1] as const,
  /** Fraction of **remaining** position sold at each TP rung. */
  tpSellFrac: 0.5,
  /** Trail + breakeven arm when peak/TP reaches this PnL fraction (+5%). */
  trailArmFrac: 0.05,
  /** Trail fires when price drops this far below peak PnL anchor (−2.5%). */
  trailStepDropFrac: 0.025,
  /** Fraction of **remaining** sold on each trail step. */
  trailSellFrac: 0.2,
} as const;

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
  if (pnlHigh + 1e-9 >= OSCAR_EXIT.trailArmFrac) pos.preArmReached = true;

  for (let rung = 0; rung < OSCAR_EXIT.tpRungs.length; rung++) {
    const thr = OSCAR_EXIT.tpRungs[rung]!;
    if (pos.tpLevelsTaken.has(rung)) continue;
    if (pnlHigh + 1e-9 >= thr) {
      pos.tpLevelsTaken.add(rung);
      pos.maxTpTaken = Math.max(pos.maxTpTaken, thr);
      actions.push({
        kind: 'partial',
        fraction: OSCAR_EXIT.tpSellFrac,
        reason: 'TP',
        level: rung + 1,
      });
    }
  }

  const trailActive =
    pos.maxTpTaken + 1e-9 >= OSCAR_EXIT.trailArmFrac || pos.preArmReached;
  if (trailActive) {
    pos.trailAnchor = Math.max(pos.trailAnchor, pos.peakPnlFrac, pnlHigh);
    const dropFromPeak = pos.trailAnchor - pnlLow;
    if (dropFromPeak >= OSCAR_EXIT.trailStepDropFrac) {
      const steps = Math.floor(dropFromPeak / OSCAR_EXIT.trailStepDropFrac);
      for (let s = 1; s <= steps; s++) {
        const key = Math.round((pos.trailAnchor - s * OSCAR_EXIT.trailStepDropFrac) * 1000);
        if (pos.trailLevelsTaken.has(key)) continue;
        pos.trailLevelsTaken.add(key);
        actions.push({
          kind: 'partial',
          fraction: OSCAR_EXIT.trailSellFrac,
          reason: 'TRAIL',
        });
      }
    }
  }

  if (
    trailActive &&
    pos.maxTpTaken + 1e-9 >= OSCAR_EXIT.trailArmFrac &&
    pnlMark <= 0 &&
    pos.remainingFraction > 1e-6
  ) {
    actions.push({ kind: 'full', reason: 'BREAKEVEN' });
    return actions;
  }

  const ageH = (nowMs - pos.entryTs) / 3_600_000;
  if (ageH >= cfg.timeStopHours && pos.remainingFraction > 1e-6) {
    actions.push({ kind: 'full', reason: 'TIME_STOP' });
  }

  return actions;
}
