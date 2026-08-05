import { afterEach, describe, expect, it } from 'vitest';
import {
  canUseScoutEntryFallback,
  isScoutBypassableGateReason,
  scoutEntrySizeUsd,
} from '../../src/copytrader/entry-scout.js';
import { evaluateCopyEntry } from '../../src/copytrader/evaluate.js';
import { syncEntryPendingSizing } from '../../src/copytrader/entry-probe.js';
import { isPendingBuyDoomedByMcap } from '../../src/copytrader/pending-buy-queue.js';
import { loadCopyTraderConfig } from '../../src/copytrader/config.js';
import type { DexInfo } from '../../src/copytrader/dex-info.js';

const saved: Record<string, string | undefined> = {};

function setEnv(overrides: Record<string, string>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

function cfg(overrides: Record<string, string> = {}) {
  setEnv({
    COPY_TRADER_TARGET_WALLET: '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
    COPY_TRADER_RPC_URL: 'https://rpc.example/solana',
    COPY_TRADER_POSITION_USD: '100',
    COPY_TRADER_MAX_POSITION_USD: '100',
    COPY_TRADER_ENTRY_SCOUT_USD: '30',
    COPY_TRADER_MIN_MCAP_USD: '100000',
    COPY_TRADER_MIN_LIQUIDITY_USD: '0',
    COPY_TRADER_MIN_LEADER_BUY_USD: '0',
    ...overrides,
  });
  return loadCopyTraderConfig();
}

const thinDex: DexInfo = {
  symbol: 'X',
  name: 'X',
  priceUsd: 1,
  marketCap: 20_000,
  liquidityUsd: 5_000,
  volume24h: 10_000,
  volume1h: 1_000,
  pairCreatedAtMs: Date.now() - 3600_000,
  dexId: 'pumpswap',
};

describe('entry scout tier', () => {
  it('classifies selective gate reasons as bypassable', () => {
    expect(isScoutBypassableGateReason('volume_5m_usd=1200<min=10000')).toBe(true);
    expect(isScoutBypassableGateReason('mcap=42000<min=100000')).toBe(true);
    expect(isScoutBypassableGateReason('pair_age_h=0.0<min=0.1')).toBe(false);
    expect(isScoutBypassableGateReason('leader_prior_sessions=0<min=3')).toBe(false);
  });

  it('allows scout only when every reason is bypassable', () => {
    const c = cfg();
    expect(canUseScoutEntryFallback(c, ['volume_5m_usd=500<min=10000'])).toBe(true);
    expect(
      canUseScoutEntryFallback(c, ['volume_5m_usd=500<min=10000', 'mcap=20000<min=100000']),
    ).toBe(true);
    expect(
      canUseScoutEntryFallback(c, ['volume_5m_usd=500<min=10000', 'pair_age_h=0.0<min=0.1']),
    ).toBe(false);
    expect(canUseScoutEntryFallback(cfg({ COPY_TRADER_ENTRY_SCOUT_USD: '0' }), ['mcap=1<min=100000'])).toBe(
      false,
    );
  });

  it('sizes scout at $30 clamped by max position', () => {
    expect(scoutEntrySizeUsd(cfg())).toBe(30);
    expect(scoutEntrySizeUsd(cfg({ COPY_TRADER_MAX_POSITION_USD: '20' }))).toBe(20);
  });

  it('skips mcap floor at eval for scout entries', () => {
    const c = cfg();
    const fail = evaluateCopyEntry(c, {
      mint: 'x',
      leaderPriceUsd: 1,
      leaderBuyUsd: 100,
      currentPriceUsd: 1,
      nowMs: Date.now(),
      dex: thinDex,
    });
    expect(fail.pass).toBe(false);
    expect(fail.reasons.some((r) => r.includes('mcap='))).toBe(true);

    const ok = evaluateCopyEntry(c, {
      mint: 'x',
      leaderPriceUsd: 1,
      leaderBuyUsd: 100,
      currentPriceUsd: 1,
      nowMs: Date.now(),
      entryScout: true,
      dex: thinDex,
    });
    expect(ok.pass).toBe(true);
  });

  it('keeps scout size under syncEntryPendingSizing', () => {
    const c = cfg();
    const pending = {
      kind: 'entry' as const,
      sizeUsd: 30,
      entryTargetUsd: 30,
      entryScout: true,
      leaderBuyUsd: 200,
    };
    syncEntryPendingSizing(c, pending, 250_000);
    expect(pending.sizeUsd).toBe(30);
    expect(pending.entryTargetUsd).toBe(30);
  });

  it('does not doom scout pending by mcap floor', () => {
    expect(isPendingBuyDoomedByMcap({ entryMcapUsd: 20_000, entryScout: true }, 100_000)).toBe(false);
    expect(isPendingBuyDoomedByMcap({ entryMcapUsd: 20_000 }, 100_000)).toBe(true);
  });
});
