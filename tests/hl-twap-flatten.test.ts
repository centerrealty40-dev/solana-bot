import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import { createDryRunClient } from '../src/hyperliquid/twap/live/exchange-dry-run.js';
import { flattenCoinOnExchange } from '../src/hyperliquid/twap/live/flatten-position.js';
import { closeLiveTrade } from '../src/hyperliquid/twap/live/live-trader.js';
import { appendLiveJournal, journalOpenRow } from '../src/hyperliquid/twap/live/journal.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('hl-twap flatten close', () => {
  it('flattenCoinOnExchange clears simulated position in retries', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-flat-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();
    client.seedPosition('LTC', -2.08);

    const { flat, remainingAbsSize } = await flattenCoinOnExchange(
      client,
      'LTC',
      'LTC',
      85,
      'close',
    );
    expect(flat).toBe(true);
    expect(remainingAbsSize).toBe(0);
    expect(await client.getPositionSzi('LTC')).toBe(0);
  });

  it('closeLiveTrade skips journal when exchange position cannot flatten', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-close-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();

    const pos: HlTwapLiveOpen = {
      hash: 'hash1',
      coin: 'ARB',
      displaySymbol: 'ARB',
      side: 'buy',
      entryTs: Date.now(),
      entryAnchorPx: 1,
      avgEntryPx: 1,
      initialNotionalUsd: 500,
      currentNotionalUsd: 500,
      marginUsd: 100,
      entryLeverage: 5,
      impactPct: 3,
      whaleUser: '0x1',
      minutes: 60,
      liveOpenAtMs: Date.now(),
      liveCloseAtMs: Date.now() + 60_000,
      twapStartMs: Date.now(),
      tpLevelsTaken: 0,
      dcaLevelsTaken: 0,
      whaleNotionalUsd: 1000,
      whaleSize: 1,
    };
    appendLiveJournal(journalPath, journalOpenRow(pos));
    client.seedPosition('ARB', 1.5);

    const origMarket = client.marketOrder.bind(client);
    let calls = 0;
    client.marketOrder = async (params) => {
      calls += 1;
      if (calls <= 7) {
        throw new Error('reduce only would increase position');
      }
      return origMarket(params);
    };

    const closed = await closeLiveTrade('hash1', 1.01, 'before_last_cycle', cfg, client);
    expect(closed).toBeNull();
    const text = fs.readFileSync(journalPath, 'utf8');
    expect(text).not.toContain('"kind":"close"');
  });

  it('closeLiveTrade writes journal only after full flatten', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-close-ok-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';
    process.env.HL_TWAP_LIVE_EXIT_SLICES_LONG = '1';
    process.env.HL_TWAP_EXEC_SLICE_GAP_MS = '0';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();

    const pos: HlTwapLiveOpen = {
      hash: 'hash2',
      coin: 'FET',
      displaySymbol: 'FET',
      side: 'buy',
      entryTs: Date.now(),
      entryAnchorPx: 2,
      avgEntryPx: 2,
      initialNotionalUsd: 500,
      currentNotionalUsd: 500,
      marginUsd: 100,
      entryLeverage: 5,
      impactPct: 3,
      whaleUser: '0x1',
      minutes: 60,
      liveOpenAtMs: Date.now(),
      liveCloseAtMs: Date.now() + 60_000,
      twapStartMs: Date.now(),
      tpLevelsTaken: 0,
      dcaLevelsTaken: 0,
      whaleNotionalUsd: 1000,
      whaleSize: 1,
    };
    appendLiveJournal(journalPath, journalOpenRow(pos));
    client.seedPosition('FET', 250);

    const closed = await closeLiveTrade('hash2', 2.1, 'before_last_cycle', cfg, client);
    expect(closed).not.toBeNull();
    expect(await client.getPositionSzi('FET')).toBe(0);
    const text = fs.readFileSync(journalPath, 'utf8');
    expect(text).toContain('"kind":"close"');
    expect(text).toContain('before_last_cycle');
  });
});
