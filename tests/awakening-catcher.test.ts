import { describe, expect, it } from 'vitest';
import { loadAwakeningConfig } from '../src/scripts/awakening/awakening-config.js';
import { extractMintCandidatesFromLogs } from '../src/scripts/awakening/awakening-mint-from-logs.js';
import { evaluateAwakeningSignal } from '../src/scripts/awakening/awakening-signal.js';
import type { AwakeningDexMarket } from '../src/scripts/awakening/awakening-types.js';
import { MintActivityTracker } from '../src/scripts/awakening/awakening-activity.js';
import { formatAwakeningSignalTelegramHtml } from '../src/scripts/awakening/awakening-telegram.js';
import type { AwakeningCandidate } from '../src/scripts/awakening/awakening-types.js';

const FEBU = '4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump';

function market(partial: Partial<AwakeningDexMarket>): AwakeningDexMarket {
  return {
    mint: FEBU,
    priceUsd: 0.002,
    marketCapUsd: 500_000,
    liquidityUsd: 40_000,
    volume5mUsd: 8_000,
    volume1hUsd: 30_000,
    volume6hUsd: 40_000,
    volume24hUsd: 80_000,
    buys5m: 30,
    sells5m: 10,
    priceChangeM5: 8,
    priceChangeH1: 12,
    priceChangeH6: 15,
    priceChangeH24: 20,
    pairAddress: 'pair',
    dexId: 'pumpswap',
    poolAgeMin: 5_000,
    fetchedAtMs: Date.now(),
    ...partial,
  };
}

describe('awakening-signal', () => {
  const cfg = loadAwakeningConfig({
    AWAKENING_VOL5M_MIN_USD: '5000',
    AWAKENING_MIN_VOL1H_USD: '20000',
    AWAKENING_MAX_VOL24H_USD: '250000',
    AWAKENING_MIN_POOL_AGE_HOURS: '48',
    AWAKENING_VOL_VELOCITY_MIN: '0.1',
    AWAKENING_MIN_VOL1H_TO_VOL6H_RATIO: '0.35',
    AWAKENING_MAX_VOL1H_PER_MCAP: '2.0',
    AWAKENING_MIN_MCAP_USD: '300000',
    AWAKENING_MIN_LIQ_USD: '20000',
    AWAKENING_MIN_BUY_RATIO: '0.45',
  });

  it('passes dormant awakening shape (aged, rising, organic)', () => {
    const r = evaluateAwakeningSignal(cfg, market({}));
    expect(r.pass).toBe(true);
    expect(r.metrics.vol1hPerMcap).toBeCloseTo(0.06, 3);
    expect(r.metrics.poolAgeMin).toBe(5_000);
  });

  it('blocks a fresh coin (< 48h) — no new pump.fun launches', () => {
    const r = evaluateAwakeningSignal(cfg, market({ poolAgeMin: 120 }));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('pool_age<'))).toBe(true);
  });

  it('blocks an already-hot / one-shot pump (huge 24h vol) — DEXBULL shape', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ volume24hUsd: 2_300_000, volume1hUsd: 120_000, volume6hUsd: 900_000 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol24h>'))).toBe(true);
  });

  it('blocks a fading pump (vol1h tiny vs vol6h)', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ volume1hUsd: 22_000, volume6hUsd: 200_000, volume24hUsd: 240_000 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol1h/vol6h<'))).toBe(true);
  });

  it('blocks a multi-hour downhill / falling knife', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ priceChangeH24: -55, priceChangeH6: -30, priceChangeH1: -18, priceChangeM5: -4 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('price_h6<') || x.startsWith('price_h1<'))).toBe(true);
  });

  it('blocks wash/cluster turnover (vol1h/mcap too high)', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ marketCapUsd: 60_000, volume1hUsd: 200_000, volume24hUsd: 240_000, volume6hUsd: 230_000 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol1h/mcap>'))).toBe(true);
  });

  it('blocks when vol5m below threshold', () => {
    const r = evaluateAwakeningSignal(cfg, market({ volume5mUsd: 2_000 }));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol5m<'))).toBe(true);
  });

  it('blocks sell-heavy flow', () => {
    const r = evaluateAwakeningSignal(cfg, market({ buys5m: 5, sells5m: 20 }));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('buy_ratio<'))).toBe(true);
  });
});

describe('awakening-mint-from-logs', () => {
  it('extracts pump mint from buy log line', () => {
    const mints = extractMintCandidatesFromLogs([
      `Program log: Instruction: Buy`,
      `Program data: ${FEBU}`,
    ]);
    expect(mints).toContain(FEBU);
  });
});

describe('awakening-activity', () => {
  it('tracks hot mints in rolling window', () => {
    const t = new MintActivityTracker(300_000);
    const now = 1_000_000;
    t.record(FEBU, now - 60_000);
    t.record(FEBU, now - 30_000);
    expect(t.count5m(FEBU, now)).toBe(2);
    expect(t.hotMints(2, now).map((x) => x.mint)).toContain(FEBU);
  });
});

describe('awakening-telegram', () => {
  const shadowCfg = loadAwakeningConfig({ AWAKENING_MODE: 'shadow', AWAKENING_LEG_USD: '10' });
  const liveCfg = loadAwakeningConfig({ AWAKENING_MODE: 'live', AWAKENING_LEG_USD: '10' });
  const candidate: AwakeningCandidate = { mint: FEBU, source: 'stream_pulse', streamSigCount5m: 3 };
  const mkt = market({});

  it('shadow message explains no live buy + LERA may still purchase', () => {
    const html = formatAwakeningSignalTelegramHtml(shadowCfg, candidate, mkt, evaluateAwakeningSignal(shadowCfg, mkt));
    expect(html).toContain('Awakening shadow');
    expect(html).toContain(FEBU);
    expect(html).toContain('shadow');
    expect(html).toContain('не выполняется');
    expect(html).toContain('live-lera');
    expect(html).toContain('ничего не блокирует');
  });

  it('live message mentions queue intent', () => {
    const html = formatAwakeningSignalTelegramHtml(liveCfg, candidate, mkt, evaluateAwakeningSignal(liveCfg, mkt));
    expect(html).toContain('Awakening live');
    expect(html).toContain('очередь');
    expect(html).toContain('dormant_awakening');
  });
});
