import { appendMildDipJournal, saveMildDipState } from './state.js';
import type { MildDipConfig } from './config.js';
import { externalBagSettleCashDeltaUsd } from './mirror-loss-cap.js';
import type { MildDipState } from './state.js';

export type BuyOnlyBagVerdict =
  | 'skip_have_bag'
  | 'clear_phantom'
  | 'skip_unknown';

export function buyOnlyBagVerdict(args: {
  balanceRaw: bigint | null;
  positionAgeMs: number;
  minAgeMs: number;
}): BuyOnlyBagVerdict {
  if (args.positionAgeMs < args.minAgeMs) return 'skip_have_bag';
  if (args.balanceRaw == null) return 'skip_unknown';
  return args.balanceRaw > 0n ? 'skip_have_bag' : 'clear_phantom';
}

export function clearBuyOnlyPhantomBag(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  mint: string;
  nowMs: number;
}): void {
  const pos = args.state.open[args.mint];
  if (!pos) return;
  const cashDeltaUsd = externalBagSettleCashDeltaUsd({
    sizeUsd: pos.sizeUsd,
    lane: pos.lane,
    lossCapAllLanes: args.cfg.leaderMirror.lossCapAllLanes,
  });
  if (cashDeltaUsd > 0) {
    args.state.mirrorTradingCashUsd =
      (args.state.mirrorTradingCashUsd ?? 0) + cashDeltaUsd;
  }
  delete args.state.open[args.mint];
  delete args.state.mirrorBuyNotify?.[args.mint];
  saveMildDipState(args.cfg.statePath, args.state);
  appendMildDipJournal(args.cfg.journalPath, {
    kind: 'mirror_buy_only_phantom_bag_cleared',
    mint: args.mint,
    symbol: pos.symbol,
    sizeUsd: pos.sizeUsd,
    cashDeltaUsd,
    positionAgeMs: args.nowMs - (pos.openedAtMs ?? 0),
  });
}
