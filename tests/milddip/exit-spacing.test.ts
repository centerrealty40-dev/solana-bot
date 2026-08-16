import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.879 — two `never_arm_bounce` legs went out 4.1s apart on one bag
 * (33Grh5V then 2HJmyTW). `sellInFlight` had already cleared, so the next mark
 * tick decided again on a price that predated the first sell and a size the
 * chain read had not caught up with; the second leg filled 5.6% lower.
 */
describe('exit spacing after a sell', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('holds further exit decisions on a bag that just sold', () => {
    expect(loop).toContain('cfg.exitMinSpacingMs > 0 &&');
    expect(loop).toContain('pos.lastSellAtMs != null &&');
    expect(loop).toContain('nowMs - pos.lastSellAtMs < cfg.exitMinSpacingMs');
  });

  it('stamps the sell time so the window starts when the size could change', () => {
    expect(loop).toContain('if (after) after.lastSellAtMs = Date.now();');
  });

  it('the guard sits alongside sellInFlight, not instead of it', () => {
    // In-flight dedupe covers the transaction; the window covers the settle.
    expect(loop).toContain('if (!pos || sellInFlight.has(mint)) continue;');
  });

  it('a single-tick spike cannot reach a ladder rung (1.11.880)', () => {
    // 7ZgRjHSn: marks 6.7779e-05, 6.7779e-05, 7.6591e-05 (+13%), 6.956e-05. The
    // spike read gain +8.44%, fired the +8% rung into a fill at the real price
    // and polluted the peak. The Dex confirm threshold now sits under a move
    // that size, so it waits one 2000ms tick instead.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_MARK_JUMP_CONFIRM_PCT: '10'");
    expect(eco).toContain("MILD_DIP_EXIT_MARK_JUMP_CONFIRM_STREAM_PCT: '8'");
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_STEP_PCT: '8'");
  });

  it('defaults to a window several mark cycles wide', () => {
    // Marks run at 2000ms live, so 10s is five readings after the sell.
    const config = readFileSync(resolve('src/milddip/config.ts'), 'utf8');
    expect(config).toContain(
      'exitMinSpacingMs: z.coerce.number().int().min(0).max(600_000).default(10_000)',
    );
    expect(config).toContain("process.env.MILD_DIP_EXIT_MIN_SPACING_MS ?? 10_000");
  });
});

describe('1.11.938 the ladder leaves a runner', () => {
  it('live env carries the fraction and floor that preserve the tail', () => {
    // 750 exits reached +8% MFE and 166 ended red; 343 reached +20% and 107
    // finished below +10%. Two 34% rungs leave ~44% for the sleeve to trail.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_MIN_REMAINDER: '0.1'");
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_STEP_PCT: '8'");
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_SELL_FRACTION: '0.34'");
  });
});

describe('1.11.900 the time cut stops firing at five minutes', () => {
  it('live env gives a red bag fifteen minutes, not five', () => {
    // On 75 dips we and a leader both entered within a minute, we stopped out of
    // 30 at a -19.77% median where they came out around flat having held 15.5
    // minutes. On the bags that worked our exit beat theirs, +9.41% to +3.90%,
    // so the gate stays - it just no longer fires at its old floor.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_NEVER_ARM_TIME_RED_MIN_MS: '900000'");
    expect(eco).toContain("MILD_DIP_EXIT_NEVER_ARM_TIME_RED_PNL_PCT: '15'");
  });
});

describe('1.11.901 nothing sits past three hours', () => {
  it('live env caps the hold where the tape turns against waiting', () => {
    // Positions still open at each age, worth then against worth at the end:
    // 30m -2.86 -> -2.06, 60m -2.56 -> -2.84, 120m -3.13 -> -3.00,
    // 180m -4.52 -> -7.36, 240m -3.49 -> -11.78. Cutting at 30m costs -0.207
    // per position on a trimmed replay, so the ceiling goes at three hours.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_NEVER_ARM_MAX_HOLD_MS: '10800000'");
  });

  it('an armed bag is only closed by it while it is not green', () => {
    const gates = readFileSync(resolve('src/milddip/gates.ts'), 'utf8');
    expect(gates).toContain('armed && maxHoldCeil > 0 && heldMs >= maxHoldCeil && gainPct <= 0');
  });
});
