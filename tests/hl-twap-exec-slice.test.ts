import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import { createDryRunClient } from '../src/hyperliquid/twap/live/exchange-dry-run.js';
import {
  aggregateOrderFills,
  executeSlicedMarketOrder,
  splitExecNotional,
} from '../src/hyperliquid/twap/live/exec-slice.js';
import { isOpenFillAcceptable } from '../src/hyperliquid/twap/live/parse-order-fill.js';
import type { HlTwapExchangeClient, MarketOrderParams, OrderFillResult } from '../src/hyperliquid/twap/live/types.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
  delete process.env.HL_TWAP_EXEC_SLICE_USD;
  delete process.env.HL_TWAP_EXEC_SLICE_GAP_MS;
  vi.useRealTimers();
});

describe('exec slice config defaults', () => {
  it('defaults to $200 chunks and 5s gap', () => {
    delete process.env.HL_TWAP_EXEC_SLICE_USD;
    delete process.env.HL_TWAP_EXEC_SLICE_GAP_MS;
    const cfg = loadHlTwapLiveConfig();
    expect(cfg.execSliceUsd).toBe(200);
    expect(cfg.execSliceGapMs).toBe(5000);
  });
});

describe('splitExecNotional', () => {
  it('returns empty for non-positive total', () => {
    expect(splitExecNotional(0, 200)).toEqual([]);
    expect(splitExecNotional(-10, 200)).toEqual([]);
  });

  it('single chunk when total ≤ max', () => {
    expect(splitExecNotional(200, 200)).toEqual([200]);
    expect(splitExecNotional(150, 200)).toEqual([150]);
  });

  it('splits into $200 chunks + remainder', () => {
    expect(splitExecNotional(450, 200)).toEqual([200, 200, 50]);
    expect(splitExecNotional(1000, 200)).toEqual([200, 200, 200, 200, 200]);
    expect(splitExecNotional(1001, 200)).toEqual([200, 200, 200, 200, 200, 1]);
  });

  it('maxChunk 0 returns single full notional', () => {
    expect(splitExecNotional(500, 0)).toEqual([500]);
  });
});

describe('aggregateOrderFills', () => {
  it('VWAP-combines multiple fills', () => {
    const agg = aggregateOrderFills(
      [
        { fillPx: 100, sizeBase: 1, notionalUsd: 100, marginUsd: 20, leverage: 5 },
        { fillPx: 110, sizeBase: 1, notionalUsd: 110, marginUsd: 22, leverage: 5 },
      ],
      210,
      'open',
    );
    expect(agg.notionalUsd).toBeCloseTo(210, 6);
    expect(agg.sizeBase).toBeCloseTo(2, 6);
    expect(agg.fillPx).toBeCloseTo(105, 6);
    expect(agg.marginUsd).toBeCloseTo(42, 6);
    expect(agg.leverage).toBe(5);
    expect(agg.requestedNotionalUsd).toBe(210);
  });
});

