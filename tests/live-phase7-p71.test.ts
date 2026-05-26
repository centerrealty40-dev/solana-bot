import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateLiveNotionalParity } from '../src/live/notional-parity.js';
import { replayLiveStrategyJournal } from '../src/live/replay-strategy-journal.js';
import { serializeOpenTrade } from '../src/live/strategy-snapshot.js';
import type { OpenTrade } from '../src/papertrader/types.js';

function minimalOpen(mint: string, avg: number): OpenTrade {
  const ts = Date.now();
  return {
    mint,
    symbol: 'T',
    lane: 'post_migration',
    metricType: 'price',
    dex: 'raydium',
    entryTs: ts,
    entryMcUsd: avg,
    entryMetrics: {
      uniqueBuyers: 0,
      uniqueSellers: 0,
      sumBuySol: 0,
      sumSellSol: 0,
      topBuyerShare: 0,
      bcProgress: 0,
    },
    peakMcUsd: avg,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts, price: avg, marketPrice: avg, sizeUsd: 50, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 50,
    avgEntry: avg,
    avgEntryMarket: avg,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    tokenDecimals: 6,
  };
}

describe('W8.0-p7.1 replay anchors', () => {
  it('skips live_position_open without anchors when trustGhostPositions=false', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p71-'));
    const p = path.join(dir, 'live.jsonl');
    const mint = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ot = minimalOpen(mint, 1);
    fs.writeFileSync(
      p,
      JSON.stringify({
        ts: 1,
        strategyId: 'live-oscar',
        channel: 'live',
        kind: 'live_position_open',
        mint,
        openTrade: serializeOpenTrade(ot),
      }) + '\n',
      'utf-8',
    );
    const r = replayLiveStrategyJournal({ storePath: p, strategyId: 'live-oscar', trustGhostPositions: false });
    expect(r.open.size).toBe(0);
  });

  it('restores unanchored rows when trustGhostPositions=true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p71-trust-'));
    const p = path.join(dir, 'live.jsonl');
    const mint = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const ot = minimalOpen(mint, 1);
    fs.writeFileSync(
      p,
      JSON.stringify({
        ts: 1,
        strategyId: 'live-oscar',
        channel: 'live',
        kind: 'live_position_open',
        mint,
        openTrade: serializeOpenTrade(ot),
      }) + '\n',
      'utf-8',
    );
    const r = replayLiveStrategyJournal({ storePath: p, strategyId: 'live-oscar', trustGhostPositions: true });
    expect(r.open.size).toBe(1);
  });
});

describe('evaluateLiveNotionalParity', () => {
  it('flags mismatch when LIVE_ENTRY_NOTIONAL_USD differs from paper size (live)', () => {
    const r = evaluateLiveNotionalParity({
      strict: true,
      strategyEnabled: true,
      executionMode: 'live',
      paperPositionUsd: 100,
      liveMaxPositionUsd: 200,
      liveEntryNotionalUsd: 10,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail.reason).toBe('paper_vs_live_entry_notional_usd');
  });

  it('allows when entry notional matches paper', () => {
    const r = evaluateLiveNotionalParity({
      strict: true,
      strategyEnabled: true,
      executionMode: 'live',
      paperPositionUsd: 100,
      liveMaxPositionUsd: 200,
      liveEntryNotionalUsd: 100,
    });
    expect(r.ok).toBe(true);
  });

  it('skips when executionMode is simulate', () => {
    const r = evaluateLiveNotionalParity({
      strict: true,
      strategyEnabled: true,
      executionMode: 'simulate',
      paperPositionUsd: 100,
      liveEntryNotionalUsd: 10,
    });
    expect(r.ok).toBe(true);
  });
});
