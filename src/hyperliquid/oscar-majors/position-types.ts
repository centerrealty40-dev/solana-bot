export type OscarLeg = {
  ts: number;
  grossUsd: number;
  marginUsd: number;
  fillPx: number;
  legIndex: 1 | 2 | 3;
};

export type OscarTradeMode = 'knife' | 'scalp';

export type OscarOpenPosition = {
  id: string;
  coin: string;
  displaySymbol: string;
  /** Strategy lane: knife (Mode A) or scalp (Mode B). */
  tradeMode: OscarTradeMode;
  entryTs: number;
  signalPrice: number;
  signalBarTs: number;
  dipPct: number;
  impulsePct: number;
  windowMin: number;
  legs: OscarLeg[];
  avgEntryPx: number;
  totalGrossUsd: number;
  remainingFraction: number;
  realizedPnlUsd: number;
  tpLevelsTaken: Set<number>;
  trailLevelsTaken: Set<number>;
  maxTpTaken: number;
  peakPnlFrac: number;
  trailAnchor: number;
  preArmReached: boolean;
  leg2Filled: boolean;
  leg3Filled: boolean;
};

export function newOscarPosition(args: {
  id: string;
  coin: string;
  displaySymbol: string;
  tradeMode?: OscarTradeMode;
  signal: { signalPrice: number; barTs: number; dipPct: number; impulsePct: number; windowMin: number };
  leg1: OscarLeg;
}): OscarOpenPosition {
  return {
    id: args.id,
    coin: args.coin,
    displaySymbol: args.displaySymbol,
    tradeMode: args.tradeMode ?? 'knife',
    entryTs: args.leg1.ts,
    signalPrice: args.signal.signalPrice,
    signalBarTs: args.signal.barTs,
    dipPct: args.signal.dipPct,
    impulsePct: args.signal.impulsePct,
    windowMin: args.signal.windowMin,
    legs: [args.leg1],
    avgEntryPx: args.leg1.fillPx,
    totalGrossUsd: args.leg1.grossUsd,
    remainingFraction: 1,
    realizedPnlUsd: 0,
    tpLevelsTaken: new Set(),
    trailLevelsTaken: new Set(),
    maxTpTaken: 0,
    peakPnlFrac: -Infinity,
    trailAnchor: 0,
    preArmReached: false,
    leg2Filled: false,
    leg3Filled: false,
  };
}

export function recomputeAvgEntry(pos: OscarOpenPosition): void {
  let sumUsd = 0;
  let sumBase = 0;
  for (const leg of pos.legs) {
    sumUsd += leg.grossUsd;
    sumBase += leg.grossUsd / leg.fillPx;
  }
  pos.totalGrossUsd = sumUsd;
  pos.avgEntryPx = sumUsd / sumBase;
}
