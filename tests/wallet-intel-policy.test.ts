import { describe, expect, it } from 'vitest';
import { classifyWallet } from '../src/intel/wallet-intel/classify-wallet.js';
import { mintDecision } from '../src/intel/wallet-intel/mint-decision.js';

describe('mintDecision', () => {
  it('returns NO_TRADE if any early buyer is BLOCK_TRADE', () => {
    const m = new Map<string, string>([
      ['a', 'BLOCK_TRADE'],
      ['b', 'UNKNOWN'],
    ]);
    expect(mintDecision(['a', 'b'], m, { requireSwapCoverage: false })).toBe('NO_TRADE');
  });

  it('returns ALLOW_SCAN when permissive and no blocks', () => {
    const m = new Map<string, string>([
      ['a', 'UNKNOWN'],
      ['b', 'SMART_TIER_A'],
    ]);
    expect(mintDecision(['a', 'b'], m, { requireSwapCoverage: false })).toBe('ALLOW_SCAN');
  });

  it('returns NEED_MORE_DATA when strict and no buyers', () => {
    expect(mintDecision([], new Map(), { requireSwapCoverage: true })).toBe('NEED_MORE_DATA');
  });

  it('missing decision row treats wallet as not BLOCK', () => {
    const m = new Map<string, string>();
    expect(mintDecision(['x'], m, { requireSwapCoverage: false })).toBe('ALLOW_SCAN');
  });
});

describe('classifyWallet', () => {
  it('BLOCK_TRADE on scam_operator tag', () => {
    const r = classifyWallet(new Set(['scam_operator']), {
      inScamFarmBlockSet: false,
      botPrimarySuppressesSmart: true,
    });
    expect(r.decision).toBe('BLOCK_TRADE');
  });

  it('BLOCK_TRADE on scam farm participant set', () => {
    const r = classifyWallet(new Set(['retail']), {
      inScamFarmBlockSet: true,
      botPrimarySuppressesSmart: true,
    });
    expect(r.decision).toBe('BLOCK_TRADE');
  });

  it('SMART_TIER_A when smart_money present', () => {
    const r = classifyWallet(new Set(['smart_money']), {
      inScamFarmBlockSet: false,
      botPrimarySuppressesSmart: true,
    });
    expect(r.decision).toBe('SMART_TIER_A');
  });

  it('suppress SMART when primary mev_bot with smart_money tag', () => {
    const r = classifyWallet(new Set(['mev_bot', 'smart_money']), {
      inScamFarmBlockSet: false,
      botPrimarySuppressesSmart: true,
    });
    expect(r.decision).toBe('UNKNOWN');
  });
});
