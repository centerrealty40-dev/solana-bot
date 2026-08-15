import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MildDipConfig } from '../../src/milddip/config.js';
import {
  __resetLeaderGateShadowBudgetForTests,
  recordLeaderGateShadowCandidate,
} from '../../src/milddip/entry-attempt.js';
import type { MildDipCandidate } from '../../src/milddip/discover.js';

const MINT = 'A'.repeat(44);

function candidate(overrides?: Partial<MildDipCandidate>): MildDipCandidate {
  return {
    mint: MINT,
    symbol: 'SHADOW',
    priceUsd: 0.00123,
    dipSource: 'stream',
    metrics: {
      priceChange5mPct: -12.5,
      volume5mUsd: 12_345,
      liquidityUsd: 45_678,
      marketCapUsd: 456_789,
      pairAgeHours: 4.5,
      dexId: 'pumpswap',
      buys5m: 17,
      sells5m: 23,
      volume1hUsd: 98_765,
      priceChange1hPct: -21.5,
    },
    ...overrides,
  };
}

const dirs: string[] = [];

function cfg(journalPath: string, overrides?: Partial<MildDipConfig>): MildDipConfig {
  return {
    leaderGateShadowRecord: true,
    leaderGateShadowMinIntervalMs: 600_000,
    leaderGateShadowMaxPerHour: 2_000,
    journalPath,
    ...overrides,
  } as MildDipConfig;
}

function journalPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'milddip-shadow-'));
  dirs.push(dir);
  return path.join(dir, 'journal.jsonl');
}

afterEach(() => {
  __resetLeaderGateShadowBudgetForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('leader-gate shadow candidate journal', () => {
  it('does not write when the shadow flag is disabled', () => {
    const file = journalPath();
    expect(
      recordLeaderGateShadowCandidate({
        cfg: cfg(file, { leaderGateShadowRecord: false }),
        candidate: candidate(),
        nowMs: 1_000_000,
        trigger: 'stream',
        lane: 'fast',
      }),
    ).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it('deduplicates a mint within the configured interval', () => {
    const file = journalPath();
    const args = {
      cfg: cfg(file),
      candidate: candidate(),
      trigger: 'stream' as const,
      lane: 'fast' as const,
    };
    expect(recordLeaderGateShadowCandidate({ ...args, nowMs: 1_000_000 })).toBe(true);
    expect(recordLeaderGateShadowCandidate({ ...args, nowMs: 1_599_999 })).toBe(false);
    expect(recordLeaderGateShadowCandidate({ ...args, nowMs: 1_600_000 })).toBe(true);
  });

  it('enforces the hourly cap', () => {
    const file = journalPath();
    const args = {
      cfg: cfg(file, { leaderGateShadowMaxPerHour: 2, leaderGateShadowMinIntervalMs: 0 }),
      trigger: 'scan' as const,
      lane: 'slow' as const,
    };
    expect(
      recordLeaderGateShadowCandidate({
        ...args,
        candidate: candidate(),
        nowMs: 1_000_000,
      }),
    ).toBe(true);
    expect(
      recordLeaderGateShadowCandidate({
        ...args,
        candidate: candidate({ mint: 'B'.repeat(44) }),
        nowMs: 1_000_001,
      }),
    ).toBe(true);
    expect(
      recordLeaderGateShadowCandidate({
        ...args,
        candidate: candidate({ mint: 'C'.repeat(44) }),
        nowMs: 3_000_000,
      }),
    ).toBe(false);
    expect(
      recordLeaderGateShadowCandidate({
        ...args,
        candidate: candidate({ mint: 'D'.repeat(44) }),
        nowMs: 4_600_001,
      }),
    ).toBe(true);
  });

  it('writes the available candidate snapshot fields', () => {
    const file = journalPath();
    recordLeaderGateShadowCandidate({
      cfg: cfg(file),
      candidate: candidate(),
      nowMs: 1_234_567,
      trigger: 'stream',
      lane: 'fast',
    });
    const event = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      kind: 'mild_dip_shadow_entry_candidate',
      ts: 1_234_567,
      mint: MINT,
      symbol: 'SHADOW',
      trigger: 'stream',
      lane: 'fast',
      dipSource: 'stream',
      priceUsd: 0.00123,
      pairAgeHours: 4.5,
      priceChange5mPct: -12.5,
      priceChange1hPct: -21.5,
      streamDrawdownPct: null,
      liquidityUsd: 45_678,
      marketCapUsd: 456_789,
      volume5mUsd: 12_345,
      buys5m: 17,
      sells5m: 23,
      plannedEntrySizeUsd: null,
    });
  });
});
