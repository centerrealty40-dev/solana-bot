import type { ConfirmedBuyLeg, ConfirmedSellLeg, ChainSnapshot } from './types.js';

/** Sum USD notional of confirmed buy legs. */
export function confirmedBuyCostUsd(legs: ConfirmedBuyLeg[]): number {
  let sum = 0;
  for (const leg of legs) {
    if (Number.isFinite(leg.sizeUsd) && leg.sizeUsd > 0) sum += leg.sizeUsd;
  }
  return sum;
}

/** Sum USD proceeds from confirmed partial/full sells. */
export function confirmedSellProceedsUsd(sells: ConfirmedSellLeg[]): number {
  let sum = 0;
  for (const s of sells) {
    if (Number.isFinite(s.proceedsUsd) && s.proceedsUsd > 0) sum += s.proceedsUsd;
  }
  return sum;
}

/** Total raw tokens from confirmed buys minus sold. */
export function confirmedRemainingRawTokens(
  buys: ConfirmedBuyLeg[],
  sells: ConfirmedSellLeg[],
): bigint {
  let bought = 0n;
  for (const b of buys) bought += b.rawTokens > 0n ? b.rawTokens : 0n;
  let sold = 0n;
  for (const s of sells) sold += s.tokensSoldRaw > 0n ? s.tokensSoldRaw : 0n;
  const rem = bought - sold;
  return rem > 0n ? rem : 0n;
}

/** Remaining fraction from confirmed ledger (0..1). */
export function confirmedRemainingFraction(
  buys: ConfirmedBuyLeg[],
  sells: ConfirmedSellLeg[],
): number {
  let bought = 0n;
  for (const b of buys) bought += b.rawTokens > 0n ? b.rawTokens : 0n;
  if (bought <= 0n) return 0;
  const rem = confirmedRemainingRawTokens(buys, sells);
  const frac = Number(rem) / Number(bought);
  if (!Number.isFinite(frac) || frac < 0) return 0;
  return Math.min(1, frac);
}

/** Cost basis still open per confirmed ledger. */
export function confirmedOpenCostUsd(
  buys: ConfirmedBuyLeg[],
  sells: ConfirmedSellLeg[],
): number {
  const totalCost = confirmedBuyCostUsd(buys);
  const frac = confirmedRemainingFraction(buys, sells);
  return totalCost * frac;
}

/** Chain vs journal cost ratio for desync detection. */
export function chainJournalCostRatio(args: {
  chain: ChainSnapshot;
  journalInvestedUsd: number;
  confirmedCostUsd: number;
}): number {
  const chainUsd = args.chain.oscarAttributedUsd;
  if (!(chainUsd > 0)) return 0;
  const denom = Math.max(args.confirmedCostUsd, args.journalInvestedUsd);
  if (!(denom > 0)) return chainUsd > 0 ? 1 : 0;
  return chainUsd / denom;
}

export interface ClosePnlInput {
  confirmedBuys: ConfirmedBuyLeg[];
  confirmedSells: ConfirmedSellLeg[];
  journalInvestedUsd: number;
  chain: ChainSnapshot;
  /** Final leg proceeds USD (chain SOL × spot). */
  finalProceedsUsd: number;
}

export interface ClosePnlOutput {
  costBasisUsd: number;
  totalProceedsUsd: number;
  netPnlUsd: number;
  netPnlPct: number;
  desyncAdjusted: boolean;
}

/**
 * Close PnL: when chain exposure << journal cost, clamp denominator to chain-attributed
 * cost so flat-price exits do not show −75% artifact.
 */
export function computeClosePnl(input: ClosePnlInput): ClosePnlOutput {
  const partialProceeds = confirmedSellProceedsUsd(input.confirmedSells);
  const totalProceedsUsd = partialProceeds + Math.max(0, input.finalProceedsUsd);

  const confirmedCost = confirmedBuyCostUsd(input.confirmedBuys);
  const journalCost = input.journalInvestedUsd;
  const chainUsd = input.chain.oscarAttributedUsd;

  let costBasisUsd = Math.max(confirmedCost, journalCost);
  let desyncAdjusted = false;

  const openJournalCost =
    confirmedRemainingRawTokens(input.confirmedBuys, input.confirmedSells) > 0n ||
    input.confirmedBuys.some((b) => b.rawTokens > 0n)
      ? journalCost * confirmedRemainingFraction(input.confirmedBuys, input.confirmedSells)
      : journalCost;
  const ratio =
    openJournalCost > 0 && chainUsd > 0 ? chainUsd / openJournalCost : chainUsd > 0 ? 1 : 0;

  if (openJournalCost > 0 && chainUsd > 0 && ratio < 0.55) {
    costBasisUsd = Math.max(chainUsd, confirmedOpenCostUsd(input.confirmedBuys, input.confirmedSells));
    desyncAdjusted = true;
  }

  if (!(costBasisUsd > 0)) {
    costBasisUsd = Math.max(chainUsd, totalProceedsUsd, 1e-9);
  }

  const netPnlUsd = totalProceedsUsd - costBasisUsd;
  const netPnlPct = costBasisUsd > 0 ? (netPnlUsd / costBasisUsd) * 100 : 0;

  return {
    costBasisUsd,
    totalProceedsUsd,
    netPnlUsd,
    netPnlPct,
    desyncAdjusted,
  };
}
