import { readFileSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeOffUnroutableBags } from '../../src/milddip/unroutable-writeoff.js';
import type { MildDipState } from '../../src/milddip/state.js';
import type { MildDipConfig } from '../../src/milddip/config.js';
import { mildDipPriceRing } from '../../src/milddip/price-ring.js';
import {
  resetTradeCashAttributionForTests,
  resetTradeLotsForTests,
  writeUsBuyFill,
} from '../../src/milddip/trade-journal.js';

const baseCfg = (overrides: Record<string, unknown> = {}): MildDipConfig =>
  ({
    executionMode: 'paper',
    unroutableWriteoffEnabled: true,
    unroutableWriteoffMinChecks: 3,
    unroutableWriteoffMinAgeMs: 1_800_000,
    unroutableWriteoffMaxPerPass: 3,
    unroutableWriteoffIntervalMs: 600_000,
    statePath: '/tmp/unroutable-writeoff-state.json',
    journalPath: '/tmp/unroutable-writeoff-journal.jsonl',
    tradesPath: '/tmp/unroutable-writeoff-trades.jsonl',
    ...overrides,
  }) as MildDipConfig;

const position = (mint: string) => ({
  mint,
  symbol: mint.slice(0, 6),
  entryPriceUsd: 1,
  sizeUsd: 10,
  tokenRaw: '1000000',
  openedAtMs: 1,
  entryPc5mPct: 0,
  buySignature: null,
});

const baseState = (mint = 'Mint111111111111111111111111111111111111111') =>
  (mildDipPriceRing.noteMintDecimals(mint, 6),
  {
    open: { [mint]: position(mint) },
    cooldownUntilMs: {},
    lastExitByMint: {},
    unroutableByMint: {},
    recentEntryMsByMint: {},
    leaderMirrorWatches: {},
  }) as MildDipState;

const noRoute = () => ({ kind: 'skipped' as const, reason: 'no-route' as const, ts: 1 });
const routable = () => ({
  kind: 'ok' as const,
  jupiterPriceUsd: 1,
  snapshotPriceUsd: 1,
  slipPct: 0,
  priceImpactPct: 0,
  routeHops: 1,
  source: 'jupiter' as const,
  ageMs: 1,
  ts: 1,
});

function deps(verdicts: ReturnType<typeof noRoute>[]) {
  return {
    sleep: async () => {},
    quote: async () => verdicts.shift() ?? noRoute(),
  };
}

