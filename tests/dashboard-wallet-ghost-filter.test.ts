import { describe, expect, it } from 'vitest';
import {
  _clearDashboardWalletMintCacheForTests,
  filterLiveOscarOpensByWalletMints,
  type Paper2OpenItem,
} from '../scripts-tmp/dashboard-server.js';

function openRow(mint: string): Paper2OpenItem {
  return {
    mint,
    symbol: 'TEST',
    entryTs: 1,
    entryMcUsd: 100,
    entryRealMcUsd: 100,
    avgEntry: 1,
    avgEntryMarket: 100,
    baselinePriceUsd: 1,
    lastObservedPriceUsd: 1,
    liveMcUsd: 100,
    livePriceUsd: 1,
    pnlPct: 0,
    pnlUsd: 0,
    peakPct: 0,
    trailingArmed: false,
    totalInvestedUsd: 10,
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: null,
    entryPriceVerifyImpactPct: null,
    entryPriceVerifySource: null,
    pairAddress: null,
    entryLiqUsd: null,
    remainingFraction: 1,
    liveOscarTradeLane: 'prod',
    isScalpWave: false,
    isRunnerProbe: false,
  };
}

describe('filterLiveOscarOpensByWalletMints', () => {
  it('drops opens whose mint is absent from wallet SPL set', () => {
    _clearDashboardWalletMintCacheForTests();
    const wallet = new Set(['mintA', 'mintB']);
    const { open, walletGhostCount } = filterLiveOscarOpensByWalletMints(
      [openRow('mintA'), openRow('ghost1'), openRow('mintB'), openRow('ghost2')],
      wallet,
    );
    expect(open.map((o) => o.mint)).toEqual(['mintA', 'mintB']);
    expect(walletGhostCount).toBe(2);
  });

  it('passes through all rows when wallet set is unavailable', () => {
    const rows = [openRow('x'), openRow('y')];
    const { open, walletGhostCount } = filterLiveOscarOpensByWalletMints(rows, null);
    expect(open).toEqual(rows);
    expect(walletGhostCount).toBe(0);
  });
});
