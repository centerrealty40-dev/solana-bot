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
    // 1.11.947 — these are still nested clip caps, but each production cap is
    // now $3 so a live first-touch/probe path cannot request a sub-$3 buy.
    expect(src).toContain('Math.min(cfg.probeBlockedUsd, familiarityCapped)');
    expect(src).toContain('Math.min(cfg.green.positionUsd, knifeCapped)');
    expect(src).toContain('isGreen ? requestedUsd : Math.max(cfg.sizeMinUsd, requestedUsd)');
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
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_USD: '3'");
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
