import { describe, expect, it } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import {
  capitalNotionalXUsd,
  capitalRequiredFreeUsd,
  tokenUsdFromBuyQuote,
} from '../src/live/phase5-gates.js';

function partialCfg(over: Partial<LiveOscarConfig>): LiveOscarConfig {
  return over as LiveOscarConfig;
}

describe('Phase 5 capital X / k·X (W8.0-p5)', () => {
  it('uses LIVE_ENTRY_NOTIONAL_USD when set', () => {
    const cfg = partialCfg({ liveEntryNotionalUsd: 120, liveMaxPositionUsd: 99, liveEntryMinFreeMult: 2 });
    expect(capitalNotionalXUsd(cfg, 50)).toBe(120);
    expect(capitalRequiredFreeUsd(cfg, 50)).toBe(240);
  });

  it('falls back to LIVE_MAX_POSITION_USD then paper ticket', () => {
    const cfg = partialCfg({ liveMaxPositionUsd: 80, liveEntryMinFreeMult: 2 });
    expect(capitalNotionalXUsd(cfg, 50)).toBe(80);
    expect(capitalRequiredFreeUsd(cfg, 50)).toBe(160);

    const cfg2 = partialCfg({ liveEntryMinFreeMult: 2 });
    expect(capitalNotionalXUsd(cfg2, 42)).toBe(42);
    expect(capitalRequiredFreeUsd(cfg2, 42)).toBe(84);
  });
});

describe('tokenUsdFromBuyQuote', () => {
  it('derives USD/token from Jupiter-shaped quote', () => {
    const q = {
      inAmount: '1000000000',
      outAmount: '200000000',
    };
    const px = tokenUsdFromBuyQuote(q, 200, 6);
    expect(px).toBeCloseTo(1, 5);
  });

  it('returns null on bad shapes', () => {
    expect(tokenUsdFromBuyQuote({}, 200, 6)).toBeNull();
    expect(tokenUsdFromBuyQuote({ inAmount: 'x', outAmount: '1' }, 200, 6)).toBeNull();
  });
});
