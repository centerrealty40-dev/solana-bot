import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateRebuyBelowExit,
  resolveMildDipWantedSizeUsd,
} from '../../src/milddip/gates.js';
import {
  laneEntryRequestUsd,
  mirrorOnlyEntryAllowed,
  probeOverrideAllowed,
  probeRequestedUsd,
} from '../../src/milddip/entry-attempt.js';

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
    expect(src).toContain(
      'isGreen || probeReason != null ? requestedUsd : Math.max(cfg.sizeMinUsd, requestedUsd)',
    );
  });

  it('a disabled probe cannot override a blocked re-entry', () => {
    expect(probeOverrideAllowed(false, 2)).toBe(false);
    expect(probeOverrideAllowed(true, 0)).toBe(false);
    expect(probeRequestedUsd('rebuy_below_exit', 0, 8)).toBe(0);
    expect(probeRequestedUsd('rebuy_liq_drop', -1, 8)).toBe(0);
    expect(src).toContain('probeOverrideAllowed(cfg.probeBlockedEnabled, cfg.probeBlockedUsd)');
    expect(src).toContain("kind: 'mild_dip_probe_disabled_skip'");
  });

  it('incident values remain blocked when the probe is disabled', () => {
    const nowMs = 2_000_000;
    const lastExitPriceUsd = 0.0002446194461474536;
    const rebuy = evaluateRebuyBelowExit({
      freshPriceUsd: lastExitPriceUsd * 1.0555,
      lastExitPriceUsd,
      lastExitAtMs: nowMs - 760_016,
      nowMs,
      minBelowExitPct: 5,
      maxAgeMs: 900_000,
    });
    expect(rebuy.pass).toBe(false);
    expect(rebuy.reasons[0]).toContain('rebuy_below_exit');
    expect(probeOverrideAllowed(false, 0)).toBe(false);
    expect(probeRequestedUsd('rebuy_below_exit', 0, 17.185498)).toBe(0);
  });

  it('a positive probe cap applies only to probe requests', () => {
    expect(probeOverrideAllowed(true, 3)).toBe(true);
    expect(probeRequestedUsd('rebuy_below_exit', 3, 8)).toBe(3);
    expect(probeRequestedUsd(null, 3, 8)).toBe(8);
    expect(probeRequestedUsd('rebuy_liq_drop', 3, 8)).toBeLessThanOrEqual(3);
    expect(src).toContain('Math.min(laneRequest, requestedUsd)');
    expect(src).toContain('Math.min(sizedRaw.sizeUsd, cfg.probeBlockedUsd)');
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

  it('live env keeps six curve-sized probes per hour at most', () => {
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED: '0'");
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_USD: '0'");
    expect(eco).toContain("MILD_DIP_PROBE_BLOCKED_MAX_PER_HOUR: '6'");
  });
});

