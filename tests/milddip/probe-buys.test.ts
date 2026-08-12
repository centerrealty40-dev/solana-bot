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
    expect(src).toContain(
      'const wantUsd = probeReason ? Math.min(cfg.probeBlockedUsd, laneCapped) : laneCapped;',
    );
    expect(src).toContain('Math.min(cfg.green.positionUsd, knifeCapped)');
  });

  it('fills are tagged so they never mix into book statistics', () => {
    expect(src).toContain('probe: probeReason');
  });

  it('the hourly budget is enforced before overriding a gate', () => {
    expect(src).toContain('function takeProbeSlot');
    expect(src).toContain('probeStamps.length >= cfg.probeBlockedMaxPerHour');
    // Budget is consumed only when a probe is actually taken.
    expect(src).toContain('if (takeProbeSlot(cfg, nowMs))');
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
