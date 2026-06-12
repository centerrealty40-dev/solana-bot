import { describe, expect, it } from 'vitest';
import { evaluateFollowMcapGate } from '../../src/pumpswap-combo-follow/mcap-gate.js';

const cfg = { minMarketCapUsd: 150_000, maxMarketCapUsd: 3_000_000 };

describe('evaluateFollowMcapGate', () => {
  it('passes when gate off', () => {
    expect(evaluateFollowMcapGate({ minMarketCapUsd: 0, maxMarketCapUsd: 0 }, 30_000).pass).toBe(true);
  });

  it('blocks micro 30k', () => {
    const v = evaluateFollowMcapGate(cfg, 30_000);
    expect(v.pass).toBe(false);
    expect(v.reason).toBe('min_mcap_usd');
  });

  it('passes 200k', () => {
    expect(evaluateFollowMcapGate(cfg, 200_000).pass).toBe(true);
  });

  it('blocks missing mcap when min set', () => {
    expect(evaluateFollowMcapGate(cfg, null).reason).toBe('mcap_missing_or_zero');
  });

  it('blocks above max', () => {
    expect(evaluateFollowMcapGate(cfg, 5_000_000).reason).toBe('max_mcap_usd');
  });
});
