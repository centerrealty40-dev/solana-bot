import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadMildDipConfig } from '../../src/milddip/config.js';
import { mildDipHotMints } from '../../src/milddip/hot-mints.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';
import { bootstrapVolGreenEnv } from '../../src/volgreen/bootstrap-env.js';
import { evaluateStreamImpulseCandidates } from '../../src/volgreen/stream-impulse.js';

const MINT = 'EeB76LHyVZPMRvTpLcxJqqfSz4gg9f9XgsUmFybcpump';
const MINT2 = 'BJWHLm1111111111111111111111111111111111111';

const ENV_KEYS = [
  'MILD_DIP_ENTRY_MODE',
  'MILD_DIP_STREAM_IMPULSE_ONLY',
  'MILD_DIP_RPC_URL',
  'HELIUS_RPC_URL',
  'MILD_DIP_EXECUTION_MODE',
  'MILD_DIP_GREEN_TRIPLE_ONLY',
  'MILD_DIP_GREEN_FIRST_STRONG_MIN_PC',
  'MILD_DIP_GREEN_FIRST_STRONG_MAX_PRIOR_PC',
  'MILD_DIP_GREEN_TRIPLE_HUGE_MIN_PC',
  'MILD_DIP_GREEN_TRIPLE_SMALL_MIN_PC',
  'MILD_DIP_GREEN_TRIPLE_SMALL_MAX_PC',
  'MILD_DIP_MINT_PRICE_REFRESH',
  'MILD_DIP_BUY_MINT_RESOLVE_MAX_PER_MIN',
  'MILD_DIP_VOLUME_IMPULSE_ENTRY',
  'MILD_DIP_LEADER_TAPE',
  'MILD_DIP_LEADER_TAPE_MIN_SAMPLES',
  'MILD_DIP_LEADER_TAPE_MIN_BARS',
  'MILD_DIP_LEADER_TAPE_MIN_SPAN_MS',
  'MILD_DIP_LEADER_TAPE_MAX_G_PC',
  'MILD_DIP_LEADER_TAPE_RUNUP_PC',
  'MILD_DIP_LEADER_TAPE_MAX_G_MAX_PC',
  'MILD_DIP_LEADER_TAPE_RUNUP_MAX_PC',
  'MILD_DIP_MAX_OPEN_POSITIONS',
  'VOL_GREEN_LEADER_WATCH',
  'VOL_GREEN_REQUIRE_LEADER_HIGHLIGHT',
  'MILD_DIP_REQUIRE_LEADER_HIGHLIGHT',
  'VOL_GREEN_REQUIRE_LEADER_BOUGHT',
  'MILD_DIP_REQUIRE_LEADER_BOUGHT',
  'VOL_GREEN_ENTRY_MAX_PC5M_PCT',
  'MILD_DIP_ENTRY_MAX_PC5M_PCT',
  'VOL_GREEN_LEADER_FLEX',
  'VOL_GREEN_INTRABAR_FAST',
  'VOL_GREEN_INTRABAR_FAST_MIN_PC',
  'VOL_GREEN_EARLY_TAPE',
  'VOL_GREEN_EARLY_SKIP_REQUIRE_LEADER_BOUGHT',
  'VOL_GREEN_DUAL_LEADER_FORMULAS',
];

const saved: Record<string, string | undefined> = {};

/** Multi-minute climb that satisfies leader-tape + first_strong / intrabar, pc5m≤15. */
function noteLeaderLikeClimb(mint: string, nowMs: number): void {
  // ~12% run-up, ~9% impulse bar — under chase_pc5m=15 cap.
  const prior = [1.0, 1.01, 1.02, 1.03, 1.04];
  for (let i = 0; i < prior.length; i++) {
    const t = nowMs - (prior.length - i + 1) * 60_000;
    mildDipPriceRing.note(mint, prior[i]!, { tsMs: t + 5_000, source: 'stream' });
    mildDipPriceRing.note(mint, prior[i]!, { tsMs: t + 45_000, source: 'stream' });
  }
  mildDipPriceRing.note(mint, 1.04, { tsMs: nowMs - 50_000, source: 'stream' });
  mildDipPriceRing.note(mint, 1.135, { tsMs: nowMs - 5_000, source: 'stream' });
}

