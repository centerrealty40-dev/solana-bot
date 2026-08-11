import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.838 — third and last member of the stale-balance family.
 *
 * 1.11.829 fixed the read *after* a sell, 1.11.831 the read *before* one. This is
 * the read right after a *buy*: the node still answers the pre-buy state, and the
 * executor treated that zero as an empty wallet and refused the exit.
 *
 * Live `k6BE8rs`: the engine decided to bank at **+14.36% MFE** 25s after entry,
 * got `no_token_balance` four times across 11 seconds, and filled at **−2.83%**.
 * The next round trip on the same mint decided at +20.35% and realized −11.37%.
 */
describe('sell balance re-read', () => {
  const src = readFileSync(resolve('src/copytrader/live-exec.ts'), 'utf8');

  it('re-reads before believing a zero token balance', () => {
    expect(src).toContain('for (let i = 0; onchainRaw <= 0n && i < SELL_BALANCE_REREADS; i += 1)');
    expect(src).toContain('onchainRaw = parseRaw(onchainStr);');
  });

  it('bounds the added latency to the failing path only', () => {
    const reads = Number(src.match(/const SELL_BALANCE_REREADS = (\d+);/)?.[1] ?? '0');
    const gap = Number(src.match(/const SELL_BALANCE_REREAD_GAP_MS = (\d+);/)?.[1] ?? '0');
    expect(reads).toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(0);
    // Must resolve far faster than the 11s storm it replaces.
    expect(reads * gap).toBeLessThanOrEqual(2_000);
  });

  it('still reports no_token_balance once the re-reads agree', () => {
    expect(src).toContain("reason: 'no_token_balance'");
  });

  it('keeps capping the sell at the on-chain balance', () => {
    expect(src).toContain('totalRaw = onchainRaw;');
    expect(src).toContain('} else if (totalRaw > onchainRaw) {');
  });
});
