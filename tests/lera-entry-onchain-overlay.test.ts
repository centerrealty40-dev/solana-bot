import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import {
  resolveLeraEntryOnchainOverlayVerdict,
  type LeraOverlaySellRow,
} from '../src/papertrader/entry-lera-onchain-overlay.js';

describe('lera entry onchain overlay verdict', () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [
      'LERA_ENTRY_ONCHAIN_OVERLAY_ENABLED',
      'LERA_ENTRY_ONCHAIN_OVERLAY_LOOKBACK_SEC',
      'LERA_ENTRY_ONCHAIN_OVERLAY_MIN_SELL_USD',
      'LERA_ENTRY_ONCHAIN_OVERLAY_LARGE_SELL_USD',
      'LERA_ENTRY_ONCHAIN_OVERLAY_WHALE_DUMP_MAX_AGE_SEC',
      'LERA_ENTRY_ONCHAIN_OVERLAY_COORD_SELL_WALLET_MIN',
    ]) {
      envBackup[k] = process.env[k];
    }
    process.env.LERA_ENTRY_ONCHAIN_OVERLAY_ENABLED = '1';
    process.env.LERA_ENTRY_ONCHAIN_OVERLAY_MIN_SELL_USD = '500';
    process.env.LERA_ENTRY_ONCHAIN_OVERLAY_LARGE_SELL_USD = '1500';
    process.env.LERA_ENTRY_ONCHAIN_OVERLAY_WHALE_DUMP_MAX_AGE_SEC = '90';
    process.env.LERA_ENTRY_ONCHAIN_OVERLAY_COORD_SELL_WALLET_MIN = '3';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envBackup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function sell(
    wallet: string,
    amountUsd: number,
    ageSec: number,
    flags: Partial<Pick<LeraOverlaySellRow, 'intelBlock' | 'badTag' | 'clustered' | 'scamMeta'>> = {},
  ): LeraOverlaySellRow {
    return {
      wallet,
      amountUsd,
      ageSec,
      intelBlock: flags.intelBlock ?? false,
      badTag: flags.badTag ?? false,
      clustered: flags.clustered ?? false,
      scamMeta: flags.scamMeta ?? false,
    };
  }

  it('returns BUY when no meaningful recent sells', () => {
    const cfg = loadPaperTraderConfig();
    const r = resolveLeraEntryOnchainOverlayVerdict(cfg, []);
    expect(r.verdict).toBe('BUY');
    expect(r.wouldBlock).toBe(false);
    expect(r.blocked).toBe(false);
    expect(r.reasons).toContain('shadow_allow');
  });

  it('SKIP on large sell from BLOCK_TRADE wallet', () => {
    const cfg = loadPaperTraderConfig();
    const r = resolveLeraEntryOnchainOverlayVerdict(cfg, [
      sell('WalletAbcdefghijklmnopqrstuvwxyz12', 2000, 30, { intelBlock: true }),
    ]);
    expect(r.verdict).toBe('SKIP');
    expect(r.wouldBlock).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.hits[0]?.kind).toBe('BLOCK_TRADE');
  });

  it('WAIT on fresh whale dump without toxic seller tags', () => {
    const cfg = loadPaperTraderConfig();
    const r = resolveLeraEntryOnchainOverlayVerdict(cfg, [
      sell('WalletAbcdefghijklmnopqrstuvwxyz12', 2500, 45),
    ]);
    expect(r.verdict).toBe('WAIT');
    expect(r.wouldBlock).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('whale_dump_active'))).toBe(true);
  });

  it('WAIT on multiple large sells in whale window', () => {
    const cfg = loadPaperTraderConfig();
    const r = resolveLeraEntryOnchainOverlayVerdict(cfg, [
      sell('WalletAbcdefghijklmnopqrstuvwxyz12', 1800, 20),
      sell('WalletBbcdefghijklmnopqrstuvwxyz12', 1600, 40),
    ]);
    expect(r.verdict).toBe('WAIT');
    expect(r.reasons.some((x) => x.startsWith('multiple_large_sells'))).toBe(true);
  });

  it('SKIP on coordinated bad-tag sellers', () => {
    const cfg = loadPaperTraderConfig();
    const r = resolveLeraEntryOnchainOverlayVerdict(cfg, [
      sell('WalletAbcdefghijklmnopqrstuvwxyz12', 800, 10, { badTag: true }),
      sell('WalletBbcdefghijklmnopqrstuvwxyz12', 700, 20, { clustered: true }),
      sell('WalletCbcdefghijklmnopqrstuvwxyz12', 600, 30, { scamMeta: true }),
    ]);
    expect(r.verdict).toBe('SKIP');
    expect(r.reasons.some((x) => x.startsWith('coordinated_bad_sellers'))).toBe(true);
  });

  it('BUY when sells are below large threshold and not coordinated', () => {
    const cfg = loadPaperTraderConfig();
    const r = resolveLeraEntryOnchainOverlayVerdict(cfg, [
      sell('WalletAbcdefghijklmnopqrstuvwxyz12', 600, 120),
      sell('WalletBbcdefghijklmnopqrstuvwxyz12', 550, 100),
    ]);
    expect(r.verdict).toBe('BUY');
    expect(r.largeSellCount).toBe(0);
  });
});
