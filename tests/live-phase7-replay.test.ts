import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replayLiveStrategyJournal } from '../src/live/replay-strategy-journal.js';
import { serializeClosedTrade, serializeOpenTrade } from '../src/live/strategy-snapshot.js';
import type { ClosedTrade, OpenTrade } from '../src/papertrader/types.js';

/** p7.1 replay requires simulate anchor or `entryLegSignatures` unless `trustGhostPositions`. */
function liveOpenTradeSnapshot(ot: OpenTrade): Record<string, unknown> {
  return { ...serializeOpenTrade(ot), liveAnchorMode: 'simulate' as const };
}

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

describe('replayLiveStrategyJournal (Phase 7)', () => {
  it('sorts by ts then line order; applies close', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p7-'));
    const p = path.join(dir, 'live.jsonl');
    const mintA = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const mintB = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const otA = minimalOpen(mintA, 1);
    const otB = minimalOpen(mintB, 2);
    const lines = [
      JSON.stringify({
        ts: 200,
        strategyId: 'live-oscar',
        channel: 'live',
        kind: 'live_position_open',
        mint: mintB,
        openTrade: liveOpenTradeSnapshot(otB),
      }),
      JSON.stringify({
        ts: 100,
        strategyId: 'live-oscar',
        channel: 'live',
        kind: 'live_position_open',
        mint: mintA,
        openTrade: liveOpenTradeSnapshot(otA),
      }),
      JSON.stringify({
        ts: 150,
        strategyId: 'live-oscar',
        channel: 'live',
        kind: 'live_position_close',
        mint: mintA,
        closedTrade: serializeClosedTrade({
          ...otA,
          exitTs: 150,
          exitMcUsd: 1,
          exitReason: 'TP',
          pnlPct: 1,
          durationMin: 1,
          totalProceedsUsd: 51,
          netPnlUsd: 1,
          grossTotalProceedsUsd: 51,
          grossPnlUsd: 1,
          grossPnlPct: 1,
          costs: {
            dex: 'raydium',
            fee_bps_per_side: 0,
            slip_base_bps_per_side: 0,
            slip_dynamic_bps_entry: 0,
            slip_dynamic_bps_exit: 0,
            network_fee_usd_total: 0,
            gross_pnl_usd: 1,
            fee_cost_usd: 0,
            slippage_cost_usd: 0,
            network_cost_usd: 0,
            net_pnl_usd: 1,
          },
          effective_entry_price: otA.avgEntry,
          effective_exit_price: 1,
          theoretical_entry_price: otA.avgEntryMarket,
          theoretical_exit_price: 1,
        } as ClosedTrade),
      }),
    ];
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf-8');

    const r = replayLiveStrategyJournal({ storePath: p, strategyId: 'live-oscar' });
    expect(r.open.size).toBe(1);
    expect(r.open.has(mintB)).toBe(true);
    expect(r.closed.length).toBe(1);
    expect(r.closed[0]!.mint).toBe(mintA);
  });

  it('sets journalTruncated when LIVE_TRADES_PATH exceeds maxFileBytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p7-maxb-'));
    const p = path.join(dir, 'live.jsonl');
    const mint = 'MintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    const ot = minimalOpen(mint, 1);
    const row = JSON.stringify({
      ts: 1,
      strategyId: 'live-oscar',
      channel: 'live',
      kind: 'live_position_open',
      mint,
      openTrade: liveOpenTradeSnapshot(ot),
    });
    const padding = `${'y'.repeat(9000)}\n`;
    fs.writeFileSync(p, padding + row + '\n', 'utf-8');
    const r = replayLiveStrategyJournal({ storePath: p, strategyId: 'live-oscar', maxFileBytes: 2500 });
    expect(r.journalTruncated).toBe(true);
    expect(r.open.size).toBe(1);
    expect(r.open.has(mint)).toBe(true);
  });

  it('respects LIVE_REPLAY_TAIL_LINES via caller tailLines option', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-p7-tail-'));
    const p = path.join(dir, 'live.jsonl');
    const mint = 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const ot = minimalOpen(mint, 1);
    const row = {
      ts: 1,
      strategyId: 'live-oscar',
      channel: 'live',
      kind: 'live_position_open',
      mint,
      openTrade: liveOpenTradeSnapshot(ot),
    };
    fs.writeFileSync(p, `${JSON.stringify({ noise: 1 })}\n${JSON.stringify(row)}\n`, 'utf-8');
    const r = replayLiveStrategyJournal({ storePath: p, strategyId: 'live-oscar', tailLines: 1 });
    expect(r.open.size).toBe(1);
  });
});