describe('exec-sliced dry-run client', () => {
  it('splits large open into multiple exchange orders', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-exec-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';
    process.env.HL_TWAP_EXEC_SLICE_USD = '200';
    process.env.HL_TWAP_EXEC_SLICE_GAP_MS = '0';
    process.env.HL_TWAP_LIVE_LEVERAGE = '5';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();

    const fill = await client.marketOrder({
      coin: 'ETH',
      displaySymbol: 'ETH',
      side: 'buy',
      notionalUsd: 100,
      markPx: 3000,
      reduceOnly: false,
      intent: 'open',
    });

    expect(fill.notionalUsd).toBeCloseTo(500, 0);
    const text = fs.readFileSync(journalPath, 'utf8');
    const orderLines = text.split('\n').filter((l) => l.includes('"kind":"order"'));
    expect(orderLines.length).toBe(3);
  });

  it('single order when gross ≤ exec slice', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-exec-sm-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';
    process.env.HL_TWAP_EXEC_SLICE_USD = '200';
    process.env.HL_TWAP_EXEC_SLICE_GAP_MS = '0';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();

    await client.marketOrder({
      coin: 'SOL',
      displaySymbol: 'SOL',
      side: 'buy',
      notionalUsd: 30,
      markPx: 150,
      reduceOnly: false,
      intent: 'open',
    });

    const text = fs.readFileSync(journalPath, 'utf8');
    const orderLines = text.split('\n').filter((l) => l.includes('"kind":"order"'));
    expect(orderLines.length).toBe(1);
  });

  it('splits reduce-only sizeBase orders', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-exec-red-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';
    process.env.HL_TWAP_EXEC_SLICE_USD = '200';
    process.env.HL_TWAP_EXEC_SLICE_GAP_MS = '0';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();
    client.seedPosition('BTC', 0.1);

    const fill = await client.marketOrder({
      coin: 'BTC',
      displaySymbol: 'BTC',
      side: 'sell',
      notionalUsd: 5000,
      markPx: 50000,
      reduceOnly: true,
      intent: 'close',
      sizeBase: 0.1,
    });

    expect(fill.notionalUsd).toBeCloseTo(5000, 0);
    const text = fs.readFileSync(journalPath, 'utf8');
    const orderLines = text.split('\n').filter((l) => l.includes('"kind":"order"'));
    expect(orderLines.length).toBe(25);
  });

  it('uses per-coin leverage cap when splitting opens', async () => {
    let innerCalls = 0;
    const inner: HlTwapExchangeClient = {
      mode: 'dry_run',
      init: async () => {},
      accountAddress: () => '0x0',
      getPositionSzi: async () => 0,
      leverageForCoin: () => 3,
      marketOrder: async (params: MarketOrderParams): Promise<OrderFillResult> => {
        innerCalls += 1;
        const lev = 3;
        const gross = params.intent === 'open' ? params.notionalUsd * lev : params.notionalUsd;
        return {
          fillPx: 1,
          sizeBase: gross,
          notionalUsd: gross,
          marginUsd: params.intent === 'open' ? params.notionalUsd : undefined,
          leverage: params.intent === 'open' ? lev : undefined,
          requestedNotionalUsd: gross,
        };
      },
    };

    const cfg = loadHlTwapLiveConfig();
    cfg.execSliceUsd = 200;
    cfg.execSliceGapMs = 0;
    cfg.leverage = 7;

    const fill = await executeSlicedMarketOrder(
      inner,
      {
        coin: 'GRASS',
        displaySymbol: 'GRASS',
        side: 'sell',
        notionalUsd: 1500,
        markPx: 1,
        reduceOnly: false,
        intent: 'open',
      },
      cfg,
    );

    expect(innerCalls).toBe(23);
    expect(fill.notionalUsd).toBeCloseTo(4500, 0);
    expect(fill.requestedNotionalUsd).toBeCloseTo(4500, 0);
    expect(isOpenFillAcceptable(fill.notionalUsd, fill.requestedNotionalUsd ?? 5600)).toBe(true);
  });

  it('waits execSliceGapMs between each sub-slice', async () => {
    vi.useFakeTimers();
    let innerCalls = 0;
    const inner: HlTwapExchangeClient = {
      mode: 'dry_run',
      init: async () => {},
      accountAddress: () => '0x0',
      getPositionSzi: async () => 0,
      leverageForCoin: () => cfg.leverage,
      marketOrder: async (_params: MarketOrderParams): Promise<OrderFillResult> => {
        innerCalls += 1;
        return { fillPx: 100, sizeBase: 2, notionalUsd: 200 };
      },
    };

    const cfg = loadHlTwapLiveConfig();
    cfg.execSliceUsd = 200;
    cfg.execSliceGapMs = 5000;
    cfg.leverage = 5;

    const params: MarketOrderParams = {
      coin: 'ETH',
      displaySymbol: 'ETH',
      side: 'buy',
      notionalUsd: 100,
      markPx: 100,
      reduceOnly: false,
      intent: 'open',
    };

    const promise = executeSlicedMarketOrder(inner, params, cfg);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    const fill = await promise;

    expect(innerCalls).toBe(3);
    expect(fill.notionalUsd).toBeCloseTo(600, 0);
    vi.useRealTimers();
  });
});
