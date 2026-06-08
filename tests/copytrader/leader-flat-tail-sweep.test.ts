import { describe, expect, it, vi } from 'vitest';
import { hasPendingSellForMint, isLeaderFlatForMint } from '../../src/copytrader/leader-flat-tail-sweep.js';
import { leaderPreBalanceRaw } from '../../src/copytrader/leader-ledger.js';
import * as rpc from '../../src/copytrader/rpc.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';
import { emptyCopyTraderState } from '../../src/copytrader/state.js';

const cfg = { rpcUrl: 'http://rpc', targetWallet: 'LeaderWallet1111111111111111111111111111' } as CopyTraderConfig;

describe('leader flat tail sweep', () => {
  it('detects pending sell for mint', () => {
    const state = emptyCopyTraderState();
    state.pendingSells.push({
      id: 'ps_1',
      mint: 'mintA',
      symbol: 'A',
      leaderSignature: 'sig',
      leaderSellTs: 0,
      dueTs: 0,
      fraction: 1,
      retryUntilTs: 9999,
    });
    expect(hasPendingSellForMint(state, 'mintA')).toBe(true);
    expect(hasPendingSellForMint(state, 'mintB')).toBe(false);
  });

  it('leader ledger zero after full exit', () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '0' };
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(0n);
  });

  it('leader flat when on-chain balance is zero despite stale ledger', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '9000000' };
    vi.spyOn(rpc, 'fetchWalletMintBalanceRaw').mockResolvedValue(0n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA')).resolves.toBe(true);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(0n);
    vi.restoreAllMocks();
  });

  it('leader not flat when ledger and on-chain both hold tokens', async () => {
    const state = emptyCopyTraderState();
    state.leaderLedger.mintA = { tokenRaw: '9000000' };
    vi.spyOn(rpc, 'fetchWalletMintBalanceRaw').mockResolvedValue(5_000_000n);
    await expect(isLeaderFlatForMint(cfg, state, 'mintA')).resolves.toBe(false);
    expect(leaderPreBalanceRaw(state, 'mintA')).toBe(9_000_000n);
    vi.restoreAllMocks();
  });
});
