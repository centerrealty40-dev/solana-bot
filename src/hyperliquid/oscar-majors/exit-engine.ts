import type { HlOscarMajorsConfig } from './config.js';
import type { OscarOpenPosition } from './position-types.js';

export type MajorsCoinExitParams = {
  tpRungs: readonly number[];
  tpSellFrac: number;
  trailArmFrac: number;
  trailStepDropFrac: number;
  trailSellFrac: number;
};

export function resolveMajorsExitParams(cfg: HlOscarMajorsConfig, coin: string): MajorsCoinExitParams {
  const upper = coin.toUpperCase();
  if (upper === 'ETH') {
    return {
      tpRungs: cfg.ethTpRungs,
      tpSellFrac: cfg.tpSellFrac,
      trailArmFrac: cfg.ethTrailArmFrac,
      trailStepDropFrac: cfg.ethTrailStepDropFrac,
      trailSellFrac: cfg.trailSellFrac,
    };
  }
  return {
    tpRungs: cfg.btcTpRungs,
    tpSellFrac: cfg.tpSellFrac,
    trailArmFrac: cfg.btcTrailArmFrac,
    trailStepDropFrac: cfg.btcTrailStepDropFrac,
    trailSellFrac: cfg.trailSellFrac,
  };
}

/** Position kill as negative PnL fraction (e.g. 15 → −0.15). */
export function positionKillFrac(cfg: HlOscarMajorsConfig): number {
  return -(cfg.positionKillDropPct / 100);
}

export type MajorsExitAction =
  | { kind: 'none' }
  | { kind: 'partial'; fraction: number; reason: string; level?: number }
  | { kind: 'full'; reason: string; triggerPx?: number };

function pnlFrac(avgEntry: number, price: number): number {
  return price / avgEntry - 1;
}

export function computeMajorsExitActions(
  pos: OscarOpenPosition,
  cfg: HlOscarMajorsConfig,
  markPx: number,
  lowPx: number,
  highPx: number,
  nowMs: number,
): MajorsExitAction[] {
  const actions: MajorsExitAction[] = [];
  const avg = pos.avgEntryPx;
  if (!(avg > 0)) return actions;

  const exitParams = resolveMajorsExitParams(cfg, pos.coin);

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

  pos.peakPnlFrac = Math.max(pos.peakPnlFrac, pnlHigh);
  if (pnlHigh + 1e-9 >= exitParams.trailArmFrac) pos.preArmReached = true;

  for (let rung = 0; rung < exitParams.tpRungs.length; rung++) {
    const thr = exitParams.tpRungs[rung]!;
    if (pos.tpLevelsTaken.has(rung)) continue;
    if (pnlHigh + 1e-9 >= thr) {
      pos.tpLevelsTaken.add(rung);
      pos.maxTpTaken = Math.max(pos.maxTpTaken, thr);
      actions.push({
        kind: 'partial',
        fraction: exitParams.tpSellFrac,
        reason: 'TP',
        level: rung + 1,
      });
    }
  }

  const trailActive =
    pos.maxTpTaken + 1e-9 >= exitParams.trailArmFrac || pos.preArmReached;
  if (trailActive) {
    pos.trailAnchor = Math.max(pos.trailAnchor, pos.peakPnlFrac, pnlHigh);
    const dropFromPeak = pos.trailAnchor - pnlLow;
    if (dropFromPeak >= exitParams.trailStepDropFrac) {
      const steps = Math.floor(dropFromPeak / exitParams.trailStepDropFrac);
      for (let s = 1; s <= steps; s++) {
        const key = Math.round((pos.trailAnchor - s * exitParams.trailStepDropFrac) * 1000);
        if (pos.trailLevelsTaken.has(key)) continue;
        pos.trailLevelsTaken.add(key);
        actions.push({
          kind: 'partial',
          fraction: exitParams.trailSellFrac,
          reason: 'TRAIL',
        });
      }
    }
  }

  if (
    trailActive &&
    pos.maxTpTaken + 1e-9 >= exitParams.trailArmFrac &&
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
