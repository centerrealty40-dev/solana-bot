import { shouldRemainderFlush } from '../oscar-remainder-flush.js';
import type { HlOscarMajorsScalpConfig } from './config.js';
import type { OscarOpenPosition } from './position-types.js';
import type { MajorsExitAction } from './exit-engine.js';

function pnlFrac(avgEntry: number, price: number): number {
  return price / avgEntry - 1;
}

/** Scalp SL as negative PnL fraction (e.g. 2.5 → −0.025). */
export function scalpSlFrac(cfg: HlOscarMajorsScalpConfig): number {
  return -(cfg.slPct / 100);
}

export function computeScalpExitActions(
  pos: OscarOpenPosition,
  cfg: HlOscarMajorsScalpConfig,
  markPx: number,
  lowPx: number,
  highPx: number,
  nowMs: number,
  remainderClosePct: number,
): MajorsExitAction[] {
  const actions: MajorsExitAction[] = [];
  const avg = pos.avgEntryPx;
  if (!(avg > 0)) return actions;

  const pnlLow = pnlFrac(avg, lowPx);
  const pnlHigh = pnlFrac(avg, highPx);
  const pnlMark = pnlFrac(avg, markPx);
  const slFrac = scalpSlFrac(cfg);

  if (pnlLow <= slFrac + 1e-9) {
    actions.push({
      kind: 'full',
      reason: 'SCALP_SL',
      triggerPx: avg * (1 + slFrac),
    });
    return actions;
  }

  if (shouldRemainderFlush(pos.remainingFraction, remainderClosePct)) {
    actions.push({ kind: 'full', reason: 'REMAINDER_FLUSH' });
    return actions;
  }

  pos.peakPnlFrac = Math.max(pos.peakPnlFrac, pnlHigh);
  const trailArmFrac = cfg.trailArmPct / 100;
  const trailStepFrac = cfg.trailStepPct / 100;
  if (pnlHigh + 1e-9 >= trailArmFrac) pos.preArmReached = true;

  for (let rung = 0; rung < cfg.tpRungs.length; rung++) {
    const thr = cfg.tpRungs[rung]!;
    if (pos.tpLevelsTaken.has(rung)) continue;
    if (pnlHigh + 1e-9 >= thr) {
      pos.tpLevelsTaken.add(rung);
      pos.maxTpTaken = Math.max(pos.maxTpTaken, thr);
      actions.push({
        kind: 'partial',
        fraction: cfg.tpSellFrac,
        reason: 'TP',
        level: rung + 1,
      });
    }
  }

  const trailActive = pos.maxTpTaken + 1e-9 >= trailArmFrac || pos.preArmReached;
  if (trailActive && cfg.trailStepPct > 0) {
    pos.trailAnchor = Math.max(pos.trailAnchor, pos.peakPnlFrac, pnlHigh);
    const dropFromPeak = pos.trailAnchor - pnlLow;
    if (dropFromPeak >= trailStepFrac) {
      const steps = Math.floor(dropFromPeak / trailStepFrac);
      for (let s = 1; s <= steps; s++) {
        const key = Math.round((pos.trailAnchor - s * trailStepFrac) * 1000);
        if (pos.trailLevelsTaken.has(key)) continue;
        pos.trailLevelsTaken.add(key);
        actions.push({
          kind: 'partial',
          fraction: cfg.trailSellFrac,
          reason: 'TRAIL',
        });
      }
    }
  }

  if (
    trailActive &&
    pos.maxTpTaken + 1e-9 >= trailArmFrac &&
    pnlMark <= 0 &&
    pos.remainingFraction > 1e-6
  ) {
    actions.push({ kind: 'full', reason: 'BREAKEVEN' });
    return actions;
  }

  const ageMin = (nowMs - pos.entryTs) / 60_000;
  if (ageMin >= cfg.timeStopMin && pos.remainingFraction > 1e-6) {
    actions.push({ kind: 'full', reason: 'TIME_STOP' });
  }

  return actions;
}
