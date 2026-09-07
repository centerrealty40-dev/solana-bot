import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buyOnlyBagVerdict,
  clearBuyOnlyPhantomBag,
} from '../../src/milddip/buy-only-bag.js';
import { loadMildDipState } from '../../src/milddip/state.js';

describe('buy-only bag reconciliation', () => {
  it('keeps fresh positions even when the wallet balance is zero', () => {
    expect(
      buyOnlyBagVerdict({
        balanceRaw: 0n,
        positionAgeMs: 10_000,
        minAgeMs: 300_000,
      }),
    ).toBe('skip_have_bag');
  });

  it('fails closed when the wallet balance is unknown', () => {
    expect(
      buyOnlyBagVerdict({
        balanceRaw: null,
        positionAgeMs: 600_000,
        minAgeMs: 300_000,
      }),
    ).toBe('skip_unknown');
  });

  it('keeps an aged position when the wallet still holds tokens', () => {
    expect(
      buyOnlyBagVerdict({
        balanceRaw: 1n,
        positionAgeMs: 600_000,
        minAgeMs: 300_000,
      }),
    ).toBe('skip_have_bag');
  });

  it('clears an aged zero-balance phantom position', () => {
    expect(
      buyOnlyBagVerdict({
        balanceRaw: 0n,
        positionAgeMs: 600_000,
        minAgeMs: 300_000,
      }),
    ).toBe('clear_phantom');
  });

  it('settles cash, removes notification dedupe, and leaves cooldown untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milddip-buy-only-bag-'));
    const statePath = path.join(dir, 'state.json');
    const journalPath = path.join(dir, 'journal.jsonl');
    const mint = 'MintPhantom11111111111111111111111111111111111';
    const state = {
      open: {
        [mint]: {
          mint,
          symbol: 'PHANTOM',
          lane: 'leader_mirror',
          sizeUsd: 100,
          entryPriceUsd: 1,
          openedAtMs: 100,
        },
      },
      cooldownUntilMs: {},
      mirrorBuyNotify: {
        [mint]: { buyAtMs: 200, attemptAtMs: 300 },
      },
      mirrorTradingCashUsd: -100,
    } as any;
    const cfg = {
      statePath,
      journalPath,
      leaderMirror: {
        lossCapAllLanes: false,
      },
    } as any;

    clearBuyOnlyPhantomBag({ cfg, state, mint, nowMs: 600_000 });

    expect(state.open[mint]).toBeUndefined();
    expect(state.mirrorBuyNotify?.[mint]).toBeUndefined();
    expect(state.mirrorTradingCashUsd).toBe(0);
    expect(state.cooldownUntilMs[mint]).toBeUndefined();
    expect(loadMildDipState(statePath).open[mint]).toBeUndefined();
    expect(fs.readFileSync(journalPath, 'utf8')).toContain(
      '"kind":"mirror_buy_only_phantom_bag_cleared"',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
