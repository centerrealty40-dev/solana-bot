import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateSellCost,
  hydrateTradeLots,
  hydrateTradeLotsFromOpen,
  resetTradeLotsForTests,
  resolveBuyCash,
  resolveSellCash,
  snapshotTradeLots,
  resetTradeCashAttributionForTests,
  resolveAdoptedBuyCash,
  writeUsBuyFill,
  writeUsSellFill,
} from '../../src/milddip/trade-journal.js';
import { accountMirrorCashLeg } from '../../src/milddip/mirror-loss-cap.js';

describe('trade-journal cash math', () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetTradeLotsForTests();
    resetTradeCashAttributionForTests();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('uses unique wallet peeks before quote fallback without transaction metadata', () => {
    const buy = resolveBuyCash({
      usdcBefore: 100,
      usdcAfter: 90.25,
      quoteSpentUsd: 10,
      sizeUsdIntent: 10,
    });
    expect(buy.cashSource).toBe('wallet_delta');
    expect(buy.spentUsd).toBeCloseTo(9.75, 5);
    expect(buy.cashDeltaUsd).toBeCloseTo(-9.75, 5);

    const sell = resolveSellCash({
      usdcBefore: 90.25,
      usdcAfter: 98.1,
      quoteReceivedUsd: 8,
    });
    expect(sell.cashSource).toBe('wallet_delta');
    expect(sell.receivedUsd).toBeCloseTo(7.85, 5);
  });

  it('falls back to quote when balances missing', () => {
    const buy = resolveBuyCash({ quoteSpentUsd: 10, sizeUsdIntent: 12 });
    expect(buy.cashSource).toBe('quote_fallback');
    expect(buy.spentUsd).toBe(10);
    const sell = resolveSellCash({ quoteReceivedUsd: 11 });
    expect(sell.receivedUsd).toBe(11);
    expect(sell.cashSource).toBe('quote_fallback');
  });

  it('uses confirmed transaction USDC delta before balance peeks', () => {
    const txMeta = {
      preTokenBalances: [
        {
          accountIndex: 2,
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          owner: 'UsWallet111',
          uiTokenAmount: { amount: '100000000', decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          owner: 'UsWallet111',
          uiTokenAmount: { amount: '112340000', decimals: 6 },
        },
      ],
    };
    const sell = resolveSellCash({
      wallet: 'UsWallet111',
      txMeta,
      usdcBefore: 100,
      usdcAfter: 200,
      quoteReceivedUsd: 9,
    });
    expect(sell.cashSource).toBe('tx_delta');
    expect(sell.receivedUsd).toBeCloseTo(12.34, 6);
    expect(sell.cashDeltaUsd).toBeCloseTo(12.34, 6);
  });

  it('uses exact adopted buy transaction delta over stale balance intent', () => {
    const txMeta = {
      preTokenBalances: [{
        accountIndex: 2,
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        owner: 'UsWallet111',
        uiTokenAmount: { amount: '100000000', decimals: 6 },
      }],
      postTokenBalances: [{
        accountIndex: 2,
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        owner: 'UsWallet111',
        uiTokenAmount: { amount: '87650000', decimals: 6 },
      }],
    };
    const fill = resolveBuyCash({
      wallet: 'UsWallet111',
      txMeta,
      usdcBefore: 100,
      usdcAfter: 100,
      sizeUsdIntent: 30,
    });
    expect(fill.cashSource).toBe('tx_delta');
    expect(fill.spentUsd).toBeCloseTo(12.35, 6);
    expect(resolveAdoptedBuyCash({
      ...fill,
      quoteSpentUsd: fill.spentUsd,
    }, 30)).toEqual({
      spentUsd: 12.35,
      cashDeltaAppliedUsd: -12.35,
    });
  });

  it('credits an identical positive sell peek pair only once', () => {
    const args = { usdcBefore: 100, usdcAfter: 112.5 };
    const fills = [resolveSellCash(args), resolveSellCash(args), resolveSellCash(args)];
    expect(fills.map((fill) => fill.receivedUsd)).toEqual([12.5, 0, 0]);
    expect(fills.map((fill) => fill.cashSource)).toEqual([
      'wallet_delta',
      'wallet_delta_duplicate',
      'wallet_delta_duplicate',
    ]);
    expect(fills.reduce((sum, fill) => sum + fill.cashDeltaUsd!, 0)).toBeCloseTo(12.5, 6);
  });

  it('protects the symmetric buy peek path from duplicate spending', () => {
    const args = { usdcBefore: 100, usdcAfter: 90, sizeUsdIntent: 10 };
    const fills = [resolveBuyCash(args), resolveBuyCash(args)];
    expect(fills.map((fill) => fill.spentUsd)).toEqual([10, 0]);
    expect(fills.map((fill) => fill.cashSource)).toEqual(['wallet_delta', 'wallet_delta_duplicate']);
    expect(fills.reduce((sum, fill) => sum + fill.cashDeltaUsd!, 0)).toBeCloseTo(-10, 6);
  });

  it('marks stale sell wallet peeks without crediting proceeds', () => {
    const sell = resolveSellCash({
      usdcBefore: 156.77,
      usdcAfter: 123.14,
      quoteReceivedUsd: 8.5,
    });
    expect(sell.cashSource).toBe('wallet_delta_stale');
    expect(sell.receivedUsd).toBe(0);
    expect(sell.cashDeltaUsd).toBeCloseTo(-33.63, 2);
  });

  it('marks stale buy peek without crediting wallet delta as spend', () => {
    const buy = resolveBuyCash({
      usdcBefore: 100,
      usdcAfter: 105,
      sizeUsdIntent: 10,
    });
    expect(buy.cashSource).toBe('wallet_delta_stale');
    expect(buy.spentUsd).toBe(10);
    expect(buy.cashDeltaUsd).toBeCloseTo(5, 5);
  });

  it('books stale and duplicate adopted buys at intent rather than zero', () => {
    const stale = writeUsBuyFill({
      tradesPath: '/dev/null/milddip-trades.jsonl',
      wallet: 'UsWallet111',
      mint: 'MintStaleAdopt',
      ok: true,
      sizeUsdIntent: 10,
      usdcBefore: 100,
      usdcAfter: 105,
      nowMs: 1_000,
    });
    writeUsBuyFill({
      tradesPath: '/dev/null/milddip-trades.jsonl',
      wallet: 'UsWallet111',
      mint: 'MintDuplicateAdopt',
      ok: true,
      sizeUsdIntent: 10,
      usdcBefore: 100,
      usdcAfter: 90,
      nowMs: 1_001,
    });
    const duplicate = writeUsBuyFill({
      tradesPath: '/dev/null/milddip-trades.jsonl',
      wallet: 'UsWallet111',
      mint: 'MintDuplicateAdopt',
      ok: true,
      sizeUsdIntent: 10,
      usdcBefore: 100,
      usdcAfter: 90,
      nowMs: 1_002,
    });
    expect(resolveAdoptedBuyCash(stale, 10)).toEqual({
      spentUsd: 10,
      cashDeltaAppliedUsd: -10,
    });
    expect(resolveAdoptedBuyCash(duplicate, 10)).toEqual({
      spentUsd: 10,
      cashDeltaAppliedUsd: -10,
    });
  });

  it('keeps open persisted lots beyond the seven-day cleanup TTL', () => {
    const old = {
      MintOpenOld: {
        mint: 'MintOpenOld',
        costUsd: 12,
        totalCostUsd: 12,
        proceedsUsd: 0,
        openedAtMs: 1,
      },
      MintClosedOld: {
        mint: 'MintClosedOld',
        costUsd: 12,
        totalCostUsd: 12,
        proceedsUsd: 0,
        openedAtMs: 1,
      },
    };
    expect(hydrateTradeLots(old, 8 * 24 * 60 * 60_000, new Set(['MintOpenOld']))).toBe(1);
    expect(snapshotTradeLots().MintOpenOld.totalCostUsd).toBe(12);
    expect(snapshotTradeLots().MintClosedOld).toBeUndefined();
  });

  it('stale sell peek yields lossy roundtrip instead of quote-inflated win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trades-stale-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintA',
      ok: true,
      signature: 'buySig',
      sizeUsdIntent: 10,
      usdcBefore: 100,
      usdcAfter: 90,
      nowMs: 1_000,
    });
    const { roundtrip } = writeUsSellFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintA',
      ok: true,
      signature: 'sellSig',
      sizeUsdIntent: 10,
      fraction: 1,
      usdcBefore: 90,
      usdcAfter: 88,
      quoteReceivedUsd: 12,
      reason: 'peak_giveback',
      nowMs: 2_000,
    });
    expect(roundtrip).not.toBeNull();
    expect(roundtrip!.cashPnlUsd).toBeCloseTo(-10, 5);
    expect(roundtrip!.sellProceedsUsd).toBe(0);
  });

  it('allocates cost pro-rata on partial sells', () => {
    expect(allocateSellCost({ lotCostUsd: 10, fraction: 0.4 })).toEqual({
      costBasisUsd: 4,
      remainingCostUsd: 6,
    });
    expect(allocateSellCost({ lotCostUsd: 10, fraction: 1 }).remainingCostUsd).toBe(0);
  });

  it('hydrates open bags so restart sells keep cost basis', () => {
    const n = hydrateTradeLotsFromOpen(
      { MintB: { sizeUsd: 10, openedAtMs: 500 } },
      1_000,
    );
    expect(n).toBe(1);
    const dir = mkdtempSync(join(tmpdir(), 'trades-h-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    const { fill } = writeUsSellFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintB',
      ok: true,
      sizeUsdIntent: 10,
      fraction: 1,
      usdcBefore: 50,
      usdcAfter: 56,
      nowMs: 2_000,
      reason: 'hard_stop',
    });
    expect(fill.costBasisUsd).toBeCloseTo(10, 5);
    expect(fill.cashPnlUsd).toBeCloseTo(-4, 5);
  });

  it('restores persisted lots before open-state fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trades-persist-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintPersist',
      ok: true,
      sizeUsdIntent: 10,
      quoteSpentUsd: 12,
      nowMs: 1_000,
    });
    const persisted = snapshotTradeLots();
    resetTradeLotsForTests();
    expect(hydrateTradeLots(persisted, 2_000)).toBe(1);
    expect(hydrateTradeLotsFromOpen({
      MintPersist: { sizeUsd: 99, openedAtMs: 1_000 },
      MintFallback: { sizeUsd: 7, openedAtMs: 1_000 },
    }, 2_000)).toBe(1);
    expect(snapshotTradeLots().MintPersist.totalCostUsd).toBe(12);
    expect(snapshotTradeLots().MintFallback.totalCostUsd).toBe(7);
  });

  it('writes trade_fill + trade_roundtrip with cash PnL (not mark%)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trades-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintA',
      symbol: 'AAA',
      ok: true,
      signature: 'buySig',
      sizeUsdIntent: 10,
      usdcBefore: 100,
      usdcAfter: 90,
      quoteSpentUsd: 10,
      fillPriceUsd: 0.001,
      dipSource: 'stream',
      nowMs: 1_000,
    });
    const { fill, roundtrip } = writeUsSellFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintA',
      symbol: 'AAA',
      ok: true,
      signature: 'sellSig',
      sizeUsdIntent: 10,
      fraction: 1,
      usdcBefore: 90,
      usdcAfter: 97,
      quoteReceivedUsd: 7,
      fillPriceUsd: 0.0007,
      markPnlPct: -30, // mark lie
      reason: 'hard_stop',
      nowMs: 61_000,
    });
    expect(fill.cashPnlUsd).toBeCloseTo(-3, 5); // 7 received − 10 cost
    expect(fill.markPnlPct).toBe(-30);
    expect(fill.cashSource).toBe('wallet_delta');
    expect(roundtrip).not.toBeNull();
    expect(roundtrip!.cashPnlUsd).toBeCloseTo(-3, 5);
    expect(roundtrip!.buyCostUsd).toBeCloseTo(10, 5);
    expect(roundtrip!.sellProceedsUsd).toBeCloseTo(7, 5);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3); // buy fill, sell fill, roundtrip
    const kinds = lines.map((l) => JSON.parse(l).kind);
    expect(kinds).toEqual(['trade_fill', 'trade_fill', 'trade_roundtrip']);
  });

  it('books an adopted landed fill into the trade journal and mirror cash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trades-adopt-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    const fill = writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintAdopted',
      ok: true,
      signature: 'landedSig',
      sizeUsdIntent: 30,
      usdcBefore: 100,
      usdcAfter: 72.5,
      nowMs: 1_000,
      lane: 'fast',
    });
    const state = { mirrorTradingCashUsd: 100 };
    accountMirrorCashLeg(state, fill as unknown as Record<string, unknown>, 'buy');
    expect(fill.cashSource).toBe('wallet_delta');
    expect(fill.cashDeltaUsd).toBe(-27.5);
    expect(state.mirrorTradingCashUsd).toBe(72.5);
    expect(readFileSync(path, 'utf8')).toContain('"signature":"landedSig"');
  });

  it('includes an add buy once in the roundtrip cost basis', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trades-add-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintAdd',
      ok: true,
      signature: 'entrySig',
      sizeUsdIntent: 10,
      quoteSpentUsd: 10,
      fillPriceUsd: 1,
      nowMs: 1_000,
    });
    writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintAdd',
      ok: true,
      signature: 'addSig',
      sizeUsdIntent: 40,
      quoteSpentUsd: 40,
      fillPriceUsd: 0.8,
      dipSource: 'mild_dip_staged_add',
      nowMs: 2_000,
    });
    const { roundtrip } = writeUsSellFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintAdd',
      ok: true,
      signature: 'sellSig',
      sizeUsdIntent: 50,
      fraction: 1,
      quoteReceivedUsd: 55,
      fillPriceUsd: 1.1,
      nowMs: 3_000,
    });
    expect(roundtrip).not.toBeNull();
    expect(roundtrip!.buyCostUsd).toBe(50);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).kind)).toEqual([
      'trade_fill',
      'trade_fill',
      'trade_fill',
      'trade_roundtrip',
    ]);
  });

  it('extends a hydrated initial lot exactly once for an add buy', () => {
    hydrateTradeLotsFromOpen(
      { MintHydrated: { sizeUsd: 10, openedAtMs: 500 } },
      1_000,
    );
    const dir = mkdtempSync(join(tmpdir(), 'trades-hydrated-add-'));
    dirs.push(dir);
    const path = join(dir, 'trades.jsonl');
    writeUsBuyFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintHydrated',
      ok: true,
      signature: 'addSig',
      sizeUsdIntent: 40,
      quoteSpentUsd: 40,
      fillPriceUsd: 0.8,
      dipSource: 'mild_dip_staged_add',
      nowMs: 2_000,
    });
    const { roundtrip } = writeUsSellFill({
      tradesPath: path,
      wallet: 'UsWallet111',
      mint: 'MintHydrated',
      ok: true,
      signature: 'sellSig',
      sizeUsdIntent: 50,
      fraction: 1,
      quoteReceivedUsd: 45,
      nowMs: 3_000,
    });
    expect(roundtrip?.buyCostUsd).toBe(50);
  });
});
