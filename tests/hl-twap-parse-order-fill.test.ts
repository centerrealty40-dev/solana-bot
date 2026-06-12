import { describe, expect, it } from 'vitest';

import {
  filledBaseFromSziDelta,
  isOpenFillAcceptable,
  parseHlOrderStatus,
  reconcileOrderFill,
} from '../src/hyperliquid/twap/live/parse-order-fill.js';

describe('parseHlOrderStatus', () => {
  it('parses filled IoC response', () => {
    const status = parseHlOrderStatus({
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [{ filled: { totalSz: '1.5', avgPx: '100.25', oid: 1 } }],
        },
      },
    });
    expect(status).toEqual({
      kind: 'filled',
      fill: { filledBase: 1.5, avgPx: 100.25 },
    });
  });

  it('parses order error', () => {
    const status = parseHlOrderStatus({
      status: 'ok',
      response: { data: { statuses: [{ error: 'Insufficient margin' }] } },
    });
    expect(status).toEqual({ kind: 'error', message: 'Insufficient margin' });
  });
});

describe('filledBaseFromSziDelta', () => {
  it('measures long open fill from szi increase', () => {
    expect(filledBaseFromSziDelta(0, 2.5, 'buy', false)).toBe(2.5);
  });

  it('measures reduce-only sell from szi shrink', () => {
    expect(filledBaseFromSziDelta(3, 1.2, 'sell', true)).toBeCloseTo(1.8);
  });
});

describe('reconcileOrderFill', () => {
  it('prefers exchange szi delta over status when both present', () => {
    const r = reconcileOrderFill({
      parsed: { filledBase: 10, avgPx: 50 },
      sziBefore: 0,
      sziAfter: 2,
      side: 'buy',
      reduceOnly: false,
      markPx: 48,
      requestedBase: 10,
    });
    expect(r.sizeBase).toBe(2);
    expect(r.partialFill).toBe(true);
  });

  it('falls back to parsed fill when szi unchanged', () => {
    const r = reconcileOrderFill({
      parsed: { filledBase: 4, avgPx: 90 },
      sziBefore: 1,
      sziAfter: 1,
      side: 'buy',
      reduceOnly: false,
      markPx: 88,
      requestedBase: 5,
    });
    expect(r.sizeBase).toBe(4);
    expect(r.fillPx).toBe(90);
  });
});

describe('isOpenFillAcceptable', () => {
  it('rejects zero fill', () => {
    expect(isOpenFillAcceptable(0, 2450)).toBe(false);
  });

  it('accepts fill ≥85% of requested gross', () => {
    expect(isOpenFillAcceptable(2100, 2450)).toBe(true);
  });

  it('rejects half-slice partial (~50%)', () => {
    expect(isOpenFillAcceptable(1750, 3500)).toBe(false);
  });

  it('rejects tiny partial fill', () => {
    expect(isOpenFillAcceptable(200, 2450)).toBe(false);
  });
});
