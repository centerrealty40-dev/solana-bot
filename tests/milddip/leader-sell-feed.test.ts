import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LeaderSellFeed,
  LEADER_SELL_RECONCILIATION_TAIL_BYTES,
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
