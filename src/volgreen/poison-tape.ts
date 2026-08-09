/**
 * Poison window: if a mint printed violent/chaotic tape (nuke candle, absurd
 * run-up, crash), ban entries for a cool-down — even after the spike ages out
 * of the short lookback (Fvav361: rejected at maxG=744%, bought minutes later).
 */
import { buildOhlcv1mFromPriceSamples, type Ohlcv1m } from './triple-green.js';

export type PoisonTapeGates = {
  enabled: boolean;
  /** Ban duration after a poison event. */
  banMs: number;
  /** |1m chg| ≥ this → poison. */
  absBarPc: number;
  /** maxG (or leader_tape maxG) ≥ this → poison. */
  maxGPoisonPc: number;
  /** run-up ≥ this → poison. */
  runupPoisonPc: number;
  lookbackMs: number;
};

export type PoisonVerdict = {
  poisoned: boolean;
  reasons: string[];
  untilMs?: number;
};

type PoisonRow = { untilMs: number; reason: string };

const poisonUntil = new Map<string, PoisonRow>();

function candleChgPct(b: Ohlcv1m): number {
  if (!(b.open > 0)) return 0;
  return (b.close / b.open - 1) * 100;
}

export function defaultPoisonTapeGates(
  env: NodeJS.ProcessEnv = process.env,
): PoisonTapeGates {
  const off = (env.MILD_DIP_POISON_TAPE ?? env.VOL_GREEN_POISON_TAPE ?? '1')
    .trim()
    .toLowerCase();
  const enabled = !(off === '0' || off === 'false' || off === 'no' || off === 'off');
  const num = (k: string, d: number): number => {
    const v = Number(env[k]?.trim());
    return Number.isFinite(v) ? v : d;
  };
  return {
    enabled,
    banMs: Math.max(60_000, Math.floor(num('MILD_DIP_POISON_TAPE_BAN_MS', 45 * 60_000))),
    absBarPc: num('MILD_DIP_POISON_TAPE_ABS_BAR_PC', 40),
    maxGPoisonPc: num('MILD_DIP_POISON_TAPE_MAX_G_PC', 40),
    runupPoisonPc: num('MILD_DIP_POISON_TAPE_RUNUP_PC', 80),
    lookbackMs: Math.max(10 * 60_000, Math.floor(num('MILD_DIP_POISON_TAPE_LOOKBACK_MS', 40 * 60_000))),
  };
}

export function markPoison(
  mint: string,
  reason: string,
  nowMs: number,
  banMs: number,
): void {
  if (!mint) return;
  const until = nowMs + banMs;
  const prev = poisonUntil.get(mint);
  if (prev && prev.untilMs >= until) return;
  poisonUntil.set(mint, { untilMs: until, reason });
}

export function isPoisoned(mint: string, nowMs: number = Date.now()): PoisonVerdict {
  const row = poisonUntil.get(mint);
  if (!row) return { poisoned: false, reasons: [] };
  if (nowMs >= row.untilMs) {
    poisonUntil.delete(mint);
    return { poisoned: false, reasons: [] };
  }
  const leftSec = Math.ceil((row.untilMs - nowMs) / 1000);
  return {
    poisoned: true,
    reasons: [`poison_tape:${row.reason}:left=${leftSec}s`],
    untilMs: row.untilMs,
  };
}

/**
 * Scan local 1m bars; if violence found, mark poison and return hit.
 * Also re-checks active ban.
 */
export function evaluatePoisonTape(
  mint: string,
  samples: Array<{ tsMs: number; priceUsd: number }>,
  gates: PoisonTapeGates,
  nowMs: number = Date.now(),
): PoisonVerdict {
  if (!gates.enabled) return { poisoned: false, reasons: [] };

  const active = isPoisoned(mint, nowMs);
  if (active.poisoned) return active;

  if (samples.length < 2) return { poisoned: false, reasons: [] };

  const bars = buildOhlcv1mFromPriceSamples(samples, {
    lookbackMs: gates.lookbackMs,
    nowMs,
  });
  if (bars.length < 2) return { poisoned: false, reasons: [] };

  let maxG = -Infinity;
  let minBar = Infinity;
  let maxAbs = 0;
  for (const b of bars) {
    const chg = candleChgPct(b);
    maxG = Math.max(maxG, chg);
    minBar = Math.min(minBar, chg);
    maxAbs = Math.max(maxAbs, Math.abs(chg));
  }
  if (!Number.isFinite(maxG)) maxG = 0;
  if (!Number.isFinite(minBar)) minBar = 0;

  const last = bars[bars.length - 1]!;
  let minLow = Infinity;
  for (const b of bars) {
    if (b.low > 0) minLow = Math.min(minLow, b.low);
  }
  const runup =
    minLow > 0 && last.close > 0 ? (last.close / minLow - 1) * 100 : 0;

  if (maxAbs >= gates.absBarPc) {
    const reason = `absBar=${maxAbs.toFixed(1)}>=${gates.absBarPc}`;
    markPoison(mint, reason, nowMs, gates.banMs);
    return {
      poisoned: true,
      reasons: [`poison_tape:${reason}`],
      untilMs: nowMs + gates.banMs,
    };
  }
  if (maxG >= gates.maxGPoisonPc) {
    const reason = `maxG=${maxG.toFixed(1)}>=${gates.maxGPoisonPc}`;
    markPoison(mint, reason, nowMs, gates.banMs);
    return {
      poisoned: true,
      reasons: [`poison_tape:${reason}`],
      untilMs: nowMs + gates.banMs,
    };
  }
  if (runup >= gates.runupPoisonPc) {
    const reason = `runup=${runup.toFixed(1)}>=${gates.runupPoisonPc}`;
    markPoison(mint, reason, nowMs, gates.banMs);
    return {
      poisoned: true,
      reasons: [`poison_tape:${reason}`],
      untilMs: nowMs + gates.banMs,
    };
  }
  return { poisoned: false, reasons: [] };
}

/** When leader-tape rejects for exceeding caps, remember poison. */
export function notePoisonFromLeaderTapeReject(
  mint: string,
  tapeReasons: string[],
  gates: PoisonTapeGates,
  nowMs: number,
): void {
  if (!gates.enabled || !mint) return;
  for (const r of tapeReasons) {
    // leader_tape_maxG=744.1>40  / leader_tape_runup=959.5>80
    const m = /^leader_tape_maxG=([-\d.]+)>([\d.]+)$/.exec(r);
    if (m) {
      markPoison(mint, `tape_maxG=${m[1]}>${m[2]}`, nowMs, gates.banMs);
      return;
    }
    const u = /^leader_tape_runup=([-\d.]+)>([\d.]+)$/.exec(r);
    if (u) {
      markPoison(mint, `tape_runup=${u[1]}>${u[2]}`, nowMs, gates.banMs);
      return;
    }
  }
}

/** Test helper. */
export function __resetPoisonTapeForTests(): void {
  poisonUntil.clear();
}

export function requireLeaderHighlightEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Default OFF — leaders teach patterns; live must not copy their wallets.
  const raw = (
    env.MILD_DIP_REQUIRE_LEADER_HIGHLIGHT ??
    env.VOL_GREEN_REQUIRE_LEADER_HIGHLIGHT ??
    '0'
  )
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