/** Same structure but already vertical (~25% / 5m) — must hit chase_pc5m. */
function noteChasedClimb(mint: string, nowMs: number): void {
  const prior = [1.0, 1.05, 1.1, 1.15, 1.18];
  for (let i = 0; i < prior.length; i++) {
    const t = nowMs - (prior.length - i + 1) * 60_000;
    mildDipPriceRing.note(mint, prior[i]!, { tsMs: t + 5_000, source: 'stream' });
    mildDipPriceRing.note(mint, prior[i]!, { tsMs: t + 45_000, source: 'stream' });
  }
  mildDipPriceRing.note(mint, 1.18, { tsMs: nowMs - 50_000, source: 'stream' });
  mildDipPriceRing.note(mint, 1.28, { tsMs: nowMs - 5_000, source: 'stream' });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.MILD_DIP_RPC_URL = 'https://example.invalid';
  process.env.MILD_DIP_EXECUTION_MODE = 'paper';
  process.env.MILD_DIP_MINT_PRICE_REFRESH = '0';
  process.env.MILD_DIP_VOLUME_IMPULSE_ENTRY = '0';
  process.env.VOL_GREEN_LEADER_WATCH = '0';
  process.env.VOL_GREEN_REQUIRE_LEADER_HIGHLIGHT = '0';
  process.env.MILD_DIP_REQUIRE_LEADER_HIGHLIGHT = '0';
  process.env.VOL_GREEN_REQUIRE_LEADER_BOUGHT = '0';
  process.env.MILD_DIP_REQUIRE_LEADER_BOUGHT = '0';
  process.env.VOL_GREEN_ENTRY_MAX_PC5M_PCT = '15';
  process.env.MILD_DIP_ENTRY_MAX_PC5M_PCT = '15';
  process.env.VOL_GREEN_LEADER_FLEX = '1';
  process.env.VOL_GREEN_INTRABAR_FAST = '1';
  process.env.VOL_GREEN_INTRABAR_FAST_MIN_PC = '6';
  process.env.VOL_GREEN_EARLY_TAPE = '1';
  process.env.VOL_GREEN_EARLY_SKIP_REQUIRE_LEADER_BOUGHT = '1';
  process.env.VOL_GREEN_DUAL_LEADER_FORMULAS = '1';
  process.env.MILD_DIP_LEADER_TAPE = '1';
  process.env.MILD_DIP_LEADER_TAPE_MIN_SAMPLES = '8';
  process.env.MILD_DIP_LEADER_TAPE_MIN_BARS = '4';
  process.env.MILD_DIP_LEADER_TAPE_MIN_SPAN_MS = '180000';
  process.env.MILD_DIP_LEADER_TAPE_MAX_G_PC = '8';
  process.env.MILD_DIP_LEADER_TAPE_RUNUP_PC = '10';
  process.env.MILD_DIP_LEADER_TAPE_MAX_G_MAX_PC = '40';
  process.env.MILD_DIP_LEADER_TAPE_RUNUP_MAX_PC = '80';
  bootstrapVolGreenEnv(process.env);
});

afterEach(() => {
  mildDipHotMints.clearBuyForce(MINT);
  mildDipHotMints.clearBuyForce(MINT2);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
    delete saved[k];
  }
});

