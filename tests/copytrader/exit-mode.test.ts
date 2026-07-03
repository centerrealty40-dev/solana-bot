import { describe, expect, it } from 'vitest';
import { parseCopyTraderExitMode, usesOscarExitPolicy } from '../../src/copytrader/exit-mode.js';
import type { CopyTraderConfig } from '../../src/copytrader/config.js';

const baseCfg = {
  exitMode: 'oscar_half8',
} as CopyTraderConfig;

describe('copy-trader exit mode', () => {
  it('defaults to oscar_half8', () => {
    expect(parseCopyTraderExitMode(undefined)).toBe('oscar_half8');
    expect(parseCopyTraderExitMode('')).toBe('oscar_half8');
  });

  it('parses mirror aliases', () => {
    expect(parseCopyTraderExitMode('mirror')).toBe('mirror');
    expect(parseCopyTraderExitMode('leader_mirror')).toBe('mirror');
  });

  it('usesOscarExitPolicy when oscar_half8', () => {
    expect(usesOscarExitPolicy({ ...baseCfg, exitMode: 'oscar_half8' })).toBe(true);
    expect(usesOscarExitPolicy({ ...baseCfg, exitMode: 'mirror' })).toBe(false);
  });
});
