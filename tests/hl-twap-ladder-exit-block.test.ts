import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  blocksLiveLadderDuringExit,
  isLiveExitPending,
} from '../src/hyperliquid/twap/live/chunked-exit-runner.js';
import { loadHlTwapLiveConfig } from '../src/hyperliquid/twap/live/config.js';
import { appendLiveJournal, journalExitSliceRow, journalExitStartRow } from '../src/hyperliquid/twap/live/journal.js';

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('blocksLiveLadderDuringExit', () => {
  it('does not block ladder when exit is scheduled but no slice sent yet', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-ladder-exit-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;

    const hash = '0xabc';
    appendLiveJournal(
      journalPath,
      journalExitStartRow({
        hash,
        exitReason: 'twap_early_exit',
        sliceCount: 3,
        sliceIntervalMs: 30_000,
        startedAtMs: Date.now(),
        exitStartNotionalUsd: 2000,
      }),
    );

    expect(isLiveExitPending(cfg, hash)).toBe(true);
    expect(blocksLiveLadderDuringExit(cfg, hash)).toBe(false);
  });

  it('blocks ladder after first exit slice is recorded', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-ladder-exit2-'));
    const journalPath = path.join(tmpDir, 'live.jsonl');
    const cfg = loadHlTwapLiveConfig();
    cfg.journalPath = journalPath;

    const hash = '0xdef';
    appendLiveJournal(
      journalPath,
      journalExitStartRow({
        hash,
        exitReason: 'twap_early_exit',
        sliceCount: 3,
        sliceIntervalMs: 30_000,
        startedAtMs: Date.now(),
        exitStartNotionalUsd: 2000,
      }),
    );
    appendLiveJournal(
      journalPath,
      journalExitSliceRow({
        hash,
        sliceIndex: 0,
        fillPx: 100,
        notionalUsd: 500,
        sizeBase: 5,
        remainingBase: 10,
      }),
    );

    expect(isLiveExitPending(cfg, hash)).toBe(true);
    expect(blocksLiveLadderDuringExit(cfg, hash)).toBe(true);
  });
});
