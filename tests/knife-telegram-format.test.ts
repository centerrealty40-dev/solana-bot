import { describe, expect, it } from 'vitest';
import {
  buildKnifeCloseTelegram,
  buildKnifeDumpTelegram,
  buildKnifeEntryTelegram,
  isKnifeShadowPnlSuspicious,
} from '../src/scripts/knife-telegram-format.js';

describe('knife telegram format', () => {
  const dump = {
    preDumpHigh: 0.48,
    dumpLow: 0.34,
    dumpPct: 28.9,
    sellUsd: 1842,
    signature: 'abc123signature',
    source: 'swap_decode',
  };

  it('builds structured dump HTML with GMGN and whale context', () => {
    const text = buildKnifeDumpTelegram({
      mode: 'shadow',
      mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
      dump,
      priceUsd: 0.347,
      maxEntryAfterDumpSec: 50,
      maxBouncePct: 5,
    });
    expect(text).toContain('[REPORT][knife_shadow]');
    expect(text).toContain('WHALE DUMP');
    expect(text).toContain('gmgn.ai');
    expect(text).toContain('$1842');
    expect(text).toContain('swap_decode');
  });

  it('builds entry HTML with delay and bounce', () => {
    const text = buildKnifeEntryTelegram({
      mode: 'shadow',
      mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
      legUsd: 5,
      priceUsd: 0.347,
      dump,
      bouncePct: 1.2,
      entryDelayMs: 2300,
    });
    expect(text).toContain('ВХОД leg1');
    expect(text).toContain('2.3с');
    expect(text).toContain('shadow');
  });

  it('flags suspicious close PnL', () => {
    expect(isKnifeShadowPnlSuspicious(216097, 5, 4_000_000)).toBe(true);
    const text = buildKnifeCloseTelegram({
      mode: 'shadow',
      mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
      reason: 'ladder_complete',
      legs: 1,
      avgEntry: 0.347,
      investedUsd: 5,
      realizedUsd: 216097,
      pnlPct: 4_000_000,
    });
    expect(text).toContain('подозрительный');
    expect(text).toContain('артефакт');
  });
});
