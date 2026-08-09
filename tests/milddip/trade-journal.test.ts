import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateSellCost,
  hydrateTradeLotsFromOpen,
  resetTradeLotsForTests,
  resolveBuyCash,
  resolveSellCash,
  writeUsBuyFill,
  writeUsSellFill,
} from '../../src/milddip/trade-journal.js';

describe('trade-journal cash math', () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetTradeLotsForTests();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('prefers wallet USDC delta over quote for buys/sells', () => {
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
    expect(buy.cashSource).toBe('quote');
    expect(buy.spentUsd).toBe(10);
    const sell = resolveSellCash({ quoteReceivedUsd: 11 });
    expect(sell.receivedUsd).toBe(11);
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
});
