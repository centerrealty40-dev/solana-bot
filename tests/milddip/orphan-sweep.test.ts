import { describe, expect, it } from 'vitest';
import { isOrphanSellBurnFallbackReason } from '../../src/milddip/orphan-janitor.js';

describe('isOrphanSellBurnFallbackReason', () => {
  it('burns on jupiter quote/sim failures', () => {
    expect(isOrphanSellBurnFallbackReason('jupiter_sell_quote_failed')).toBe(true);
    expect(isOrphanSellBurnFallbackReason('jupiter_sell_swap_failed')).toBe(true);
    expect(isOrphanSellBurnFallbackReason('sim_failed:{"InstructionError":[3,{"Custom":6024}]}')).toBe(
      true,
    );
    expect(isOrphanSellBurnFallbackReason('route_too_impactful:12%')).toBe(true);
  });

  it('does not burn on transient infra errors', () => {
    expect(isOrphanSellBurnFallbackReason('confirm_timeout')).toBe(false);
    expect(isOrphanSellBurnFallbackReason('insufficient_fee_sol')).toBe(false);
    expect(isOrphanSellBurnFallbackReason(null)).toBe(false);
  });
});

describe('isMildDipOrphanMint', () => {
  it('matches pump suffix for sell-first lane', async () => {
    const { isMildDipOrphanMint } = await import('../../src/milddip/sell-settle.js');
    expect(isMildDipOrphanMint('HFtSg8bDDHqazacpAWax2VYuxVBDKS68ERFu2J56pump')).toBe(true);
    expect(isMildDipOrphanMint('So11111111111111111111111111111111111111112')).toBe(false);
  });
});
