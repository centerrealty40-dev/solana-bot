import { describe, expect, it } from 'vitest';
import { computeEvmPulseOpenPnl, type TimelineEvent } from '../scripts-tmp/dashboard-server.js';

const entryPx = 0.352066629998303;
const totalInvestedUsd = 10;

describe('computeEvmPulseOpenPnl', () => {
  it('full position: total PnL % matches price change', () => {
    const livePx = entryPx * 0.91;
    const r = computeEvmPulseOpenPnl({
      totalInvestedUsd: 10,
      entryPx,
      livePx,
      remainingFraction: 1,
      timeline: [],
    });
    expect(r).not.toBeNull();
    expect(r!.pnlPct).toBeCloseTo(-9, 5);
    expect(r!.pnlUsd).toBeCloseTo(-0.9, 5);
    expect(r!.pricePnlPct).toBeCloseTo(-9, 5);
  });

  it('SKYAI-like: $10 invested, 31% left, −30% price → ~−9% total (not −30%)', () => {
    const livePx = entryPx * 0.7;
    const remainingFraction = 0.31;
    const timeline: TimelineEvent[] = [
      {
        ts: 2,
        kind: 'partial_sell',
        label: 'tp',
        mcUsd: null,
        spotPxUsd: null,
        sizePct: null,
        pnlPct: null,
        pnlUsd: null,
        reason: 'tp',
        remainingFraction: 0.31,
        amountUsd: 6.93,
      },
    ];
    const r = computeEvmPulseOpenPnl({
      totalInvestedUsd,
      entryPx,
      livePx,
      remainingFraction,
      timeline,
    });
    expect(r).not.toBeNull();
    expect(r!.pricePnlPct).toBeCloseTo(-30, 5);
    expect(r!.pnlUsd).toBeCloseTo(-0.9, 4);
    expect(r!.pnlPct).toBeCloseTo(-9, 4);
    expect(r!.pnlPct).not.toBeCloseTo(-30, 0);
  });

  it('uses amountUsd proceeds when journal provides them', () => {
    const timeline: TimelineEvent[] = [
      {
        ts: 1,
        kind: 'partial_sell',
        label: 'tp',
        mcUsd: null,
        spotPxUsd: null,
        sizePct: 0.5,
        pnlPct: 10,
        pnlUsd: null,
        reason: 'tp',
        remainingFraction: 0.5,
        amountUsd: 5.5,
      },
    ];
    const r = computeEvmPulseOpenPnl({
      totalInvestedUsd: 10,
      entryPx: 1,
      livePx: 0.9,
      remainingFraction: 0.5,
      timeline,
    });
    expect(r!.realizedProceedsUsd).toBeCloseTo(5.5, 5);
    expect(r!.currentValueUsd).toBeCloseTo(4.5, 5);
    expect(r!.pnlUsd).toBeCloseTo(0, 5);
    expect(r!.pnlPct).toBeCloseTo(0, 5);
  });

  it('prod fixture partials: remaining 76% with price −30% is not −30% total', () => {
    const timeline: TimelineEvent[] = [
      {
        ts: 1,
        kind: 'partial_sell',
        label: 'tp',
        mcUsd: null,
        spotPxUsd: null,
        sizePct: 0.05,
        pnlPct: 4.6,
        pnlUsd: null,
        reason: 'tp',
        remainingFraction: 0.95,
        amountUsd: null,
      },
      {
        ts: 2,
        kind: 'partial_sell',
        label: 'trail',
        mcUsd: null,
        spotPxUsd: null,
        sizePct: 0.2,
        pnlPct: -16.3,
        pnlUsd: null,
        reason: 'trail',
        remainingFraction: 0.76,
        amountUsd: null,
      },
    ];
    const r = computeEvmPulseOpenPnl({
      totalInvestedUsd: 10,
      entryPx,
      livePx: entryPx * 0.7,
      remainingFraction: 0.76,
      timeline,
    });
    expect(r!.pricePnlPct).toBeCloseTo(-30, 5);
    expect(r!.pnlPct).toBeCloseTo(-25.67, 1);
    expect(r!.pnlPct).not.toBeCloseTo(-30, 0);
  });
});
