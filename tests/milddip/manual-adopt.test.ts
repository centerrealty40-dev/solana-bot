import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MildDipConfig } from '../../src/milddip/config.js';
import { adoptManualHoldings } from '../../src/milddip/manual-adopt.js';
import { isMirrorFirstClipPending } from '../../src/milddip/loop.js';
import type { MildDipState } from '../../src/milddip/state.js';

const mint = 'ManualAdoptMint111111111111111111111111111111';
const row = {
  pubkey: 'Ata11111111111111111111111111111111111111111',
  mint,
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  amountRaw: '1000000',
  lamports: 1,
  decimals: 6,
  uiAmount: 1,
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'manual-adopt-'));
  const cfg = {
    executionMode: 'live',
    walletSecret: 'secret',
    walletPubkeyExpected: 'Owner11111111111111111111111111111111111111111',
    rpcUrl: 'http://example.invalid',
    statePath: join(dir, 'state.json'),
    tradesPath: join(dir, 'trades.jsonl'),
    journalPath: join(dir, 'journal.jsonl'),
    leaderMirror: {
      manualAdoptEnabled: true,
      manualAdoptMinUsd: 20,
      manualAdoptArmPct: 3,
      manualAdoptTrailPct: 8,
    },
  } as MildDipConfig;
  const state = {
    open: {},
    cooldownUntilMs: {},
    mirrorTradingCashUsd: 100,
  } as MildDipState;
  return { cfg, state };
}

describe('manual holding adoption', () => {
  it('adopts an unknown holding with position, lot, cash, and journal state', async () => {
    const { cfg, state } = setup();
    const result = await adoptManualHoldings({
      cfg,
      state,
      nowMs: 1234,
      deps: {
        list: async () => [row],
        quote: async () => ({ ok: true, usd: 40 }),
        signer: () => ({ publicKey: { toBase58: () => cfg.walletPubkeyExpected! } }),
      },
    });
    expect(result).toEqual({ candidates: 1, adopted: 1, skipped: 0 });
    expect(state.open[mint]).toMatchObject({
      manualAdopted: true,
      sizeUsd: 40,
      tokenRaw: row.amountRaw,
      entryPriceUsd: 40,
      mirrorExitArmPct: 3,
      mirrorExitTrailPct: 8,
    });
    expect(state.mirrorTradingCashUsd).toBe(60);
    expect(state.recentEntryMsByMint?.[mint]).toEqual([1234]);
    expect(state.mirrorTradeLots?.[mint]?.costUsd).toBe(40);
    expect(readFileSync(cfg.journalPath, 'utf8')).toContain('mild_dip_manual_adopt');
    expect(readFileSync(cfg.tradesPath, 'utf8')).toContain('mild_dip_manual_adopt');
  });

  it('is idempotent and skips the position on a later pass', async () => {
    const { cfg, state } = setup();
    const deps = {
      list: async () => [row],
      quote: async () => ({ ok: true, usd: 40 }),
      signer: () => ({ publicKey: { toBase58: () => cfg.walletPubkeyExpected! } }),
    };
    await adoptManualHoldings({ cfg, state, nowMs: 1234, deps });
    const result = await adoptManualHoldings({ cfg, state, nowMs: 2234, deps });
    expect(result).toEqual({ candidates: 1, adopted: 0, skipped: 1 });
    expect(state.mirrorTradingCashUsd).toBe(60);
    expect(state.recentEntryMsByMint?.[mint]).toEqual([1234]);
  });

  it.each([
    ['open_position', (state: MildDipState, at: number) => {
      state.open[mint] = { mint, symbol: 'manual', entryPriceUsd: 1, sizeUsd: 40, openedAtMs: at };
    }],
    ['recent_entry', (state: MildDipState, at: number) => {
      state.recentEntryMsByMint = { [mint]: [at] };
    }],
    ['last_exit', (state: MildDipState) => {
      state.lastExitByMint = { [mint]: { priceUsd: 1, atMs: 1 } };
    }],
    ['trade_lot', (state: MildDipState) => {
      state.mirrorTradeLots = { [mint]: { mint, costUsd: 1, totalCostUsd: 1, proceedsUsd: 0, openedAtMs: 1 } };
    }],
    ['cooldown', (state: MildDipState, at: number) => {
      state.cooldownUntilMs = { [mint]: at + 1_000 };
    }],
    ['active_observation', (state: MildDipState, at: number) => {
      state.leaderMirrorWatches = {
        watch: {
          hit: { mint, lastSeenAtMs: at - 1, fillPriceUsd: 1, sizeUsd: 40 } as never,
          hitKey: 'watch',
          startedAtMs: at - 10,
          expiresAtMs: at + 10_000,
          metricSource: 'seed',
        },
      };
    }],
  ])('skips known mint: %s', async (reason, markKnown) => {
    const { cfg, state } = setup();
    const nowMs = 1234;
    markKnown(state, nowMs);
    const result = await adoptManualHoldings({
      cfg,
      state,
      nowMs,
      deps: {
        list: async () => [row],
        quote: async () => ({ ok: true, usd: 40 }),
        signer: () => ({ publicKey: { toBase58: () => cfg.walletPubkeyExpected! } }),
      },
    });
    expect(result.adopted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(readFileSync(cfg.journalPath, 'utf8')).toContain(`"reason":"${reason}"`);
  });

  it('never leaves a manual position waiting for a second clip leg', () => {
    const base = {
      mint,
      symbol: 'manual',
      entryPriceUsd: 1,
      sizeUsd: 40,
      tokenRaw: '1000000000',
      openedAtMs: 1,
      entryPc5mPct: null,
      buySignature: null,
      lane: 'leader_mirror' as const,
      mirrorFirstClipLegsFilled: 1,
    };
    expect(isMirrorFirstClipPending(base, 2)).toBe(true);
    expect(isMirrorFirstClipPending({ ...base, manualAdopted: true }, 2)).toBe(false);
  });
});
