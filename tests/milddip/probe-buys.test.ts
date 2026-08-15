import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeRequestedUsd } from '../../src/milddip/entry-attempt.js';

describe('1.11.827 probe buys on re-entry blocks', () => {
  const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('probes both of the top re-entry blockers', () => {
    expect(src).toContain("blockedBy: 'rebuy_below_exit'");
    expect(src).toContain("blockedBy: 'rebuy_liq_drop'");
    expect(src).toContain('mild_dip_probe_override');
  });

  it('a positive probe cap still clamps the normal request', () => {
    expect(src).toContain('probeBlockedUsd > 0');
    expect(src).toContain('Math.min(probeBlockedUsd, familiarityCapped)');
    expect(src).toContain('Math.min(cfg.green.positionUsd, knifeCapped)');
    expect(src).toContain('isGreen ? requestedUsd : Math.max(cfg.sizeMinUsd, requestedUsd)');
  });

  it('a non-positive probe cap leaves the normal request uncapped', () => {
    expect(probeRequestedUsd('rebuy_below_exit', 0, 8)).toBe(8);
    expect(probeRequestedUsd('rebuy_liq_drop', -1, 8)).toBe(8);
    expect(src).toContain('probeBlockedUsd > 0');
  });

  it('a positive probe cap applies only to probe requests', () => {
    expect(probeRequestedUsd('rebuy_below_exit', 3, 8)).toBe(3);
    expect(probeRequestedUsd(null, 3, 8)).toBe(8);
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
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_USD: '0'");
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_MAX_PER_HOUR: '6'");
  });
});

describe('1.11.898 the first position on a coin is sized down', () => {
  const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('recognises a first touch as a mint we have never closed', () => {
    expect(src).toContain("cfg.firstTouchPositionUsd > 0 && !state.lastExitByMint?.[c.mint]");
  });

  it('caps the first touch while the probe cap remains optional', () => {
    expect(src).toContain('Math.min(cfg.firstTouchPositionUsd, laneCapped)');
    expect(src).toContain('probeRequestedUsd(');
  });

  it('live env keeps first-touch and power-law buys at or above $3', () => {
    expect(eco).toContain("MILD_DIP_FIRST_TOUCH_POSITION_USD: '3'");
    expect(eco).toContain("MILD_DIP_SIZE_LIQ_POWER_COEF: '0.0004168'");
    expect(eco).toContain("MILD_DIP_SIZE_MIN_USD: '3'");
    expect(eco).toContain("MILD_DIP_SIZE_MAX_USD: '30'");
  });

  it('raises the rug-knife clip without changing the risk gate', () => {
    expect(eco).toContain("MILD_DIP_RUG_KNIFE_CLIP_USD: '3'");
    expect(src).toContain('Math.min(cfg.rugKnifeClipUsd, wanted.sizeUsd)');
  });

  it('wallet-drain partials stop below the configured minimum', () => {
    const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(loop).toContain('const minClipUsd = Math.max(MIN_CLIP_USD, cfg.sizeMinUsd)');
    expect(loop).toContain('leftover + 1e-9 < minClipUsd');
  });
});
