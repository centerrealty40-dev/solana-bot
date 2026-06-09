import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canScheduleLiveEntry } from '../src/hyperliquid/twap/live/coin-exposure.js';
import {
  liveCoinPriorLossBlockReason,
  liveLossStreakBlockReason,
  loadClosedTradeOutcomes,
} from '../src/hyperliquid/twap/live/loss-streak-cooldown.js';
import { createTwapWatchState } from '../src/hyperliquid/twap/detect.js';
import type { NormalizedTwapSignal } from '../src/hyperliquid/twap/types.js';

function sig(hash: string, coin = 'GRASS'): NormalizedTwapSignal {
  return {
    hash,
    twapId: null,
    user: `0x${hash}`,
    side: 'buy',
    coin,
    displaySymbol: coin,
    isSpot: false,
    size: 1,
    minutes: 30,
    randomize: false,
    reduceOnly: false,
    notionalUsd: 500_000,
    midPx: 1,
    dayNtlVlmUsd: 1e9,
    volumeSharePct: 5,
    startedAtMs: Date.now(),
    block: 1,
    ended: null,
  };
}

describe('loss-streak-cooldown', () => {
  const envBackup = { ...process.env };
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    process.env.HL_TWAP_LIVE_LOSS_STREAK_COOLDOWN = '1';
    process.env.HL_TWAP_LIVE_LOSS_STREAK_COUNT = '2';
    process.env.HL_TWAP_LIVE_LOSS_STREAK_COOLDOWN_HOURS = '2';
    process.env.HL_TWAP_BTC_ALIGNED_GATE = '0';
    process.env.HL_TWAP_COIN_MOMENTUM_GATE = '0';
    process.env.HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK = '1';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-loss-streak-'));
    journalPath = path.join(tmpDir, 'live.jsonl');
  });

  afterEach(() => {
    process.env = { ...envBackup };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJournal(lines: object[]) {
    fs.writeFileSync(journalPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('coin prior loss blocks re-entry after single loss (gate B)', () => {
    const t0 = 1_700_000_000_000;
    writeJournal([
      { kind: 'open', ts: t0, hash: '0xa', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 60_000, hash: '0xa', pnlUsd: -5, exitPx: 1, pnlPct: -1, exitReason: 'x' },
    ]);
    expect(liveCoinPriorLossBlockReason('GRASS', 'buy', journalPath)).toBe('coin_prior_loss');
    const state = createTwapWatchState();
    const next = sig('0xc', 'GRASS');
    state.activeByHash.set('0xc', next);
    const d = canScheduleLiveEntry(next, state, new Map(), 2, journalPath);
    expect(d.allow).toBe(false);
    expect(d.reason).toBe('coin_prior_loss');
  });

  it('blocks after 2 consecutive losses on same coin+side within cooldown', () => {
    process.env.HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK = '0';
    const t0 = 1_700_000_000_000;
    writeJournal([
      { kind: 'open', ts: t0, hash: '0xa', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 1_800_000, hash: '0xa', pnlUsd: -5, exitPx: 1, pnlPct: -1, exitReason: 'x' },
      { kind: 'open', ts: t0 + 3_600_000, hash: '0xb', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 5_400_000, hash: '0xb', pnlUsd: -3, exitPx: 1, pnlPct: -1, exitReason: 'x' },
    ]);
    const outcomes = loadClosedTradeOutcomes(journalPath);
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.pnlUsd < 0)).toBe(true);

    const block = liveLossStreakBlockReason('GRASS', 'buy', journalPath, t0 + 5_500_000);
    expect(block).toMatch(/^loss_streak_cooldown_2x_/);

    const after = liveLossStreakBlockReason('GRASS', 'buy', journalPath, t0 + 5_400_000 + 2 * 3600_000 + 1);
    expect(after).toBeNull();
  });

  it('canScheduleLiveEntry rejects during cooldown', () => {
    process.env.HL_TWAP_LIVE_COIN_PRIOR_LOSS_BLOCK = '0';
    const t0 = Date.now() - 3600_000;
    writeJournal([
      { kind: 'open', ts: t0, hash: '0xa', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 60_000, hash: '0xa', pnlUsd: -1, exitPx: 1, pnlPct: -1, exitReason: 'x' },
      { kind: 'open', ts: t0 + 120_000, hash: '0xb', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 180_000, hash: '0xb', pnlUsd: -2, exitPx: 1, pnlPct: -1, exitReason: 'x' },
    ]);
    const state = createTwapWatchState();
    const next = sig('0xc', 'GRASS');
    state.activeByHash.set('0xc', next);
    const d = canScheduleLiveEntry(next, state, new Map(), 2, journalPath);
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/loss_streak_cooldown/);
  });

  it('win breaks streak', () => {
    const t0 = 1_700_000_000_000;
    writeJournal([
      { kind: 'open', ts: t0, hash: '0xa', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 60_000, hash: '0xa', pnlUsd: -1, exitPx: 1, pnlPct: -1, exitReason: 'x' },
      { kind: 'open', ts: t0 + 120_000, hash: '0xb', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 180_000, hash: '0xb', pnlUsd: 3, exitPx: 1, pnlPct: 1, exitReason: 'x' },
      { kind: 'open', ts: t0 + 240_000, hash: '0xc', coin: 'GRASS', side: 'buy' },
      { kind: 'close', ts: t0 + 300_000, hash: '0xc', pnlUsd: -1, exitPx: 1, pnlPct: -1, exitReason: 'x' },
    ]);
    expect(liveLossStreakBlockReason('GRASS', 'buy', journalPath, t0 + 310_000)).toBeNull();
  });
});
