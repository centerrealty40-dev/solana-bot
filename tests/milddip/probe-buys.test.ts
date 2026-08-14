import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('1.11.827 probe buys on re-entry blocks', () => {
  const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('probes both of the top re-entry blockers', () => {
    expect(src).toContain("blockedBy: 'rebuy_below_exit'");
    expect(src).toContain("blockedBy: 'rebuy_liq_drop'");
    expect(src).toContain('mild_dip_probe_override');
  });

  it('a probe is clamped to the probe size, never the normal clip', () => {
    // 1.11.865 — the green lane caps first, then the probe caps on top, so the
    // probe is still the floor of the two.
    // 1.11.898 — the first-touch cap sits between the lane cap and the probe
    // cap, so the probe is still the floor of them all.
    expect(src).toContain('Math.min(cfg.probeBlockedUsd, familiarityCapped)');
    expect(src).toContain('Math.min(cfg.green.positionUsd, knifeCapped)');
  });

  it('fills are tagged so they never mix into book statistics', () => {
    expect(src).toContain('probe: probeReason');
  });

  it('the hourly budget is enforced before overriding a gate', () => {
    expect(src).toContain('function takeProbeSlot');
    expect(src).toContain('probeStamps.length >= cfg.probeBlockedMaxPerHour');
    // Budget is consumed only when a probe is actually taken.
    expect(src).toContain('&& takeProbeSlot(cfg, nowMs))');
  });

  it('never probes around a block that follows a losing exit (1.11.876)', () => {
    // PrkyDd was cut at -15.13% on never_arm_time_red and the probe bought it
    // back 140s later, 1.06% lower, at pc5m -13.27%: same bag, same fall, two
    // more legs of fees. After a losing exit the block has nothing left to
    // price - we just held that tape and it answered.
    expect(src).toContain('const lastExitWasLoss = last?.pnlPct != null && last.pnlPct < 0');
    expect(src).toContain('if (!lastExitWasLoss && takeProbeSlot(cfg, nowMs))');
    expect(src).toContain('const liqLastExitWasLoss = last?.pnlPct != null && last.pnlPct < 0');
    expect(src).toContain('if (!liqLastExitWasLoss && takeProbeSlot(cfg, nowMs))');
  });

  it('blocking still happens when the budget is spent', () => {
    expect(src).toContain("console.log(\n          `[mild-dip] SKIP rebuy-liq");
    expect(src).toContain('return \'skip\';');
  });

  it('live env risks $12/h at most', () => {
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED: '1'");
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_USD: '2'");
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_MAX_PER_HOUR: '6'");
  });
});

describe('1.11.898 the first position on a coin is sized down', () => {
  const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('recognises a first touch as a mint we have never closed', () => {
    expect(src).toContain("cfg.firstTouchPositionUsd > 0 && !state.lastExitByMint?.[c.mint]");
  });

  it('caps the first touch and still lets a probe cap under it', () => {
    expect(src).toContain('Math.min(cfg.firstTouchPositionUsd, laneCapped)');
    expect(src).toContain('Math.min(cfg.probeBlockedUsd, familiarityCapped)');
  });

  it('live env risks $1 on an unknown coin and uses liq power law when known', () => {
    // First touch carries -0.2050 USD/position against -0.02 to -0.05 for every
    // repeat, and -115.82 of a -164 total.
    expect(eco).toContain("MILD_DIP_FIRST_TOUCH_POSITION_USD: '1'");
    expect(eco).toContain("MILD_DIP_SIZE_LIQ_POWER_COEF: '0.0004168'");
    expect(eco).toContain("MILD_DIP_SIZE_MIN_USD: '1'");
    expect(eco).toContain("MILD_DIP_SIZE_MAX_USD: '30'");
  });
});