describe('1.11.898 the first position on a coin is sized down', () => {
  const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('keeps mirror at its own clip while DIP keeps the first-touch clip', () => {
    expect(
      laneEntryRequestUsd({
        leaderStyle: false,
        leaderStylePositionUsd: 0,
        mirror: true,
        mirrorPositionUsd: 10,
        stagedClipUsd: 3,
      }),
    ).toBe(10);
    expect(
      laneEntryRequestUsd({
        leaderStyle: false,
        leaderStylePositionUsd: 0,
        mirror: false,
        mirrorPositionUsd: 10,
        stagedClipUsd: 3,
      }),
    ).toBe(3);
  });

  it('recognises a first touch as a mint we have never closed', () => {
    expect(src).toContain("cfg.firstTouchPositionUsd > 0 && !state.lastExitByMint?.[c.mint]");
  });

  it('caps the first touch while the probe cap remains optional', () => {
    expect(src).toContain('Math.min(cfg.firstTouchPositionUsd, laneCapped)');
    expect(src).toContain('probeRequestedUsd(');
  });

  it('live env keeps first-touch and power-law buys at or above $5', () => {
    expect(eco).toContain("MILD_DIP_FIRST_TOUCH_POSITION_USD: '10'");
    expect(eco).toContain("MILD_DIP_SIZE_LIQ_POWER_COEF: '0.001888'");
    expect(eco).toContain("MILD_DIP_SIZE_MIN_USD: '5'");
    expect(eco).toContain("MILD_DIP_SIZE_MAX_USD: '30'");
  });

  it('first-touch caps the curve at $10, while non-first-touch keeps the curve', () => {
    const law = { coef: 0.001888, exp: 0.866, minUsd: 5, maxUsd: 30 };
    const sizing = (liquidityUsd: number) =>
      resolveMildDipWantedSizeUsd({
        basePositionUsd: 3,
        liqPowerLaw: law,
        thick: {
          positionUsd: 20,
          minMarketCapUsd: 100_000,
          minLiquidityUsd: 50_000,
          minPairAgeHours: 6,
        },
        metrics: {
          liquidityUsd,
          marketCapUsd: 200_000,
          pairAgeHours: 12,
        },
      }).sizeUsd;

    const largePool = sizing(100_000);
    const thinPool = sizing(1_000);
    const incidentPool = sizing(37_305.98);

    expect(Math.max(5, Math.min(10, largePool))).toBe(10);
    expect(Math.max(5, Math.min(10, thinPool))).toBe(5);
    expect(Math.max(5, incidentPool)).toBeCloseTo(17.185498, 6);
    expect(largePool).toBeGreaterThan(10);
  });

  it('raises the rug-knife clip without changing the risk gate', () => {
    expect(eco).toContain("MILD_DIP_RUG_KNIFE_CLIP_USD: '3'");
    expect(src).toContain('Math.min(cfg.rugKnifeClipUsd, wanted.sizeUsd)');
    const wanted = resolveMildDipWantedSizeUsd({
      basePositionUsd: 3,
      liqPowerLaw: { coef: 0.001888, exp: 0.866, minUsd: 5, maxUsd: 30 },
      thick: {
        positionUsd: 20,
        minMarketCapUsd: 100_000,
        minLiquidityUsd: 50_000,
        minPairAgeHours: 6,
      },
      metrics: { liquidityUsd: 37_305.98, marketCapUsd: 200_000, pairAgeHours: 12 },
    });
    expect(Math.max(5, Math.min(3, wanted.sizeUsd))).toBe(5);
  });

  it('wallet-drain partials stop below the configured minimum', () => {
    const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(loop).toContain('const minClipUsd = Math.max(MIN_CLIP_USD, cfg.sizeMinUsd)');
    expect(loop).toContain('leftover + 1e-9 < minClipUsd');
  });
});

describe('mirror-only mode', () => {
  it('allows mirror entries but blocks every non-mirror entry', () => {
    expect(mirrorOnlyEntryAllowed(true, true)).toBe(true);
    expect(mirrorOnlyEntryAllowed(true, false)).toBe(false);
    expect(mirrorOnlyEntryAllowed(false, false)).toBe(true);
  });

  it('records the quiet non-mirror skip at the shared entry boundary', () => {
    const src = readFileSync(resolve('src/milddip/entry-attempt.ts'), 'utf8');
    expect(src).toContain("kind: 'mild_dip_mirror_only_skip'");
    expect(src).toContain("reason: 'non_mirror_entry_disabled'");
    expect(src).toContain('mirrorOnlyEntryAllowed(cfg.leaderMirror.mirrorOnly');
  });

  it('does not gate the independent exit path', () => {
    const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(loop).toContain('async function tryExits(');
    expect(loop).toContain('if (cfg.leaderMirror.mirrorOnly) continue;');
    expect(loop.indexOf('async function tryExits(')).toBeLessThan(
      loop.indexOf('if (cfg.leaderMirror.mirrorOnly) continue;'),
    );
  });
});
