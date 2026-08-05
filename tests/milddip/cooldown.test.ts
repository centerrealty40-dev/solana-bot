import { describe, expect, it } from 'vitest';
import { cooldownMsAfterExit } from '../../src/milddip/cooldown.js';

describe('cooldownMsAfterExit', () => {
  it('uses base cooldown on win', () => {
    const r = cooldownMsAfterExit({
      pnlPct: 6.6,
      mintCooldownMs: 300_000,
      lossCooldownMs: 600_000,
    });
    expect(r).toEqual({ cooldownMs: 300_000, kind: 'base' });
  });

  it('uses loss cooldown on negative pnl', () => {
    const r = cooldownMsAfterExit({
      pnlPct: -8.4,
      mintCooldownMs: 300_000,
      lossCooldownMs: 600_000,
    });
    expect(r).toEqual({ cooldownMs: 600_000, kind: 'loss' });
  });

  it('uses base on flat zero', () => {
    const r = cooldownMsAfterExit({
      pnlPct: 0,
      mintCooldownMs: 300_000,
      lossCooldownMs: 600_000,
    });
    expect(r).toEqual({ cooldownMs: 300_000, kind: 'base' });
  });

  it('falls back to base when loss cooldown disabled', () => {
    const r = cooldownMsAfterExit({
      pnlPct: -3,
      mintCooldownMs: 300_000,
      lossCooldownMs: 0,
    });
    expect(r).toEqual({ cooldownMs: 300_000, kind: 'base' });
  });
});
