import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MildDipConfig } from '../../src/milddip/config.js';
import {
  __resetLeaderGateShadowBudgetForTests,
  appendLeaderGateShadowOutcome,
  attemptMildDipEntry,
  recordLeaderGateShadowCandidate,
  takeLeaderGateShadowDeferSlot,
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
    leaderGateShadowDefer: false,
    leaderGateShadowDeferMaxPerHour: 60,
    journalPath,
    deniedMints: [],
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

  it('enforces the deferred-lane hourly budget and keeps it opt-in', () => {
    const file = journalPath();
    const base = cfg(file, {
      leaderGateShadowDefer: true,
      leaderGateShadowDeferMaxPerHour: 2,
      leaderGateShadowMinIntervalMs: 0,
    });
    expect(takeLeaderGateShadowDeferSlot(base, 'A'.repeat(44), 1_000_000)).toBe(true);
    expect(takeLeaderGateShadowDeferSlot(base, 'B'.repeat(44), 1_000_001)).toBe(true);
    expect(takeLeaderGateShadowDeferSlot(base, 'C'.repeat(44), 1_000_002)).toBe(false);
    expect(
      takeLeaderGateShadowDeferSlot(
        { ...base, leaderGateShadowDefer: false },
        'D'.repeat(44),
        1_000_003,
      ),
    ).toBe(false);
    expect(
      takeLeaderGateShadowDeferSlot(
        { ...base, leaderGateShadowRecord: false },
        'E'.repeat(44),
        1_000_004,
      ),
    ).toBe(false);
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
      liquidityUsd: 45_678,
      marketCapUsd: 456_789,
      volume5mUsd: 12_345,
      buys5m: 17,
      sells5m: 23,
      plannedEntrySizeUsd: null,
      });
  });

  it('shadow-only entry skips before sizing or execution and records the outcome', async () => {
    const file = journalPath();
    const c = candidate({ shadowOnly: true });
    let sized = false;
    const result = await attemptMildDipEntry({
      cfg: cfg(file),
      state: {
        open: {},
        cooldownUntilMs: {},
        updatedAtMs: 1_000_000,
      },
      candidate: c,
      copyCfg: {} as never,
      nowMs: 1_000_000,
      buyInFlight: new Set(),
      resolveEntrySizeUsd: async () => {
        sized = true;
        throw new Error('shadow candidate must not be sized');
      },
      adoptOnChainHolding: () => {
        throw new Error('shadow candidate must not adopt holdings');
      },
      opts: {
        chasePct: 3,
        trigger: 'stream',
        lane: 'fast',
      },
    });
    expect(result).toBe('skip');
    expect(sized).toBe(false);
    const event = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      kind: 'mild_dip_shadow_entry_candidate',
      stage: 'entry_attempt_reached',
      wouldBuy: false,
      remainingGatesUnevaluated: true,
      reason: null,
      shadowOnly: true,
    });
  });

  it('records the fast-path stop step and outcome for deferred candidates', () => {
    const file = journalPath();
    appendLeaderGateShadowOutcome({
      cfg: cfg(file),
      candidate: candidate(),
      mint: MINT,
      nowMs: 1_234_567,
      trigger: 'stream',
      lane: 'fast',
      stage: 'fast_path',
      reason: 'structural_fail',
      wouldBuy: false,
      gates: { structural: false, dip: false },
      details: { structSource: 'dex' },
    });
    const event = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(event).toMatchObject({
      stage: 'fast_path',
      reason: 'structural_fail',
      wouldBuy: false,
      gates: { structural: false, dip: false },
      details: { structSource: 'dex' },
    });
  });

  it('keeps the early gate and shadow-only propagation wired in loop', () => {
    const source = readFileSync(
      path.resolve('src/milddip/loop.ts'),
      'utf8',
    );
    expect(source).toContain('takeLeaderGateShadowDeferSlot');
    expect(source).toContain('shadowOnly =');
    expect(source).toContain('shadowOnly: true');
    expect(source).toContain('candidate: shadowCandidate');
    expect(source).toContain('mild_dip_not_leader_seen_skip');
  });
});