describe('evaluateStreamImpulseCandidates', () => {
  it('passes first_strong with real multi-minute samples (no gecko)', async () => {
    const mint = `LeadClimb${Date.now()}1111111111111111111111`.slice(0, 44);
    const cfg = loadMildDipConfig();
    expect(cfg.streamImpulseOnly).toBe(true);
    expect(cfg.maxOpenPositions).toBe(10);
    const nowMs = Date.now();
    noteLeaderLikeClimb(mint, nowMs);
    mildDipHotMints.note(mint, nowMs, 8);
    mildDipHotMints.markBuyForce(mint, nowMs);
    mildDipHotMints.markLeaderHighlight(mint, nowMs);

    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error('gecko must not be called');
    }) as unknown as typeof fetch;

    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      fetchImpl,
      allowPriceRefresh: false,
    });
    expect(fetchCalls).toBe(0);
    const mine = r.skips.filter((s) => s.mint === mint);
    expect(r.candidates.map((c) => c.mint), `skips=${JSON.stringify(mine)}`).toContain(mint);
    expect(r.candidates[0]!.dipSource).toBe('stream');
    mildDipHotMints.clearBuyForce(mint);
  });

  it('skips entry when leaders never bought — unless early-path exemption', async () => {
    process.env.VOL_GREEN_REQUIRE_LEADER_BOUGHT = '1';
    process.env.MILD_DIP_REQUIRE_LEADER_BOUGHT = '1';
    // Early exemption OFF → allowlist still blocks even tip/intrabar.
    process.env.VOL_GREEN_EARLY_SKIP_REQUIRE_LEADER_BOUGHT = '0';
    const mint = `NoLeader${Date.now()}111111111111111111111111`.slice(0, 44);
    const cfg = loadMildDipConfig();
    const nowMs = Date.now();
    noteLeaderLikeClimb(mint, nowMs);
    mildDipHotMints.note(mint, nowMs, 8);
    mildDipHotMints.markBuyForce(mint, nowMs);
    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      allowPriceRefresh: false,
    });
    expect(r.candidates.find((c) => c.mint === mint)).toBeUndefined();
    const skip = r.skips.find((s) => s.mint === mint);
    expect(skip?.reasons.includes('require_leader_bought')).toBe(true);
    mildDipHotMints.clearBuyForce(mint);
  });

  it('does NOT buy on volume-impulse alone when entry flag is off', async () => {
    const soft = 'SoftTape11111111111111111111111111111111111';
    const cfg = loadMildDipConfig();
    const nowMs = Date.now();
    // Only 2 ticks + fat SOL — old rug path; must not enter.
    mildDipPriceRing.note(soft, 1.0, { tsMs: nowMs - 50_000, source: 'stream' });
    mildDipPriceRing.note(soft, 1.15, { tsMs: nowMs - 5_000, source: 'stream' });
    mildDipHotMints.note(soft, nowMs, 8);
    mildDipHotMints.markBuyForce(soft, nowMs);
    mildDipHotMints.markVolumeImpulse(soft, 3.5, nowMs);

    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      allowPriceRefresh: false,
    });
    expect(r.candidates.find((c) => c.mint === soft)).toBeUndefined();
    const skip = r.skips.find((s) => s.mint === soft);
    expect(
      skip?.reasons.some(
        (x) =>
          x.startsWith('stream_impulse_need_samples') || x.startsWith('leader_tape_'),
      ),
    ).toBe(true);
    mildDipHotMints.clearBuyForce(soft);
  });

  it('skips strongly chased candles (ring pc5m > 15)', async () => {
    const mint = `ChaseTip${Date.now()}111111111111111111111111`.slice(0, 44);
    const cfg = loadMildDipConfig();
    const nowMs = Date.now();
    noteChasedClimb(mint, nowMs);
    mildDipHotMints.note(mint, nowMs, 8);
    mildDipHotMints.markBuyForce(mint, nowMs);
    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      allowPriceRefresh: false,
    });
    expect(r.candidates.find((c) => c.mint === mint)).toBeUndefined();
    const skip = r.skips.find((s) => s.mint === mint);
    expect(skip?.reasons.some((x) => x.startsWith('chase_pc5m='))).toBe(true);
    mildDipHotMints.clearBuyForce(mint);
  });

  it('skips when samples insufficient', async () => {
    const cfg = loadMildDipConfig();
    const nowMs = Date.now();
    mildDipHotMints.note(MINT2, nowMs, 4);
    mildDipHotMints.markBuyForce(MINT2, nowMs);
    mildDipPriceRing.note(MINT2, 1.0, { tsMs: nowMs - 1000, source: 'stream' });

    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      allowPriceRefresh: false,
    });
    const skip = r.skips.find((s) => s.mint === MINT2);
    expect(skip?.reasons.some((x) => x.startsWith('stream_impulse_need_samples'))).toBe(
      true,
    );
  });
});
