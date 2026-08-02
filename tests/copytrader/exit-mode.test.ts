import { describe, expect, it } from 'vitest';
import {
  mirrorsLeaderSells,
  parseCopyTraderExitMode,
  usesOscarExitPolicy,
  usesTrailingExitPolicy,
} from '../../src/copytrader/exit-mode.js';
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

  it('parses trail_runner aliases', () => {
    expect(parseCopyTraderExitMode('trail_runner')).toBe('trail_runner');
    expect(parseCopyTraderExitMode('trail')).toBe('trail_runner');
    expect(parseCopyTraderExitMode('TRAILING')).toBe('trail_runner');
  });

  it('usesOscarExitPolicy when oscar_half8', () => {
    expect(usesOscarExitPolicy({ ...baseCfg, exitMode: 'oscar_half8' })).toBe(true);
    expect(usesOscarExitPolicy({ ...baseCfg, exitMode: 'mirror' })).toBe(false);
    expect(usesOscarExitPolicy({ ...baseCfg, exitMode: 'trail_runner' })).toBe(false);
  });

  it('trail_runner is the only trailing mode', () => {
    expect(usesTrailingExitPolicy({ ...baseCfg, exitMode: 'trail_runner' })).toBe(true);
    expect(usesTrailingExitPolicy({ ...baseCfg, exitMode: 'mirror' })).toBe(false);
    expect(usesTrailingExitPolicy({ ...baseCfg, exitMode: 'oscar_half8' })).toBe(false);
  });

  it('only mirror mode follows the leader out', () => {
    expect(mirrorsLeaderSells({ ...baseCfg, exitMode: 'mirror' })).toBe(true);
    expect(mirrorsLeaderSells({ ...baseCfg, exitMode: 'trail_runner' })).toBe(false);
    expect(mirrorsLeaderSells({ ...baseCfg, exitMode: 'oscar_half8' })).toBe(false);
  });
});
