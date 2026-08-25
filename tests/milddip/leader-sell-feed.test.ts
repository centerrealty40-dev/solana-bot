import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LeaderSellFeed,
  CrossLeaderBuyFeed,
  LEADER_SELL_RECONCILIATION_TAIL_BYTES,
  parseCrossLeaderBuyLines,
  crossLeaderAverageDiscountReached,
  crossLeaderAverageRequiresSignal,
  crossLeaderAverageStepUsd,
  resolveCrossLeaderAverageLeaders,
  shouldJournalCrossLeaderAverageSkip,
  parseLeaderSellLines,
  reconcileLeaderBuyEvents,
  reconcileLeaderSellEvents,
} from '../../src/milddip/leader-sell-feed.js';

const leader = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';
const other = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';
const base = {
  kind: 'trade_fill',
  actor: 'leader',
  side: 'sell',
  ok: true,
  wallet: leader,
  mint: 'Mint111',
  blockTime: 100,
  signature: 'sig',
  fillPriceUsd: 1.2,
  markPnlPct: 4,
};

describe('leader sell feed parser', () => {
  it('filters event shape, configured leaders, and max age', () => {
    const stats = { staleDropped: 0 };
    expect(
      parseLeaderSellLines(
        [
          JSON.stringify(base),
          JSON.stringify({ ...base, wallet: other, mint: 'Mint222' }),
          JSON.stringify({ ...base, side: 'buy', mint: 'Mint333' }),
          JSON.stringify({ ...base, blockTime: 1, mint: 'Mint444' }),
        ],
        110_000,
        { leaders: [leader], maxAgeMs: 20_000, stats },
      ),
    ).toHaveLength(1);
    expect(stats.staleDropped).toBe(1);
  });

  it('uses ts fallback and ignores malformed lines', () => {
    const events = parseLeaderSellLines(
      [JSON.stringify({ ...base, blockTime: undefined, ts: 105_000 }), '{bad json'],
      110_000,
      { leaders: [leader], maxAgeMs: 10_000 },
    );
    expect(events[0]?.blockTimeMs).toBe(105_000);
    expect(events).toHaveLength(1);
  });

  it('tails only complete lines, then handles rotation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-sell-feed-'));
    const file = path.join(dir, 'trades.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ ...base, blockTime: 100 })}\n`);
    const feed = new LeaderSellFeed(file, { leaders: [leader], maxAgeMs: 60_000 });
    feed.start();
    fs.appendFileSync(file, JSON.stringify({ ...base, mint: 'MintPartial', blockTime: 105 }));
    expect(feed.read(110_000)).toEqual([]);
    fs.appendFileSync(file, '\n');
    expect(feed.read(110_000).map((event) => event.mint)).toEqual(['MintPartial']);
    fs.truncateSync(file, 0);
    expect(feed.read(110_000)).toEqual([]);
    fs.appendFileSync(file, `${JSON.stringify({ ...base, mint: 'MintRotated', blockTime: 108 })}\n`);
    expect(feed.read(110_000).map((event) => event.mint)).toEqual(['MintRotated']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('buffers a consumed event until it is explicitly removed or expires', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-sell-feed-buffer-'));
    const file = path.join(dir, 'trades.jsonl');
    fs.writeFileSync(file, '');
    const feed = new LeaderSellFeed(file, { leaders: [leader], maxAgeMs: 10_000 });
    feed.start();
    fs.appendFileSync(file, `${JSON.stringify({ ...base, mint: 'MintBuffered', blockTime: 105 })}\n`);
    expect(feed.read(110_000)).toHaveLength(1);
    expect(feed.get('MintBuffered', 110_000)?.mint).toBe('MintBuffered');
    expect(feed.get('MintBuffered', 116_000)).toBeNull();
    fs.appendFileSync(file, `${JSON.stringify({ ...base, mint: 'MintRemoved', blockTime: 109 })}\n`);
    feed.read(110_000);
    feed.remove('MintRemoved');
    expect(feed.get('MintRemoved', 110_000)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a sale available for observation when there are no open positions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-sell-feed-flat-'));
    const file = path.join(dir, 'trades.jsonl');
    fs.writeFileSync(file, '');
    const feed = new LeaderSellFeed(file, { leaders: [leader], maxAgeMs: 10_000 });
    feed.start();
    fs.appendFileSync(
      file,
      `${JSON.stringify({ ...base, mint: 'MintObservedWhileFlat', blockTime: 105 })}\n`,
    );

    // The main tick polls the feed before exit processing, even with no open positions.
    expect(feed.read(110_000)).toHaveLength(1);
    expect(feed.get('MintObservedWhileFlat', 110_000)?.mint).toBe('MintObservedWhileFlat');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles current and rotated journals beyond the live max age', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-sell-feed-reconcile-'));
    const file = path.join(dir, 'trades.jsonl');
    const event = { ...base, mint: 'MintReconciled', blockTime: 100 };
    fs.writeFileSync(`${file}.1`, `${JSON.stringify(event)}\n`);
    fs.writeFileSync(file, '');
    expect(
      reconcileLeaderSellEvents({
        path: file,
        leaders: [leader],
        openMints: new Set(['MintReconciled']),
        nowMs: 100_000,
        windowMs: 6 * 60 * 60_000,
      }),
    ).toMatchObject([{ mint: 'MintReconciled', leader, blockTimeMs: 100_000 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads a sale at the end of a large tail and drops a partial first line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-sell-feed-tail-'));
    const file = path.join(dir, 'trades.jsonl');
    const event = { ...base, mint: 'MintTail', blockTime: 100 };
    fs.writeFileSync(
      file,
      `${'x'.repeat(LEADER_SELL_RECONCILIATION_TAIL_BYTES + 100)}\n${JSON.stringify(event)}\n`,
    );
    expect(
      reconcileLeaderSellEvents({
        path: file,
        leaders: [leader],
        openMints: new Set(['MintTail']),
        nowMs: 110_000,
      }),
    ).toMatchObject([{ mint: 'MintTail' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles a leader buy and suppresses it when a later sale exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leader-buy-reconcile-'));
    const file = path.join(dir, 'trades.jsonl');
    const buy = {
      ...base,
      side: 'buy',
      mint: 'MintBuy',
      blockTime: 100,
      fillPriceUsd: 0.25,
      sizeUsdIntent: 200,
      isAdd: false,
    };
    fs.writeFileSync(file, `${JSON.stringify(buy)}\n`);
    expect(
      reconcileLeaderBuyEvents({
        path: file,
        leaders: [leader],
        openMints: new Set(['MintAlreadyOpen']),
        nowMs: 110_000,
      }),
    ).toMatchObject([
      {
        mint: 'MintBuy',
        leader,
        blockTimeMs: 100_000,
        fillPriceUsd: 0.25,
        sizeUsd: 200,
      },
    ]);
    fs.appendFileSync(file, `${JSON.stringify({ ...base, mint: 'MintBuy', blockTime: 101 })}\n`);
    expect(
      reconcileLeaderBuyEvents({
        path: file,
        leaders: [leader],
        openMints: new Set(),
        nowMs: 110_000,
      }),
    ).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cross-leader buy feed', () => {
  const buy = {
    kind: 'trade_fill',
    actor: 'leader',
    side: 'buy',
    ok: true,
    wallet: other,
    mint: 'MintCross',
    blockTime: 100,
    signature: 'cross-sig',
    fillPriceUsd: 0.5,
    sizeUsdIntent: 25,
  };

  it('filters own, stale, and undersized buys and accepts foreign buys', () => {
    expect(
      parseCrossLeaderBuyLines(
        [
          JSON.stringify(buy),
          JSON.stringify({ ...buy, wallet: leader }),
          JSON.stringify({ ...buy, sizeUsdIntent: 19 }),
          JSON.stringify({ ...buy, blockTime: 1 }),
        ],
        110_000,
        { leaders: [other], maxAgeMs: 20_000, minSizeUsd: 20 },
      ),
    ).toMatchObject([{ mint: 'MintCross', leader: other, sizeUsd: 25 }]);
  });

  it('filters configured cross leaders that belong to this mirror', () => {
    expect(resolveCrossLeaderAverageLeaders([leader, other], [leader])).toEqual([other]);
  });

  it('requires the configured discount from the current average entry', () => {
    expect(crossLeaderAverageDiscountReached(0.91, 1, 10)).toBe(false);
    expect(crossLeaderAverageDiscountReached(0.90, 1, 10)).toBe(true);
    expect(crossLeaderAverageDiscountReached(0.85, 1, 10)).toBe(true);
  });

  it('requires a foreign signal only before the step base is fixed', () => {
    expect(crossLeaderAverageRequiresSignal({ stepsEnabled: false, basePriceUsd: 1, baseUsd: 100 })).toBe(true);
    expect(crossLeaderAverageRequiresSignal({ stepsEnabled: true })).toBe(true);
    expect(crossLeaderAverageRequiresSignal({ stepsEnabled: true, basePriceUsd: 1, baseUsd: 100 })).toBe(false);
  });

  it('calculates capped cross-leader averaging steps from the original base', () => {
    expect(
      crossLeaderAverageStepUsd({
        markPriceUsd: 0.851,
        basePriceUsd: 1,
        baseUsd: 100,
        addedUsd: 0,
        minDiscountPct: 15,
        startFraction: 0.3,
        fullDiscountPct: 50,
        maxTotalFraction: 1,
        minStepUsd: 3,
      }),
    ).toBeNull();
    const firstStep = crossLeaderAverageStepUsd({
      markPriceUsd: 0.85,
      basePriceUsd: 1,
      baseUsd: 100,
      addedUsd: 0,
      minDiscountPct: 15,
      startFraction: 0.3,
      fullDiscountPct: 50,
      maxTotalFraction: 1,
      minStepUsd: 3,
    });
    expect(firstStep?.stepUsd).toBeCloseTo(30);
    expect(firstStep?.targetFraction).toBeCloseTo(0.3);
    const midStep = crossLeaderAverageStepUsd({
      markPriceUsd: 0.7,
      basePriceUsd: 1,
      baseUsd: 100,
      addedUsd: 0,
      minDiscountPct: 15,
      startFraction: 0.3,
      fullDiscountPct: 50,
      maxTotalFraction: 1,
      minStepUsd: 3,
    });
    expect(midStep?.stepUsd).toBeCloseTo(60);
    expect(midStep?.targetFraction).toBeCloseTo(0.6);
    expect(
      crossLeaderAverageStepUsd({
        markPriceUsd: 0.5,
        basePriceUsd: 1,
        baseUsd: 100,
        addedUsd: 0,
        minDiscountPct: 15,
        startFraction: 0.3,
        fullDiscountPct: 50,
        maxTotalFraction: 1,
        minStepUsd: 3,
      }),
    ).toMatchObject({ stepUsd: 100, targetFraction: 1 });
    expect(
      crossLeaderAverageStepUsd({
        markPriceUsd: 0.3,
        basePriceUsd: 1,
        baseUsd: 100,
        addedUsd: 100,
        minDiscountPct: 15,
        startFraction: 0.3,
        fullDiscountPct: 50,
        maxTotalFraction: 1,
        minStepUsd: 3,
      }),
    ).toMatchObject({ stepUsd: 0, targetFraction: 1, reason: 'steps_target_reached' });
  });

  it('accumulates only the incremental amount for each step', () => {
    const options = {
      basePriceUsd: 1,
      baseUsd: 100,
      minDiscountPct: 15,
      startFraction: 0.3,
      fullDiscountPct: 50,
      maxTotalFraction: 1,
      minStepUsd: 3,
    };
    expect(crossLeaderAverageStepUsd({ ...options, markPriceUsd: 0.85, addedUsd: 0 })?.stepUsd).toBeCloseTo(30);
    expect(crossLeaderAverageStepUsd({ ...options, markPriceUsd: 0.7, addedUsd: 30 })?.stepUsd).toBeCloseTo(30);
    expect(crossLeaderAverageStepUsd({ ...options, markPriceUsd: 0.5, addedUsd: 60 })?.stepUsd).toBeCloseTo(40);
  });

  it('rejects steps below the minimum and invalid base size', () => {
    expect(
      crossLeaderAverageStepUsd({
        markPriceUsd: 0.85,
        basePriceUsd: 1,
        baseUsd: 9,
        addedUsd: 0,
        minDiscountPct: 15,
        startFraction: 0.3,
        fullDiscountPct: 50,
        maxTotalFraction: 1,
        minStepUsd: 3,
      }),
    ).toMatchObject({ stepUsd: 0, reason: 'step_too_small' });
    expect(
      crossLeaderAverageStepUsd({
        markPriceUsd: 0.5,
        basePriceUsd: 1,
        baseUsd: 0,
        addedUsd: 0,
        minDiscountPct: 15,
        startFraction: 0.3,
        fullDiscountPct: 50,
        maxTotalFraction: 1,
        minStepUsd: 3,
      }),
    ).toBeNull();
  });

  it('reads incrementally and buffers the latest event per mint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-leader-feed-'));
    const file = path.join(dir, 'trades.jsonl');
    fs.writeFileSync(file, '');
    const feed = new CrossLeaderBuyFeed(file, {
      leaders: [other],
      maxAgeMs: 60_000,
      minSizeUsd: 20,
    });
    feed.start();
    fs.appendFileSync(file, JSON.stringify(buy));
    expect(feed.read(110_000)).toEqual([]);
    fs.appendFileSync(file, '\n');
    expect(feed.read(110_000)).toHaveLength(1);
    expect(feed.get('MintCross', 110_000)?.signature).toBe('cross-sig');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('throttles repeated cross-leader skip reasons', () => {
    const mint = `CrossThrottle${Date.now()}`;
    expect(shouldJournalCrossLeaderAverageSkip(mint, 'cooldown', 1_000)).toBe(true);
    expect(shouldJournalCrossLeaderAverageSkip(mint, 'cooldown', 300_999)).toBe(false);
    expect(shouldJournalCrossLeaderAverageSkip(mint, 'limit_reached', 300_999)).toBe(true);
    expect(shouldJournalCrossLeaderAverageSkip(mint, 'limit_reached', 599_999)).toBe(false);
    expect(shouldJournalCrossLeaderAverageSkip(mint, 'limit_reached', 600_999)).toBe(true);
  });
});
