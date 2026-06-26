import { describe, expect, it } from 'vitest';
import {
  closedRowDisplayPnlPct,
  sanitizeWalletDrainPartialCloseForDashboard,
} from '../scripts-tmp/dashboard-server.js';

/** NEST 2026-06-26: partial TP ladder + wallet-drain trail with chain drift on last leg. */
const nestCloseRaw = {
  mint: '68Nq68CrtLVpyvK5Un7UADiNczaGf39hBbj3diRsYj6D',
  symbol: 'NEST',
  exitReason: 'TP',
  totalInvestedUsd: 1800,
  avgEntry: 0.0055010592255966256,
  netPnlUsd: -64.38718075852421,
  pnlPct: -3.5770655976957895,
  effective_entry_price: 0.0055010592255966256,
  effective_exit_price: 0.006472530147470991,
  theoretical_entry_price: 0.005437,
  theoretical_exit_price: 0.0065181572482084504,
  exitContext: { remainingFractionAtClose: 0, closePnlPct: -3.58 },
  partialSells: [
    {
      reason: 'TP_LADDER',
      sellFraction: 0.5,
      proceedsUsd: 1145.089578904804,
      marketPrice: 0.0070402983003168,
      price: 0.00695014102924766,
    },
    {
      reason: 'TP_LADDER',
      sellFraction: 0.5,
      proceedsUsd: 526.3337568016811,
      marketPrice: 0.006506046045044419,
      price: 0.006389183703381751,
    },
    {
      reason: 'TRAIL_STEP',
      sellFraction: 0.2,
      proceedsUsd: 64.1894835349906,
      marketPrice: 0.0065181572482084504,
      price: 0.0038959918191679177,
      slipRealizedPct: 40.2286,
      trailLevelPnlFrac: 0.1998077627592228,
      timelineLabelRu: 'Live Oscar wave B · trail −8.0% от хая (+20.0% PnL) · 20% остатка',
    },
  ],
} as const;

describe('sanitizeWalletDrainPartialCloseForDashboard — NEST wallet-drain MTM', () => {
  it('repairs close net from last partial market MTM flush (~+22%)', () => {
    const repaired = sanitizeWalletDrainPartialCloseForDashboard({ ...nestCloseRaw });
    expect(repaired.__pnlDisplayRepair).toBe('wallet_drain_partial_mtm_flush');
    const net = Number(repaired.netPnlUsd);
    const pct = Number(repaired.pnlPct);
    expect(net).toBeGreaterThan(350);
    expect(pct).toBeGreaterThan(19);
    expect(pct).toBeLessThan(25);
  });
});

describe('closedRowDisplayPnlPct — net matches $ after wallet-drain repair', () => {
  it('uses repaired netPnlUsd / invested for NEST (not fill-ratio nor raw journal -3.6%)', () => {
    const repaired = sanitizeWalletDrainPartialCloseForDashboard({ ...nestCloseRaw });
    const pnlUsd = Number(repaired.netPnlUsd);
    const pct = closedRowDisplayPnlPct(repaired, pnlUsd);
    expect(pct).toBeGreaterThan(19);
    expect(pct).toBeLessThan(25);
    expect(pct).toBeCloseTo((pnlUsd / nestCloseRaw.totalInvestedUsd) * 100, 5);
    const fillRatioPct =
      (Number(repaired.effective_exit_price) / nestCloseRaw.effective_entry_price - 1) * 100;
    expect(fillRatioPct).toBeGreaterThan(15);
    expect(pct).not.toBeCloseTo(nestCloseRaw.pnlPct, 0);
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
