import { detectRollingFlush } from './knife-flush-detector.js';

export interface KnifeFlushLeg2MintState {
  mint: string;
  buf: Array<{ t: number; p: number }>;
  legs: number;
  leg1Price: number;
  qtyFilled: number;
  qty: number;
  avgEntry: number;
  investedUsd: number;
}

export interface KnifeFlushLeg2Config {
  flushLeg2Enabled: boolean;
  flushTriggerEnabled: boolean;
  flushWindowMs: number;
  flushLeg2MinDumpPct: number;
  maxDrawdownPct: number;
  maxBounceFromDumpPct: number;
  globalEntryGapMs: number;
  legUsd: number;
  positionUsd: number;
}

export interface KnifeFlushLeg2Result {
  fired: boolean;
  dumpPct?: number;
  bouncePct?: number;
}

function fillLeg(state: KnifeFlushLeg2MintState, legUsd: number, price: number): void {
  const qtyLeg = legUsd / price;
  state.qtyFilled += qtyLeg;
  state.qty += qtyLeg;
  state.investedUsd += legUsd;
  state.legs += 1;
  state.avgEntry = state.investedUsd / state.qtyFilled;
}

/** Leg2 on a fresh floor flush while leg1 is open (6Nwar-class reconcile add). */
export function evaluateKnifeFlushLeg2(
  cfg: KnifeFlushLeg2Config,
  state: KnifeFlushLeg2MintState,
  price: number,
  tsMs: number,
  globalLastEntryAtMs: number,
): KnifeFlushLeg2Result {
  if (!cfg.flushLeg2Enabled || !cfg.flushTriggerEnabled || state.legs >= 2) {
    return { fired: false };
  }
  if (state.investedUsd + cfg.legUsd > cfg.positionUsd + 1e-6) {
    return { fired: false };
  }
  if (tsMs - globalLastEntryAtMs < cfg.globalEntryGapMs) {
    return { fired: false };
  }

  const flush = detectRollingFlush(state.buf, price, tsMs, {
    flushWindowMs: cfg.flushWindowMs,
    flushMinDumpPct: cfg.flushLeg2MinDumpPct,
    maxDrawdownPct: cfg.maxDrawdownPct,
  });
  if (!flush) return { fired: false };

  const bouncePct = ((price - flush.dumpLow) / flush.dumpLow) * 100;
  if (bouncePct > cfg.maxBounceFromDumpPct) return { fired: false };

  fillLeg(state, cfg.legUsd, price);
  return {
    fired: true,
    dumpPct: flush.dumpPct,
    bouncePct: Number(bouncePct.toFixed(2)),
  };
}
