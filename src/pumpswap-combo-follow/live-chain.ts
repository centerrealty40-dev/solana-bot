import { fetchLiveWalletSplBalancesByMint } from '../live/reconcile-live.js';
import { comboLiveBridge } from '../pumpswap-combo/live-bridge.js';
import type { ComboPosition } from '../pumpswap-combo/types.js';
import { pnlPctVsAvgFill } from '../pumpswap-combo/pricing.js';
import { investedUsd } from '../pumpswap-combo/state.js';
import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import type { FollowPosition } from './types.js';

export function followPositionAsCombo(pos: FollowPosition): ComboPosition {
  return {
    mint: pos.mint,
    symbol: pos.symbol,
    poolAddress: pos.poolAddress,
    openedAt: pos.openedAt,
    legs: pos.legs,
    botPeakUsd: pos.botPeakUsd,
    tp1Taken: pos.rungsTaken.length > 0,
  };
}

/** Estimate original token qty from legs (same as paper bag). */
export function followOriginalTokenQty(pos: FollowPosition): number {
  let qty = 0;
  for (const leg of pos.legs) {
    if (leg.fillPriceUsd > 0 && leg.usd > 0) qty += leg.usd / leg.fillPriceUsd;
  }
  return qty;
}

export async function syncFollowRemainingFracFromChain(
  cfg: PumpswapComboFollowConfig,
  pos: FollowPosition,
): Promise<number | null> {
  const execCfg = toComboExecutorConfig(cfg);
  const liveCfg = comboLiveBridge(execCfg);
  const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
  const raw = chainMap?.get(pos.mint) ?? 0n;
  const origQty = followOriginalTokenQty(pos);
  if (!(origQty > 0)) {
    pos.remainingFrac = raw <= 0n ? 0 : pos.remainingFrac;
    return pos.remainingFrac;
  }
  const estDecimals = 6;
  const origRaw = BigInt(Math.max(1, Math.floor(origQty * 10 ** estDecimals)));
  if (raw <= 0n) {
    pos.remainingFrac = 0;
    return 0;
  }
  const frac = Math.min(1, Math.max(0, Number(raw) / Number(origRaw)));
  pos.remainingFrac = frac;
  return frac;
}

export function liveInvestedUsd(pos: FollowPosition): number {
  return investedUsd(followPositionAsCombo(pos));
}

export function livePnlPct(pos: FollowPosition, markPriceUsd: number): number {
  return pnlPctVsAvgFill(followPositionAsCombo(pos), markPriceUsd);
}
