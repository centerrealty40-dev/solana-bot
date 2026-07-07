import { describe, expect, it } from 'vitest';
import { loadPaperTraderConfig } from '../src/papertrader/config.js';
import type { LeraEntryOnchainOverlayResult } from '../src/papertrader/entry-lera-onchain-overlay.js';
import {
  buildLeraOverlayShadowBuyTelegramText,
  shouldNotifyLeraOverlayShadowBuy,
} from '../src/papertrader/lera-entry-onchain-overlay-notify.js';

function overlay(partial: Partial<LeraEntryOnchainOverlayResult>): LeraEntryOnchainOverlayResult {
  return {
    mode: 'shadow',
    verdict: 'SKIP',
    wouldBlock: true,
    blocked: false,
    reasons: ['intel_BLOCK_TRADE:AbCdEfGh'],
    hits: [{ wallet: 'AbCdEfGh1234567890', kind: 'BLOCK_TRADE', amountUsd: 2000, ageSec: 30 }],
    recentSellCount: 2,
    largeSellCount: 1,
    totalSellUsd: 2000,
    lookbackSec: 120,
    ...partial,
  };
}

describe('lera overlay shadow-buy telegram', () => {
  it('shouldNotify only for SKIP/WAIT with wouldBlock', () => {
    expect(shouldNotifyLeraOverlayShadowBuy(overlay({ verdict: 'SKIP' }))).toBe(true);
    expect(shouldNotifyLeraOverlayShadowBuy(overlay({ verdict: 'WAIT' }))).toBe(true);
    expect(shouldNotifyLeraOverlayShadowBuy(overlay({ verdict: 'BUY', wouldBlock: false }))).toBe(false);
    expect(shouldNotifyLeraOverlayShadowBuy(null)).toBe(false);
    expect(
      shouldNotifyLeraOverlayShadowBuy(overlay({ reasons: ['overlay_pg_error'], verdict: 'BUY', wouldBlock: false })),
    ).toBe(false);
  });

  it('builds telegram with buy executed + overlay block reasons', () => {
    const cfg = loadPaperTraderConfig();
    const text = buildLeraOverlayShadowBuyTelegramText({
      d: {
        mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
        symbol: 'TEST',
        lane: 'post',
        source: 'pg',
        ageMin: 42,
        pass: true,
        reasons: [],
        features: { price_usd: 0.34, market_cap_usd: 1_200_000 },
      } as never,
      ot: {
        mint: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
        symbol: 'TEST',
        totalInvestedUsd: 50,
        entryTs: Date.now(),
        legs: [{ marketPrice: 0.34, price: 0.34 }],
      } as never,
      overlay: overlay({}),
      strategyId: 'live-lera',
      escapeHtml: (s) => s,
      mintHrefHtml: (mint) => mint,
      fmtUsd: (v) => `$${v}`,
    });
    expect(text).toContain('lera_overlay_shadow_buy');
    expect(text).toContain('покупка прошла');
    expect(text).toContain('SKIP');
    expect(text).toContain('intel_BLOCK_TRADE');
    expect(text).toContain(cfg.strategyId === 'paper' ? 'paper' : 'live-lera');
  });
});
