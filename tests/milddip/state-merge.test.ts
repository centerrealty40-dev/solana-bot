import { describe, expect, it } from 'vitest';
import { mergeMildDipOpenForSave, type MildDipOpenPosition } from '../../src/milddip/state.js';

function pos(partial: Partial<MildDipOpenPosition> & { mint: string }): MildDipOpenPosition {
  return {
    symbol: partial.symbol ?? partial.mint.slice(0, 6),
    entryPriceUsd: partial.entryPriceUsd ?? 1,
    sizeUsd: partial.sizeUsd ?? 5,
    tokenRaw: partial.tokenRaw ?? null,
    openedAtMs: partial.openedAtMs ?? 1,
    entryPc5mPct: partial.entryPc5mPct ?? null,
    buySignature: partial.buySignature ?? null,
    peakPriceUsd: partial.peakPriceUsd,
    trailArmed: partial.trailArmed,
    entryVolume5mUsd: partial.entryVolume5mUsd,
    mint: partial.mint,
  };
}

describe('mergeMildDipOpenForSave', () => {
  it('keeps confirmed disk bags a twin writer is missing (89RAit clobber)', () => {
    const disk = {
      kept: pos({ mint: 'kept', tokenRaw: '1000', buySignature: 'sig' }),
    };
    const memory = {
      other: pos({ mint: 'other', tokenRaw: '2000' }),
    };
    const merged = mergeMildDipOpenForSave(memory, disk);
    expect(Object.keys(merged).sort()).toEqual(['kept', 'other']);
    expect(merged.kept?.tokenRaw).toBe('1000');
  });

  it('honors explicit removeMints so sells stay closed', () => {
    const disk = {
      sold: pos({ mint: 'sold', tokenRaw: '1000' }),
    };
    const memory = {};
    const merged = mergeMildDipOpenForSave(memory, disk, ['sold']);
    expect(merged.sold).toBeUndefined();
  });

  it('memory wins when both have the mint', () => {
    const disk = {
      m: pos({ mint: 'm', tokenRaw: '1', peakPriceUsd: 1 }),
    };
    const memory = {
      m: pos({ mint: 'm', tokenRaw: '2', peakPriceUsd: 9 }),
    };
    const merged = mergeMildDipOpenForSave(memory, disk);
    expect(merged.m?.tokenRaw).toBe('2');
    expect(merged.m?.peakPriceUsd).toBe(9);
  });
});
