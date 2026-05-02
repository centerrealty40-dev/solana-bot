import { describe, it, expect, beforeEach } from 'vitest';
import {
  gateCircuit,
  recordTransportResult,
  resetQuoteResilienceForTests,
  type QuoteResilience,
} from '../src/papertrader/pricing/jupiter-quote-resilience.js';

const sampleResilience = (): QuoteResilience => ({
  retriesEnabled: false,
  maxAttempts: 1,
  retryBackoffMs: 0,
  circuitEnabled: true,
  circuitWindowMs: 3_600_000,
  circuitSkipRatePct: 10,
  circuitMinAttempts: 10,
  circuitCooldownMs: 60_000,
});

beforeEach(() => {
  resetQuoteResilienceForTests();
});

describe('W7.4.1 jupiter quote circuit', () => {
  it('does not trip below minAttempts', () => {
    const r = sampleResilience();
    for (let i = 0; i < 9; i++) recordTransportResult(false, r);
    expect(gateCircuit(r)).toBeNull();
  });

  it('opens circuit when transport-fail share exceeds threshold', () => {
    const r = sampleResilience();
    for (let i = 0; i < 10; i++) recordTransportResult(false, r);
    const g = gateCircuit(r);
    expect(g?.kind).toBe('skipped');
    if (g?.kind === 'skipped') expect(g.reason).toBe('circuit-open');
  });

  it('does not record when circuit disabled', () => {
    const r: QuoteResilience = { ...sampleResilience(), circuitEnabled: false };
    for (let i = 0; i < 50; i++) recordTransportResult(false, r);
    expect(gateCircuit(r)).toBeNull();
  });
});
