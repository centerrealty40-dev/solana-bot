import { describe, expect, it } from 'vitest';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { globalGate } from '../src/papertrader/filters/global-gate.js';

function cfg(over: Partial<PaperTraderConfig> = {}): PaperTraderConfig {
  return {
    globalMinTokenAgeMin: 0,
    globalMinHolderCount: 1000,
    globalMaxHolderCount: 2999,
    ...over,
  } as unknown as PaperTraderConfig;
}

describe('globalGate holder ceiling', () => {
  it('allows holders inside min..max band', () => {
    expect(globalGate(cfg(), 60, 2000)).toEqual([]);
  });

  it('rejects holders above globalMaxHolderCount', () => {
    expect(globalGate(cfg(), 60, 3500)).toContain('holders>2999');
  });

  it('no ceiling when globalMaxHolderCount is 0', () => {
    expect(globalGate(cfg({ globalMaxHolderCount: 0 }), 60, 50_000)).toEqual([]);
  });
});