describe('unroutable writeoff', () => {
  it('is a no-op while disabled', async () => {
    const state = baseState();
    const result = await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffEnabled: false }),
      state,
      nowMs: 2_000_000,
      deps: deps([noRoute(), noRoute()]),
    });
    expect(result).toEqual({ checked: 0, markedNoRoute: 0, wroteOff: 0, skipped: 0 });
    expect(state.open).toHaveProperty(Object.keys(state.open)[0]!);
  });

  it('clears an observation when the route returns', async () => {
    const state = baseState();
    const mint = Object.keys(state.open)[0]!;
    let calls = 0;
    state.unroutableByMint![mint] = { firstSeenAtMs: 1, lastSeenAtMs: 2, checks: 2 };
    const result = await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffMinChecks: 1, unroutableWriteoffMinAgeMs: 0 }),
      state,
      nowMs: 3,
      deps: deps([routable() as never]),
    });
    expect(result.markedNoRoute).toBe(0);
    expect(state.unroutableByMint).not.toHaveProperty(mint);
  });

  it('does not advance observations on unknown results', async () => {
    const state = baseState();
    const mint = Object.keys(state.open)[0]!;
    state.unroutableByMint![mint] = { firstSeenAtMs: 1, lastSeenAtMs: 2, checks: 2 };
    const result = await writeOffUnroutableBags({
      cfg: baseCfg(),
      state,
      nowMs: 2_000_000,
      deps: {
        sleep: async () => {},
        quote: async () => ({ kind: 'skipped' as const, reason: 'timeout' as const, ts: 1 }),
      },
    });
    expect(result.wroteOff).toBe(0);
    expect(state.unroutableByMint![mint]).toEqual({ firstSeenAtMs: 1, lastSeenAtMs: 2, checks: 2 });
  });

  it('requires two consecutive no-route probes', async () => {
    const state = baseState();
    const mint = Object.keys(state.open)[0]!;
    let calls = 0;
    const result = await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffMinChecks: 1, unroutableWriteoffMinAgeMs: 0 }),
      state,
      nowMs: 2_000_000,
      deps: {
        sleep: async () => {},
        quote: async () => {
          calls += 1;
          return calls === 1
            ? noRoute()
            : { kind: 'skipped' as const, reason: 'timeout' as const, ts: 2 };
        },
      },
    });
    expect(result.markedNoRoute).toBe(0);
    expect(state.open).toHaveProperty(mint);
  });

  it('writes off after checks and age thresholds', async () => {
    rmSync('/tmp/unroutable-writeoff-journal.jsonl', { force: true });
    rmSync('/tmp/unroutable-writeoff-trades.jsonl', { force: true });
    const state = baseState();
    const result = await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffMinChecks: 1, unroutableWriteoffMinAgeMs: 0 }),
      state,
      nowMs: 2_000_000,
      deps: deps([noRoute(), noRoute()]),
    });
    const mint = 'Mint111111111111111111111111111111111111111';
    expect(result.wroteOff).toBe(1);
    expect(state.open).not.toHaveProperty(mint);
    expect(state.lastExitByMint?.[mint]?.pnlPct).toBe(-100);
    expect(readFileSync('/tmp/unroutable-writeoff-trades.jsonl', 'utf8')).toContain(
      'unroutable_writeoff',
    );
    expect(readFileSync('/tmp/unroutable-writeoff-journal.jsonl', 'utf8')).toContain(
      'mild_dip_unroutable_writeoff',
    );
  });

  it('uses the hydrated lot cost and falls back only when the lot is absent', async () => {
    rmSync('/tmp/unroutable-writeoff-trades.jsonl', { force: true });
    resetTradeLotsForTests();
    resetTradeCashAttributionForTests();
    const known = baseState();
    const mint = Object.keys(known.open)[0]!;
    writeUsBuyFill({
      tradesPath: '/tmp/unroutable-writeoff-trades.jsonl',
      wallet: 'wallet',
      mint,
      ok: true,
      signature: 'buy',
      sizeUsdIntent: 7,
      quoteSpentUsd: 7,
      fraction: 1,
      nowMs: 1,
    });
    await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffMinChecks: 1, unroutableWriteoffMinAgeMs: 0 }),
      state: known,
      nowMs: 2_000_000,
      deps: deps([noRoute(), noRoute()]),
    });
    const knownText = readFileSync('/tmp/unroutable-writeoff-trades.jsonl', 'utf8');
    expect(knownText).toContain('"costBasisUsd":7');

    rmSync('/tmp/unroutable-writeoff-trades.jsonl', { force: true });
    resetTradeLotsForTests();
    resetTradeCashAttributionForTests();
    const missing = baseState('Missing111111111111111111111111111111111111');
    await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffMinChecks: 1, unroutableWriteoffMinAgeMs: 0 }),
      state: missing,
      nowMs: 2_000_000,
      deps: deps([noRoute(), noRoute()]),
    });
    expect(readFileSync('/tmp/unroutable-writeoff-trades.jsonl', 'utf8')).toContain(
      '"costBasisUsd":10',
    );
  });

  it('enforces the per-pass cap and interval', async () => {
    const state = baseState();
    state.open = {
      A11111111111111111111111111111111111111111: position('A11111111111111111111111111111111111111111'),
      B11111111111111111111111111111111111111111: position('B11111111111111111111111111111111111111111'),
      C11111111111111111111111111111111111111111: position('C11111111111111111111111111111111111111111'),
    };
    for (const mint of Object.keys(state.open)) mildDipPriceRing.noteMintDecimals(mint, 6);
    const result = await writeOffUnroutableBags({
      cfg: baseCfg({
        unroutableWriteoffMinChecks: 1,
        unroutableWriteoffMinAgeMs: 0,
        unroutableWriteoffMaxPerPass: 2,
      }),
      state,
      nowMs: 2_000_000,
      deps: {
        sleep: async () => {},
        quote: async () => noRoute(),
      },
    });
    expect(result.wroteOff).toBe(2);
    expect(Object.keys(state.open)).toHaveLength(1);
    const again = await writeOffUnroutableBags({
      cfg: baseCfg({ unroutableWriteoffMinChecks: 1, unroutableWriteoffMinAgeMs: 0 }),
      state,
      nowMs: 2_000_001,
      deps: deps([noRoute(), noRoute()]),
    });
    expect(again.checked).toBe(0);
  });
});
