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
];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.MILD_DIP_RPC_URL = 'https://example.invalid';
  process.env.MILD_DIP_EXECUTION_MODE = 'paper';
  process.env.MILD_DIP_MINT_PRICE_REFRESH = '0';
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
  it('passes first_strong from local samples without calling fetch', async () => {
    const cfg = loadMildDipConfig();
    expect(cfg.streamImpulseOnly).toBe(true);
    const nowMs = Date.now();
    const t0 = nowMs - 90_000;
    mildDipPriceRing.note(MINT, 1.0, { tsMs: t0, source: 'stream' });
    mildDipPriceRing.note(MINT, 1.05, { tsMs: t0 + 30_000, source: 'stream' });
    mildDipPriceRing.note(MINT, 1.05, { tsMs: nowMs - 50_000, source: 'stream' });
    mildDipPriceRing.note(MINT, 1.32, { tsMs: nowMs - 10_000, source: 'stream' });
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
    expect(r.candidates[0]!.entryPath).toBe('green_tape_impulse');
    expect(r.candidates[0]!.dipSource).toBe('stream');
  });

  it('passes intrabar 60s impulse when completed bars are flat', async () => {
    const cfg = loadMildDipConfig();
    const nowMs = Date.now();
    // Same minute ticks: +25% within 60s, but would be flat completed bars without stitch path.
    mildDipPriceRing.note(MINT, 1.0, { tsMs: nowMs - 50_000, source: 'stream' });
    mildDipPriceRing.note(MINT, 1.05, { tsMs: nowMs - 30_000, source: 'stream' });
    mildDipPriceRing.note(MINT, 1.28, { tsMs: nowMs - 5_000, source: 'stream' });
    mildDipHotMints.note(MINT, nowMs, 8);
    mildDipHotMints.markBuyForce(MINT, nowMs);

    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      allowPriceRefresh: false,
    });
    expect(r.candidates.length).toBeGreaterThanOrEqual(1);
    expect(r.candidates[0]!.entryPath).toBe('green_tape_impulse');
    expect(r.candidates[0]!.entryScore).toBeGreaterThanOrEqual(20);
  });

  it('skips when samples insufficient and does not fetch', async () => {
    const cfg = loadMildDipConfig();
    const nowMs = Date.now();
    mildDipHotMints.note(MINT2, nowMs, 4);
    mildDipHotMints.markBuyForce(MINT2, nowMs);
    mildDipPriceRing.note(MINT2, 1.0, { tsMs: nowMs - 1000, source: 'stream' });

    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error('no fetch');
    }) as unknown as typeof fetch;

    const r = await evaluateStreamImpulseCandidates(cfg, {
      nowMs,
      evalMax: 8,
      fetchImpl,
      allowPriceRefresh: false,
    });
    expect(fetchCalls).toBe(0);
    const skip = r.skips.find((s) => s.mint === MINT2);
    expect(skip?.reasons.some((x) => x.startsWith('stream_impulse_need_samples'))).toBe(
      true,
    );
  });
});
