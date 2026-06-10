import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeLiveTrade,
  isLiveExitPending,
  processPendingLiveExits,
} from '../src/hyperliquid/twap/live/chunked-exit-runner.js';
import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import { createDryRunClient } from '../src/hyperliquid/twap/live/exchange-dry-run.js';
import {
  appendLiveJournal,
  journalExitStartRow,
  journalOpenRow,
} from '../src/hyperliquid/twap/live/journal.js';
import type { HlTwapLiveOpen } from '../src/hyperliquid/twap/live/types.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

function makeOpen(hash: string, entryTs: number): HlTwapLiveOpen {
  return {
    hash,
    coin: 'HYPE',
    displaySymbol: 'HYPE',
    side: 'buy',
    entryTs,
    entryAnchorPx: 10,
    avgEntryPx: 10,
    initialNotionalUsd: 500,
    currentNotionalUsd: 500,
    marginUsd: 100,
    entryLeverage: 5,
    impactPct: 3,
    whaleUser: '0x1',
    minutes: 60,
    liveOpenAtMs: entryTs,
    liveCloseAtMs: entryTs + 3_600_000,
    twapStartMs: entryTs,
    tpLevelsTaken: 0,
    dcaLevelsTaken: 0,
    whaleNotionalUsd: 1000,
    whaleSize: 1,
  };
}

describe('single exit per coin+side book', () => {
  it('starts only one exit_start when multiple journal legs share exchange book', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-book-exit-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';
    process.env.HL_TWAP_LIVE_EXIT_SLICES_LONG = '3';
    process.env.HL_TWAP_EXEC_SLICE_GAP_MS = '0';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();

    const legA = makeOpen('hash_a', 1_000);
    const legB = makeOpen('hash_b', 2_000);
    const legC = makeOpen('hash_c', 3_000);
    appendLiveJournal(journalPath, journalOpenRow(legA));
    appendLiveJournal(journalPath, journalOpenRow(legB));
    appendLiveJournal(journalPath, journalOpenRow(legC));
    client.seedPosition('HYPE', 150);

    await closeLiveTrade('hash_a', 10.5, 'twap_early_exit', cfg, client);
    expect(await closeLiveTrade('hash_b', 10.5, 'twap_early_exit', cfg, client)).toBeNull();
    expect(await closeLiveTrade('hash_c', 10.5, 'twap_early_exit', cfg, client)).toBeNull();

    const text = fs.readFileSync(journalPath, 'utf8');
    const exitStarts = text.match(/"kind":"exit_start"/g) ?? [];
    expect(exitStarts.length).toBe(1);
    expect(isLiveExitPending(cfg, 'hash_b')).toBe(true);
    expect(isLiveExitPending(cfg, 'hash_c')).toBe(true);
  });

  it('processes one exit driver per book and closes all journal legs', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-book-exit2-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    process.env.HL_TWAP_LIVE_JSONL = journalPath;
    process.env.HL_TWAP_LIVE_DRY_RUN = '1';
    process.env.HL_TWAP_LIVE_EXIT_SLICES_LONG = '1';
    process.env.HL_TWAP_EXEC_SLICE_GAP_MS = '0';

    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;
    const client = createDryRunClient(cfg);
    await client.init();

    const legA = makeOpen('hash_a', 1_000);
    const legB = makeOpen('hash_b', 2_000);
    appendLiveJournal(journalPath, journalOpenRow(legA));
    appendLiveJournal(journalPath, journalOpenRow(legB));
    client.seedPosition('HYPE', 100);

    const now = Date.now();
    appendLiveJournal(
      journalPath,
      journalExitStartRow({
        hash: 'hash_a',
        exitReason: 'twap_early_exit',
        sliceCount: 1,
        sliceIntervalMs: 0,
        startedAtMs: now,
        exitStartNotionalUsd: 500,
      }),
    );
    appendLiveJournal(
      journalPath,
      journalExitStartRow({
        hash: 'hash_b',
        exitReason: 'twap_early_exit',
        sliceCount: 1,
        sliceIntervalMs: 0,
        startedAtMs: now,
        exitStartNotionalUsd: 500,
      }),
    );

    await processPendingLiveExits(() => 10.5, cfg, client);
    expect(await client.getPositionSzi('HYPE')).toBe(0);

    const text = fs.readFileSync(journalPath, 'utf8');
    const closes = text.match(/"kind":"close"/g) ?? [];
    expect(closes.length).toBe(2);
    expect(text).toContain('"hash":"hash_a"');
    expect(text).toContain('"hash":"hash_b"');
  });
});
