import { beforeEach, describe, expect, it } from 'vitest';
import { checkCopyFundingGate, resetCopyFundingCache } from '../../src/copytrader/funding-gate.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';

function cfg(over: Partial<CopyTraderConfig> = {}): CopyTraderConfig {
  return {
    quoteAsset: 'USDC',
    minFeeSolReserve: 0.02,
    rpcUrl: '',
    walletPubkeyExpected: undefined,
    ...over,
  } as unknown as CopyTraderConfig;
}

describe('checkCopyFundingGate', () => {
  beforeEach(() => {
    resetCopyFundingCache();
  });

  it('is a no-op for SOL-funded lanes', async () => {
    const v = await checkCopyFundingGate(cfg({ quoteAsset: 'SOL' }), 100);
    expect(v.ok).toBe(true);
  });

  it('rejects a non-positive buy size', async () => {
    const v = await checkCopyFundingGate(cfg(), 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('invalid_buy_usd');
  });

  it('blocks the buy when the wallet cannot be read instead of guessing', async () => {
    const v = await checkCopyFundingGate(cfg(), 100);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('wallet_balance_rpc');
  });
});
