/**
 * Dual/triple leader entry formulas (OR):
 *   F8 — 8zkg: milder tape, longer run-up (maxG≥8 / runup≥10, ~3m history).
 *   F7 — 7BNaxx: faster tape + ring pc5m≥2.
 *   F_early — short history mid-impulse race (minSpan ~60s) so we are not
 *             stuck waiting 180s while leaders already buy.
 */
import {
  defaultLeaderTapeGates,
  detectLeaderTape,
  type LeaderTapeGates,
  type LeaderTapeVerdict,
} from './leader-tape.js';

export type LeaderFormulaId = 'F8_8zkg' | 'F7_7BNaxx' | 'F_early';

export type DualLeaderTapeVerdict = LeaderTapeVerdict & {
  formula: LeaderFormulaId | null;
};

function numEnv(env: NodeJS.ProcessEnv, k: string, d: number): number {
  const v = Number(env[k]?.trim());
  return Number.isFinite(v) ? v : d;
}

function envOn(env: NodeJS.ProcessEnv, key: string, defaultOn = true): boolean {
  const raw = (env[key] ?? (defaultOn ? '1' : '0')).trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/** 8zkg-style: maxG≥8 / runup≥10 over ~25m (current defaults). */
export function f8LeaderTapeGates(
  env: NodeJS.ProcessEnv = process.env,
): LeaderTapeGates {
  const base = defaultLeaderTapeGates(env);
  return {
    ...base,
    maxGMinPc: numEnv(env, 'VOL_GREEN_F8_MAX_G_PC', base.maxGMinPc),
    runupMinPc: numEnv(env, 'VOL_GREEN_F8_RUNUP_PC', base.runupMinPc),
    runupMs: Math.max(
      5 * 60_000,
      Math.floor(numEnv(env, 'VOL_GREEN_F8_RUNUP_MS', base.runupMs)),
    ),
    minBars: Math.max(3, Math.floor(numEnv(env, 'VOL_GREEN_F8_MIN_BARS', base.minBars))),
    minSamples: Math.max(
      4,
      Math.floor(numEnv(env, 'VOL_GREEN_F8_MIN_SAMPLES', base.minSamples)),
    ),
    minSpanMs: Math.max(
      60_000,
      Math.floor(numEnv(env, 'VOL_GREEN_F8_MIN_SPAN_MS', base.minSpanMs)),
    ),
    maxGMaxPc: numEnv(env, 'VOL_GREEN_F8_MAX_G_MAX_PC', base.maxGMaxPc),
    runupMaxPc: numEnv(env, 'VOL_GREEN_F8_RUNUP_MAX_PC', base.runupMaxPc),
  };
}

/**
 * 7BNaxx-style: faster leader (median hold ~10m).
 * Softer maxG/runup floors, shorter run-up window; requires ring pc5m≥2 (F7 Dex).
 */
export function f7LeaderTapeGates(
  env: NodeJS.ProcessEnv = process.env,
): LeaderTapeGates {
  const base = defaultLeaderTapeGates(env);
  return {
    ...base,
    maxGMinPc: numEnv(env, 'VOL_GREEN_F7_MAX_G_PC', 5),
    runupMinPc: numEnv(env, 'VOL_GREEN_F7_RUNUP_PC', 6),
    runupMs: Math.max(
      5 * 60_000,
      Math.floor(numEnv(env, 'VOL_GREEN_F7_RUNUP_MS', 15 * 60_000)),
    ),
    minBars: Math.max(3, Math.floor(numEnv(env, 'VOL_GREEN_F7_MIN_BARS', 3))),
    minSamples: Math.max(4, Math.floor(numEnv(env, 'VOL_GREEN_F7_MIN_SAMPLES', 6))),
    minSpanMs: Math.max(
      60_000,
      Math.floor(numEnv(env, 'VOL_GREEN_F7_MIN_SPAN_MS', 120_000)),
    ),
    maxGMaxPc: numEnv(env, 'VOL_GREEN_F7_MAX_G_MAX_PC', 50),
    runupMaxPc: numEnv(env, 'VOL_GREEN_F7_RUNUP_MAX_PC', 100),
  };
}

/** Early race tape: ~60s span, 2 bars — compete on forming impulse. */
export function fEarlyLeaderTapeGates(
  env: NodeJS.ProcessEnv = process.env,
): LeaderTapeGates {
  const base = defaultLeaderTapeGates(env);
  return {
    ...base,
    maxGMinPc: numEnv(env, 'VOL_GREEN_FEARLY_MAX_G_PC', 8),
    runupMinPc: numEnv(env, 'VOL_GREEN_FEARLY_RUNUP_PC', 4),
    runupMs: Math.max(
      60_000,
      Math.floor(numEnv(env, 'VOL_GREEN_FEARLY_RUNUP_MS', 5 * 60_000)),
    ),
    minBars: Math.max(2, Math.floor(numEnv(env, 'VOL_GREEN_FEARLY_MIN_BARS', 2))),
    minSamples: Math.max(4, Math.floor(numEnv(env, 'VOL_GREEN_FEARLY_MIN_SAMPLES', 4))),
    minSpanMs: Math.max(
      30_000,
      Math.floor(numEnv(env, 'VOL_GREEN_FEARLY_MIN_SPAN_MS', 60_000)),
    ),
    maxGMaxPc: numEnv(env, 'VOL_GREEN_FEARLY_MAX_G_MAX_PC', 40),
    runupMaxPc: numEnv(env, 'VOL_GREEN_FEARLY_RUNUP_MAX_PC', 80),
  };
}

export function f7MinPc5m(env: NodeJS.ProcessEnv = process.env): number {
  return numEnv(env, 'VOL_GREEN_F7_MIN_PC5M_PC', 2);
}

export function dualLeaderFormulasEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return envOn(env, 'VOL_GREEN_DUAL_LEADER_FORMULAS') || envOn(env, 'MILD_DIP_DUAL_LEADER_FORMULAS');
}

