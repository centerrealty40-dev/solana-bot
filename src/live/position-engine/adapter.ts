import type { OpenTrade } from '../../papertrader/types.js';
import { entrySplitAllLegsDone, entrySplitLegDoneFromState, entrySplitLegUsdFromState, entrySplitTimedLegIndices } from '../../papertrader/entry-split-legs.js';
import type { ChainSnapshot, ConfirmedBuyLeg, ConfirmedSellLeg, PositionSnapshot } from './types.js';
import { derivePhase, buildEntrySplitProgress } from './guards.js';

/** Count planned entry-split legs (leg1 + timed legs with usd > 0). */
export function countEntrySplitPlannedLegs(st: NonNullable<OpenTrade['liveStagedEntry']>): number {
  let n = 0;
  const leg1Usd = entrySplitLegUsdFromState(st, 1);
  if (leg1Usd > 0) n += 1;
  for (const idx of entrySplitTimedLegIndices()) {
    if (entrySplitLegUsdFromState(st, idx) > 0) n += 1;
  }
  return n;
}

/** Count completed entry-split legs. */
export function countEntrySplitCompletedLegs(st: NonNullable<OpenTrade['liveStagedEntry']>): number {
  let n = 0;
  const leg1Usd = entrySplitLegUsdFromState(st, 1);
  if (leg1Usd > 0) n += 1;
  for (const idx of entrySplitTimedLegIndices()) {
    const usd = entrySplitLegUsdFromState(st, idx);
    if (usd > 0 && entrySplitLegDoneFromState(st, idx)) n += 1;
  }
  return n;
}

/** Map journal legs + entryLegSignatures to confirmed buys (best-effort from OpenTrade). */
export function confirmedBuysFromOpenTrade(ot: OpenTrade): ConfirmedBuyLeg[] {
  const sigs = ot.entryLegSignatures ?? [];
  const legs = ot.legs ?? [];
  const out: ConfirmedBuyLeg[] = [];
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const sig = sigs[i];
    if (typeof sig !== 'string' || sig.length < 16) continue;
    out.push({
      txSignature: sig,
      sizeUsd: leg.sizeUsd,
      effectivePriceUsd: leg.price,
      marketPriceUsd: leg.marketPrice ?? leg.price,
      rawTokens: 0n,
      confirmedTs: leg.ts,
      reason:
        leg.reason === 'entry_split'
          ? 'entry_split'
          : leg.reason === 'staged_avg'
            ? 'staged_avg'
            : leg.reason === 'dca'
              ? 'dca'
              : leg.reason === 'scale_in'
                ? 'scale_in'
                : 'open',
    });
  }
  return out;
}

/** Map partialSells with tx sig to confirmed sells. */
export function confirmedSellsFromOpenTrade(ot: OpenTrade): ConfirmedSellLeg[] {
  const out: ConfirmedSellLeg[] = [];
  for (const ps of ot.partialSells ?? []) {
    const sig = ps.exitTxSignature;
    if (typeof sig !== 'string' || sig.length < 16) continue;
    out.push({
      txSignature: sig,
      solProceedsLamports: ps.solProceedsLamports ? BigInt(ps.solProceedsLamports) : 0n,
      tokensSoldRaw: 0n,
      proceedsUsd: ps.proceedsUsd,
      reason: ps.reason,
      confirmedTs: ps.ts,
    });
  }
  return out;
}

export function snapshotFromOpenTrade(args: {
  ot: OpenTrade;
  chain: ChainSnapshot;
  exitInFlight?: boolean;
}): PositionSnapshot {
  const { ot, chain } = args;
  const st = ot.liveStagedEntry;
  const entrySplitActive = Boolean(st?.entrySplitV2 && st && !entrySplitAllLegsDone(st));
  const entrySplit = buildEntrySplitProgress({
    active: entrySplitActive,
    plannedLegs: st ? countEntrySplitPlannedLegs(st) : 0,
    completedLegs: st ? countEntrySplitCompletedLegs(st) : 0,
  });

  const confirmedBuys = confirmedBuysFromOpenTrade(ot);
  const confirmedSells = confirmedSellsFromOpenTrade(ot);
  const chainHasTokens = chain.rawTokenBalance > 0n;

  const phase = derivePhase({
    entrySplit,
    exitInFlight: args.exitInFlight === true,
    confirmedLegCount: confirmedBuys.length,
    chainHasTokens,
  });

  return {
    mint: ot.mint,
    phase,
    confirmedBuys,
    confirmedSells,
    entrySplit,
    chain,
    journalInvestedUsd: ot.totalInvestedUsd,
    exitInFlight: args.exitInFlight === true,
  };
}
