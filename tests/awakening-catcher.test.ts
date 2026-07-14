import { describe, expect, it } from 'vitest';
import { loadAwakeningConfig } from '../src/scripts/awakening/awakening-config.js';
import { extractMintCandidatesFromLogs } from '../src/scripts/awakening/awakening-mint-from-logs.js';
import { evaluateAwakeningSignal, awakeningEvalCooldownMs, isAwakeningNearMiss } from '../src/scripts/awakening/awakening-signal.js';
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
    volume1hUsd: 9_500,
    volume6hUsd: 12_000,
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
    AWAKENING_VOL5M_SPIKE_MIN_MULT: '8',
    AWAKENING_VOL5M_SPIKE_VS_1H_MIN_MULT: '4',
    AWAKENING_MAX_VOL24H_USD: '250000',
    AWAKENING_MIN_POOL_AGE_HOURS: '48',
    AWAKENING_MAX_VOL1H_PER_MCAP: '2.0',
    AWAKENING_MIN_MCAP_USD: '300000',
    AWAKENING_MIN_LIQ_USD: '20000',
    AWAKENING_MIN_BUY_RATIO: '0.45',
  });

  it('passes fresh vol5m spike on quiet prior (early awakening)', () => {
    const r = evaluateAwakeningSignal(cfg, market({}));
    expect(r.pass).toBe(true);
    expect(r.metrics.vol5mSpikeVs6hMult).toBeGreaterThan(8);
    expect(r.metrics.vol5mSpikeVs1hMult).toBeGreaterThan(4);
    expect(r.metrics.priorVol1hUsd).toBe(1_500);
  });

  it('passes when vol1h is still small — no vol1h accumulation gate', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ volume5mUsd: 6_000, volume1hUsd: 6_500, volume6hUsd: 8_000, volume24hUsd: 60_000 }),
    );
    expect(r.pass).toBe(true);
    expect(r.metrics.vol1hUsd).toBe(6_500);
  });

  it('blocks mid-rally continuation (2vvw3 late-entry shape)', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({
        volume5mUsd: 5_712,
        volume1hUsd: 30_831,
        volume6hUsd: 74_069,
        volume24hUsd: 251_534,
        marketCapUsd: 862_247,
        liquidityUsd: 78_590,
        priceChangeH24: -10,
        priceChangeH6: 5,
        priceChangeH1: 8,
        priceChangeM5: 3,
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol5m_spike_6h<'))).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('vol5m_spike_1h<'))).toBe(true);
  });

  it('blocks uniform large-cap flow (J8PS shape)', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({
        volume5mUsd: 5_919,
        volume1hUsd: 15_882,
        volume6hUsd: 80_805,
        volume24hUsd: 567_197,
        marketCapUsd: 16_729_399,
        liquidityUsd: 659_158,
        priceChangeH24: 2,
        priceChangeH6: 1,
        priceChangeH1: 0,
        priceChangeM5: 2,
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol5m_spike_6h<'))).toBe(true);
  });

  it('blocks a fresh coin (< 6h) — no brand-new pump.fun launches', () => {
    const sixHourCfg = loadAwakeningConfig({ AWAKENING_MIN_POOL_AGE_HOURS: '6' });
    const r = evaluateAwakeningSignal(sixHourCfg, market({ poolAgeMin: 120 }));
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('pool_age<'))).toBe(true);
    const ok = evaluateAwakeningSignal(sixHourCfg, market({ poolAgeMin: 400 }));
    expect(ok.reasons.some((x) => x.startsWith('pool_age<'))).toBe(false);
  });

  it('blocks an already-hot / one-shot pump (huge 24h vol) — DEXBULL shape', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ volume24hUsd: 2_300_000, volume1hUsd: 120_000, volume6hUsd: 900_000 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol24h>'))).toBe(true);
  });

  it('blocks a fading pump (vol1h tiny vs vol6h, weak 6h spike)', () => {
    const r = evaluateAwakeningSignal(
      cfg,
      market({ volume1hUsd: 22_000, volume6hUsd: 200_000, volume24hUsd: 240_000 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('vol5m_spike_6h<'))).toBe(true);
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

  it('blocks sell-heavy flow without confirmed spike', () => {
    const r = evaluateAwakeningSignal(
      { ...cfg, buyRatioSpikeBypass: false },
      market({ buys5m: 5, sells5m: 20 }),
    );
    expect(r.pass).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('buy_ratio<'))).toBe(true);
  });

  describe('re-awakening pump (FeMbDo Jul-14 12:49 MSK)', () => {
    const shadowCfg = loadAwakeningConfig({
      AWAKENING_VOL5M_MIN_USD: '2500',
      AWAKENING_VOL5M_SPIKE_MIN_MULT: '8',
      AWAKENING_VOL5M_SPIKE_VS_1H_MIN_MULT: '4',
      AWAKENING_MAX_VOL24H_USD: '1500000',
      AWAKENING_MIN_POOL_AGE_HOURS: '12',
      AWAKENING_MAX_VOL1H_PER_MCAP: '4.0',
      AWAKENING_MIN_MCAP_USD: '100000',
      AWAKENING_MIN_LIQ_USD: '12000',
      AWAKENING_MIN_BUY_RATIO: '0.38',
      AWAKENING_BUY_RATIO_SPIKE_BYPASS: '1',
      AWAKENING_MIN_PRICE_CHANGE_M5_IGNITION_PCT: '1',
      AWAKENING_MIN_PRICE_CHANGE_M5_PCT: '0',
      AWAKENING_MIN_PRICE_CHANGE_H24_PCT: '-15',
      AWAKENING_MIN_PRICE_CHANGE_H6_PCT: '-12',
      AWAKENING_MIN_PRICE_CHANGE_H1_PCT: '-12',
      AWAKENING_MAX_PRICE_CHANGE_H6_PCT: '120',
    });

    const fembdoIgnition = market({
      mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
      priceUsd: 0.002192,
      marketCapUsd: 2_191_555,
      liquidityUsd: 235_348,
      volume5mUsd: 34_665.51,
      volume1hUsd: 68_161.16,
      volume6hUsd: 254_751.42,
      volume24hUsd: 459_301.82,
      buys5m: 31,
      sells5m: 69,
      priceChangeM5: 5,
      priceChangeH1: 8,
      priceChangeH6: 10,
      priceChangeH24: 5,
      poolAgeMin: 109_600,
    });

    it('passes ignition with sell-heavy vol5m when spike + m5 confirm burst', () => {
      const r = evaluateAwakeningSignal(shadowCfg, fembdoIgnition);
      expect(r.pass).toBe(true);
      expect(r.metrics.vol5mSpikeVs6hMult).toBeGreaterThan(8);
      expect(r.metrics.vol5mSpikeVs1hMult).toBeGreaterThan(4);
      expect(r.metrics.buyRatio).toBeLessThan(0.38);
    });

    it('blocks same shape when buy_ratio bypass disabled', () => {
      const strictCfg = loadAwakeningConfig({
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k.startsWith('AWAKENING_')),
        ),
        AWAKENING_VOL5M_MIN_USD: '2500',
        AWAKENING_VOL5M_SPIKE_MIN_MULT: '8',
        AWAKENING_VOL5M_SPIKE_VS_1H_MIN_MULT: '4',
        AWAKENING_MAX_VOL24H_USD: '1500000',
        AWAKENING_MIN_POOL_AGE_HOURS: '12',
        AWAKENING_MAX_VOL1H_PER_MCAP: '4.0',
        AWAKENING_MIN_MCAP_USD: '100000',
        AWAKENING_MIN_BUY_RATIO: '0.38',
        AWAKENING_BUY_RATIO_SPIKE_BYPASS: '0',
        AWAKENING_MIN_PRICE_CHANGE_M5_PCT: '0',
      });
      const r = evaluateAwakeningSignal(strictCfg, fembdoIgnition);
      expect(r.pass).toBe(false);
      expect(r.reasons.some((x) => x.startsWith('buy_ratio<'))).toBe(true);
    });

    it('blocks post-peak continuation (vol24h + h6 cap)', () => {
      const r = evaluateAwakeningSignal(
        shadowCfg,
        market({
          ...fembdoIgnition,
          volume5mUsd: 295_939,
          volume1hUsd: 1_116_340,
          volume6hUsd: 1_310_291,
          volume24hUsd: 1_513_866,
          priceUsd: 0.004267,
          marketCapUsd: 4_266_241,
          priceChangeH6: 130,
        }),
      );
      expect(r.pass).toBe(false);
      expect(r.reasons.some((x) => x.startsWith('vol24h>'))).toBe(true);
      expect(r.reasons.some((x) => x.startsWith('price_h6>'))).toBe(true);
    });
  });

  it('near-miss cooldown is short for buy_ratio-only reject', () => {
    const cfg = loadAwakeningConfig({
      AWAKENING_CANDIDATE_COOLDOWN_SEC: '900',
      AWAKENING_NEAR_MISS_COOLDOWN_SEC: '90',
      AWAKENING_FAIL_COOLDOWN_SEC: '300',
    });
    const nearMiss = { pass: false, reasons: ['buy_ratio<0.38'], metrics: {} as never };
    expect(isAwakeningNearMiss(nearMiss.reasons)).toBe(true);
    expect(awakeningEvalCooldownMs(cfg, nearMiss)).toBe(90_000);
    const hardFail = { pass: false, reasons: ['vol5m_spike_6h<8'], metrics: {} as never };
    expect(awakeningEvalCooldownMs(cfg, hardFail)).toBe(300_000);
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

describe('awakening-config ws', () => {
  it('falls back from dead QuickNode WS to Alchemy WSS', () => {
    const cfg = loadAwakeningConfig({
      SA_RPC_WS_URL: 'wss://dead.quiknode.pro/key/',
      ALCHEMY_HTTP_URL: 'https://solana-mainnet.g.alchemy.com/v2/testkey',
    });
    expect(cfg.rpcWsUrl).toBe('wss://solana-mainnet.g.alchemy.com/v2/testkey');
  });

  it('prefers AWAKENING_RPC_WS_URL override', () => {
    const cfg = loadAwakeningConfig({
      AWAKENING_RPC_WS_URL: 'wss://custom.example/ws',
      SA_RPC_WS_URL: 'wss://dead.quiknode.pro/key/',
    });
    expect(cfg.rpcWsUrl).toBe('wss://custom.example/ws');
  });
});
