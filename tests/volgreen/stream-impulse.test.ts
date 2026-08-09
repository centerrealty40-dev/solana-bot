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
  'MILD_DIP_LEADER_TAPE_MIN_SAMPLES',
  'MILD_DIP_LEADER_TAPE_MIN_BARS',
  'MILD_DIP_MAX_OPEN_POSITIONS',
];

const saved: Record<string, string | undefined> = {};

/** Multi-minute climb that satisfies leader-tape + first_strong. */
function noteLeaderLikeClimb(mint: string, nowMs: number): void {
  const path = [1.0, 1.01, 1.02, 1.12, 1.11, 1.28];
  for (let i = 0; i < path.length; i++) {
    const t = nowMs - (path.length - i) * 60_000;
    mildDipPriceRing.note(mint, path[i]!, { tsMs: t + 5_000, source: 'stream' });
    mildDipPriceRing.note(mint, path[i]!, { tsMs: t + 45_000, source: 'stream' });
  }
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
    const cfg = loadMildDipConfig();
    expect(cfg.streamImpulseOnly).toBe(true);
    expect(cfg.maxOpenPositions).toBe(10);
    const nowMs = Date.now();
    noteLeaderLikeClimb(MINT, nowMs);
    mildDipHotMints.note(MINT, nowMs, 8);
    mildDipHotMints.markBuyForce(MINT, nowMs);

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
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.candidates[0]!.mint).toBe(MINT);
    expect(r.candidates[0]!.dipSource).toBe('stream');
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
