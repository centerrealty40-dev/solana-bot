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
    expect(loop).toContain('after.lastSellAtMs = Date.now();');
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
    // 1.11.918 — there is no rung left for a spike to reach, but the confirm
    // thresholds still protect the peak the trail is measured against.
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_STEP_PCT: '0'");
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

describe('1.11.897 the ladder closes on the first rung', () => {
  it('1.11.918 — the ladder is off, so the floor is what it always was', () => {
    // The 0.6 floor made the first rung a full exit at +8%, which won on median
    // and cost the runners: with 1.11.914 handing the tail to the trail instead
    // of closing, that same floor stops the first rung from firing at all. So
    // the live behaviour was already a pure trail; 1.11.918 makes the config say
    // it, because the mean says the runners are worth more than the median.
    const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_MIN_REMAINDER: '0.6'");
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_STEP_PCT: '0'");
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

describe('1.11.917 an armed bag is not judged on a print that has not moved', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
  const cfg = readFileSync(resolve('src/milddip/config.ts'), 'utf8');
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  it('awaits a fresh Dex read for armed bags whose ring went stale', () => {
    // GPzpoXpD: 44 seconds on one frozen stream print while the coin halved, so
    // the giveback read -1.48% until it read -48.59% in a single step.
    expect(loop).toContain("if (p?.trailArmed !== true) return false;");
    expect(loop).toContain('if (openMarkRingAgeMs(m, nowMs) >= armedBound) return true;');
    expect(loop).toContain('await prefetchDexScreenerPairDetailsMany(armedStale,');
  });

  it('bounds it well below the five minutes the ring allows a cold coin', () => {
    expect(cfg).toContain("markArmedMaxAgeMs: process.env.MILD_DIP_MARK_ARMED_MAX_AGE_MS ?? 10_000");
    expect(eco).toContain("MILD_DIP_MARK_ARMED_MAX_AGE_MS: '10000'");
  });
});

describe('1.11.918 the runners are not sold in rungs', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');

  /**
   * Measured on 4796 of our own mark tapes. Mean realized % per position:
   *
   *                        all paths   MFE>=10%   MFE>=100% (89)
   *   live 8%/50% rem.20       -1.89      13.44           117.98
   *   5%/25% rem.20            -1.94      13.10           113.35
   *   15%/33% unbounded        -3.20      10.80            35.79
   *   trail only, giveback 12   4.18      29.17           444.00
   *   trail only, giveback 20   5.57      33.34           540.61
   *
   * Every laddered variant is negative in the mean; the trail is positive. The
   * ladder buys a better median (-0.50 against -3.35) by selling the runners,
   * and the runners are the whole distribution.
   */
  it('runs a dual trail with the bank off so it cannot take the same rung', () => {
    expect(eco).toContain("MILD_DIP_EXIT_TP_GRID_STEP_PCT: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_MFE_BANK2_PCT: '0'");
    expect(eco).toContain("MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT: '5'");
    expect(eco).toContain("MILD_DIP_EXIT_GIVEBACK_PCT: '15'");
    expect(eco).toContain("MILD_DIP_EXIT_SCALE_OUT_FRACTION: '0.5'");
  });

  it('still floors a faded pop at breakeven rather than at the giveback', () => {
    // A +9% peak fading 20% would land under water without this.
    expect(eco).toContain("MILD_DIP_EXIT_BREAKEVEN_ARM_PCT");
    expect(eco).toContain("MILD_DIP_EXIT_BREAKEVEN_FLOOR_PCT: '0'");
  });
});

describe('1.11.918 the time cut waits for the turn as well', () => {
  const gates = readFileSync(resolve('src/milddip/gates.ts'), 'utf8');

  it('does not cut a red bag on a falling tick', () => {
    // GRehQKv9 was cut by never_arm_time_red at -19.51% on a falling print after
    // 50 minutes. 1.11.916 only covered hard_stop and cliff_dump.
    expect(gates).toContain('if (pcOk && turned) {');
  });

  it('leaves the hold ceiling as the backstop that ignores the turn', () => {
    // Past max hold we cannot prove green, so that exit stays unconditional.
    expect(gates).toContain("reason: 'max_hold_underwater'");
    expect(gates).toContain("reason: 'never_arm_timeout'");
  });
});

describe('1.11.919 the jump quarantine lets go after a few seconds', () => {
  const eng = readFileSync(resolve('src/milddip/exit-engine.ts'), 'utf8');
  const cfg = readFileSync(resolve('src/milddip/config.ts'), 'utf8');

  it('accepts a value that keeps coming back, identical or not', () => {
    // nBxqeJsm: gain 0 / giveback 0 for 31 seconds across five identical Dex
    // reads while the coin fell. The trail fired at -23.88% instead of -20%.
    expect(eng).toContain('const quarantineExpired = quarantineMaxMs > 0 && pendingAgeMs >= quarantineMaxMs;');
    expect(eng).toContain('!quarantineExpired &&');
    expect(cfg).toContain('markJumpConfirmMaxMs: process.env.MILD_DIP_MARK_JUMP_CONFIRM_MAX_MS ?? 8_000');
  });

  it('measures the wait from when the value first appeared', () => {
    // Re-stamping on every refusal would restart the clock and never expire.
    expect(eng).toContain('if (pos.pendingMarkPriceUsd !== decision.markPriceUsd || pos.pendingMarkAtMs == null) {');
  });
});

describe('1.11.920 the trail, the feed and the repeat sell', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('gives the sleeve the same giveback as the full close trail', () => {
    // With the ladder off the sleeve is what trails the bag. AvecKFxn peaked at
    // +21.49% and it cut at -12.58% while GIVEBACK_PCT said 20.
    expect(eco).toContain("MILD_DIP_EXIT_MFE_BANK_SLEEVE_GIVEBACK_PCT: '15'");
    expect(eco).toContain("MILD_DIP_EXIT_GIVEBACK_PCT: '15'");
  });

  it('treats an unchanging feed as stale even when its timestamps are fresh', () => {
    // GPzpoXpD held one stream price from near its peak, so the age check passed
    // and the first moving print was a 46.78% giveback.
    expect(loop).toContain('const unchangedSinceMs = p.markUnchangedSinceMs;');
    expect(loop).toContain('return nowMs - unchangedSinceMs >= armedBound;');
  });

  it('will not sell twice on the same number', () => {
    // Three legs 13s apart, all on the identical mark 1.6827e-04.
    expect(loop).toContain('px === pos.lastSellMarkPriceUsd');
    expect(loop).toContain('after.lastSellMarkPriceUsd = decision.markPriceUsd;');
  });
});

describe('1.11.922 dual trail banks half at −5%, closes at −15%', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const gates = readFileSync(resolve('src/milddip/gates.ts'), 'utf8');

  it('configures partial and full giveback with half scale-out', () => {
    expect(eco).toContain("MILD_DIP_EXIT_PARTIAL_GIVEBACK_PCT: '5'");
    expect(eco).toContain("MILD_DIP_EXIT_GIVEBACK_PCT: '15'");
    expect(eco).toContain("MILD_DIP_EXIT_SCALE_OUT_FRACTION: '0.5'");
  });

  it('sells half on the first giveback hit before the full trail', () => {
    // Classic W9.1 path: partial at −5%, full at −15%, half-first even when
    // mark gaps past the full threshold in one tick.
    expect(gates).toContain("reason: 'peak_giveback_partial'");
    expect(gates).toContain('(partialGivebackHit || fullGivebackHit)');
    expect(gates).toContain("reason: 'peak_giveback'");
  });
});

describe('1.11.921 a stream cliff Dex never saw is not a cliff', () => {
  const eng = readFileSync(resolve('src/milddip/exit-engine.ts'), 'utf8');
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');

  it('cross-checks Dex before deciding on a stream print', () => {
    // 3J8CiL: stream 1.98e-06 (-93%), Dex 3.124e-05 (+2%), cliff_dump fired anyway.
    expect(eng).toContain('dexCrossCheckPx?: number | null;');
    expect(eng).toContain('decisionMark = args.dexCrossCheckPx;');
    expect(loop).toContain('dexCrossCheckPx:');
  });

  it('does not treat quarantine expiry as confirmation when Dex disagrees', () => {
    expect(eng).toContain('markDiscardStreamOutlier: true');
    expect(eng).toContain('ageing out is not confirmation of a stream phantom');
  });
});
