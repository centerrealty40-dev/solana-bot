import { describe, expect, it } from 'vitest';
import { closedRowDisplayPnlPct } from '../scripts-tmp/dashboard-server.js';

/** NEST 2026-06-26: partial TP then trail dump; journal net negative, last px above avg entry. */
const nestLikeClose = {
  mint: '68Nq68CrtLVpyvK5Un7UADiNczaGf39hBbj3diRsYj6D',
  symbol: 'NEST',
  exitReason: 'TP',
  totalInvestedUsd: 1800,
  netPnlUsd: -64.38718075852421,
  pnlPct: -3.5770655976957895,
  effective_entry_price: 0.0055010592255966256,
  effective_exit_price: 0.006472530147470991,
  theoretical_entry_price: 0.005437,
  theoretical_exit_price: 0.0065181572482084504,
  partialSells: [{ reason: 'TP_LADDER' }, { reason: 'TP_LADDER' }, { reason: 'TRAIL_STEP' }],
} as const;

describe('closedRowDisplayPnlPct — net vs fill-ratio', () => {
  it('uses netPnlUsd / invested for partial-unwind closes (NEST regression)', () => {
    const pnlUsd = nestLikeClose.netPnlUsd;
    const pct = closedRowDisplayPnlPct(nestLikeClose, pnlUsd);
    expect(pct).toBeCloseTo(-3.577, 2);
    expect(pct).toBeLessThan(0);
    // Old bug: exit/entry fill ratio was ~+17–19% while net was negative.
    const fillRatioPct =
      (nestLikeClose.effective_exit_price / nestLikeClose.effective_entry_price - 1) * 100;
    expect(fillRatioPct).toBeGreaterThan(15);
    expect(pct).not.toBeCloseTo(fillRatioPct, 0);
  });

  it('falls back to entry/exit fill ratio when net and journal pct missing', () => {
    const row = {
      totalInvestedUsd: 100,
      entryPriceUsd: 1,
      exitPriceUsd: 1.2,
    };
    const pct = closedRowDisplayPnlPct(row, NaN);
    expect(pct).toBeCloseTo(20, 5);
  });
});
