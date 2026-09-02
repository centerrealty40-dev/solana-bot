import { describe, expect, it } from 'vitest';
import {
  knifeStabilizeBypassesTurnDump,
  knifeStabilizeDeepEntryGates,
  knifeStabilizeMaxPc1hPct,
} from '../../src/milddip/knife-stabilize.js';

describe('deep knife entry helpers', () => {
  it('preserves existing entry gates when disabled', () => {
    expect(
      knifeStabilizeDeepEntryGates({
        deepEntryEnabled: false,
        entryMinDipPct: -25,
        entryMaxDipPct: -4,
        knifeMinDipPct: -60,
        knifeMaxDipPct: -20,
      }),
    ).toEqual({ minDipPct: -25, maxDipPct: -4 });
    expect(
      knifeStabilizeMaxPc1hPct({
        deepEntryEnabled: false,
        knifeMaxPc1hPct: 0,
        entryOwnMaxPc1hPct: 50,
      }),
    ).toBe(50);
    expect(
      knifeStabilizeBypassesTurnDump({ deepEntryEnabled: false, dipSource: 'knife_stabilize' }),
    ).toBe(false);
  });

  it('widens the entry band and disables the hourly cap when configured', () => {
    expect(
      knifeStabilizeDeepEntryGates({
        deepEntryEnabled: true,
        entryMinDipPct: -25,
        entryMaxDipPct: -4,
        knifeMinDipPct: -60,
        knifeMaxDipPct: -20,
      }),
    ).toEqual({ minDipPct: -60, maxDipPct: -4 });
    expect(
      knifeStabilizeMaxPc1hPct({
        deepEntryEnabled: true,
        knifeMaxPc1hPct: 0,
        entryOwnMaxPc1hPct: 50,
      }),
    ).toBe(0);
    expect(
      knifeStabilizeBypassesTurnDump({ deepEntryEnabled: true, dipSource: 'knife_stabilize' }),
    ).toBe(true);
  });

  it('inherits the hourly cap for a negative configured value', () => {
    expect(
      knifeStabilizeMaxPc1hPct({
        deepEntryEnabled: true,
        knifeMaxPc1hPct: -1,
        entryOwnMaxPc1hPct: 50,
      }),
    ).toBe(50);
    expect(
      knifeStabilizeBypassesTurnDump({ deepEntryEnabled: true, dipSource: 'turn_dump_knife' }),
    ).toBe(false);
  });
});
