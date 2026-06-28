import { afterEach, describe, expect, it } from 'vitest';

import {
  buildOscarUniverse,
  OSCAR_PERP_DENYLIST_DEFAULT,
  resolveOscarDenylist,
} from '../src/hyperliquid/oscar-perp/universe.js';
import type { HyperliquidMarketCache } from '../src/hyperliquid/twap/hyperliquid-meta.js';

const ENV_KEYS = ['HL_OSCAR_DENYLIST', 'HL_OSCAR_DENYLIST_EXTRA'] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function mockCache(coins: string[]): HyperliquidMarketCache {
  const perpNames = [...coins];
  const perpCtxByIndex = new Map<number, { dayNtlVlm: string }>();
  const mids = new Map<string, number>();
  for (let i = 0; i < perpNames.length; i++) {
    perpCtxByIndex.set(i, { dayNtlVlm: '500000' });
    mids.set(perpNames[i]!, 100);
  }
  return { perpNames, perpCtxByIndex, mids } as HyperliquidMarketCache;
}

describe('hl-oscar-perp universe', () => {
  afterEach(() => clearEnv());

  it('default denylist excludes BTC and ETH (majors bot)', () => {
    expect(OSCAR_PERP_DENYLIST_DEFAULT).toContain('BTC');
    expect(OSCAR_PERP_DENYLIST_DEFAULT).toContain('ETH');
    const deny = resolveOscarDenylist();
    expect(deny.has('BTC')).toBe(true);
    expect(deny.has('ETH')).toBe(true);
  });

  it('buildOscarUniverse skips denied majors', () => {
    const deny = resolveOscarDenylist();
    const uni = buildOscarUniverse(mockCache(['BTC', 'ETH', 'SOL', 'DOGE']), {
      minDayVolumeUsd: 100_000,
      denylist: deny,
      whitelist: null,
    });
    const coins = uni.map((c) => c.coin);
    expect(coins).not.toContain('BTC');
    expect(coins).not.toContain('ETH');
    expect(coins).toContain('SOL');
    expect(coins).toContain('DOGE');
  });

  it('HL_OSCAR_DENYLIST_EXTRA merges with default', () => {
    process.env.HL_OSCAR_DENYLIST_EXTRA = 'FOO';
    const deny = resolveOscarDenylist();
    expect(deny.has('BTC')).toBe(true);
    expect(deny.has('FOO')).toBe(true);
  });
});
