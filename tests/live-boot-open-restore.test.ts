import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenTrade } from '../src/papertrader/types.js';
import { restoreWalletOrphanOpensOnBoot } from '../src/live/boot-open-restore.js';
import * as reconcileLive from '../src/live/reconcile-live.js';
import { serializeOpenTrade } from '../src/live/strategy-snapshot.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
  vi.restoreAllMocks();
});

function minimalOpen(mint: string): OpenTrade {
  const ts = Date.now();
  return {
    mint,
    symbol: 'T',
    lane: 'post_migration',
    metricType: 'price',
    dex: 'raydium',
    entryTs: ts,
    entryMcUsd: 1,
    entryMetrics: null,
    peakMcUsd: 1,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [{ ts, price: 1, marketPrice: 1, sizeUsd: 50, reason: 'open' }],
    partialSells: [],
    totalInvestedUsd: 50,
    avgEntry: 1,
    avgEntryMarket: 1,
    remainingFraction: 0.5,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    tokenDecimals: 6,
  };
}

describe('restoreWalletOrphanOpensOnBoot', () => {
  it('full-journal replays wallet SPL mint missing from truncated tail replay', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-orphan-'));
    const journal = path.join(tmpDir, 'live.jsonl');
    const mint = 'MintOrphanAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ot = minimalOpen(mint);
    const openLine = JSON.stringify({
      ts: 100,
      strategyId: 'live-oscar',
      channel: 'live',
      kind: 'live_position_open',
      mint,
      openTrade: { ...serializeOpenTrade(ot), liveAnchorMode: 'simulate' },
    });
    const partialLine = JSON.stringify({
      ts: 200,
      strategyId: 'live-oscar',
      channel: 'live',
      kind: 'live_position_partial_sell',
      mint,
      openTrade: { ...serializeOpenTrade(ot), liveAnchorMode: 'simulate', remainingFraction: 0.5 },
    });
    fs.writeFileSync(journal, `${openLine}\n${partialLine}\n`, 'utf8');

    vi.spyOn(reconcileLive, 'fetchLiveWalletSplBalancesByMint').mockResolvedValue(
      new Map([[mint, 24_000_000_000n]]),
    );

    const liveCfg = {
      strategyId: 'live-oscar',
      strategyEnabled: true,
      executionMode: 'live' as const,
      walletSecret: 'test-secret',
      liveTradesPath: journal,
      liveReplayTrustGhostPositions: false,
      liveReplayMaxFileBytes: 26_214_400,
    };

    const result = await restoreWalletOrphanOpensOnBoot(liveCfg as never, new Map(), {
      journalTruncated: true,
    });

    expect(result.restoredMints).toEqual([mint]);
    expect(result.open.get(mint)?.remainingFraction).toBe(0.5);
  });
});