export function earlyTapeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envOn(env, 'VOL_GREEN_EARLY_TAPE', true);
}

/**
 * Pass if F8 OR F_early OR F7 matches.
 * Order: F8 (strict) → F_early (race) → F7 (fast + pc5m≥2).
 */
export function detectDualLeaderTape(
  samples: Array<{ tsMs: number; priceUsd: number }>,
  opts?: {
    env?: NodeJS.ProcessEnv;
    nowMs?: number;
    /** Ring / Dex 5m price change % — required ≥2 for F7 (Dex F7). */
    ringPc5mPct?: number | null;
  },
): DualLeaderTapeVerdict {
  const env = opts?.env ?? process.env;
  const nowMs = opts?.nowMs ?? Date.now();
  const pc5m = opts?.ringPc5mPct;

  if (!dualLeaderFormulasEnabled(env)) {
    const v = detectLeaderTape(samples, f8LeaderTapeGates(env), nowMs);
    return { ...v, formula: v.pass ? 'F8_8zkg' : null };
  }

  const f8 = detectLeaderTape(samples, f8LeaderTapeGates(env), nowMs);
  if (f8.pass) {
    return { ...f8, formula: 'F8_8zkg' };
  }

  if (earlyTapeEnabled(env)) {
    const fe = detectLeaderTape(samples, fEarlyLeaderTapeGates(env), nowMs);
    if (fe.pass) {
      return { ...fe, formula: 'F_early' };
    }
  }

  const f7 = detectLeaderTape(samples, f7LeaderTapeGates(env), nowMs);
  const pcMin = f7MinPc5m(env);
  const pcOk = pc5m != null && Number.isFinite(pc5m) && pc5m >= pcMin;
  if (f7.pass && pcOk) {
    return { ...f7, formula: 'F7_7BNaxx' };
  }

  const feGates = earlyTapeEnabled(env);
  const feTry = feGates
    ? detectLeaderTape(samples, fEarlyLeaderTapeGates(env), nowMs)
    : null;
  const reasons = [
    ...f8.reasons.map((r) => `F8:${r}`),
    ...(feTry && !feTry.pass ? feTry.reasons.map((r) => `F_early:${r}`) : []),
    ...(f7.pass && !pcOk
      ? [
          `F7:need_pc5m=${pc5m == null || !Number.isFinite(pc5m) ? 'null' : pc5m.toFixed(1)}<${pcMin}`,
        ]
      : f7.reasons.map((r) => `F7:${r}`)),
  ];
  return {
    pass: false,
    formula: null,
    reasons: reasons.length ? reasons : ['dual_leader_tape_fail'],
    stats: f7.stats ?? feTry?.stats ?? f8.stats,
  };
}
