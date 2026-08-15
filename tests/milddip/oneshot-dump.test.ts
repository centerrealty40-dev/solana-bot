import { describe, expect, it } from 'vitest';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';
import {
  createOneshotDumpGraceTracker,
  detectOneshotEmptiedDump,
} from '../../src/milddip/oneshot-dump.js';
import { evaluateMildDipPeakGiveback, type MildDipExitGates } from '../../src/milddip/gates.js';
import { decideMarkExit } from '../../src/milddip/exit-engine.js';
import type { MildDipOpenPosition } from '../../src/milddip/state.js';

const MINT = 'TokenMint1111111111111111111111111111111111';
const SELLER = 'SellerWallet111111111111111111111111111111';
const OTHER = 'OtherWallet1111111111111111111111111111111';

function bal(owner: string, amount: string, decimals = 6) {
  return {
    mint: MINT,
    owner,
    uiTokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals },
  };
}

function txWithBalances(
  signers: string[],
  pre: Array<ReturnType<typeof bal>>,
  post: Array<ReturnType<typeof bal>>,
): TxJsonParsed {
  return {
    transaction: {
      signatures: ['sigOneshotDump111111111111111111111111111111111'],
      message: {
        accountKeys: signers.map((pubkey) => ({ pubkey, signer: true, writable: true })),
      },
    },
    meta: {
      err: null,
      preTokenBalances: pre,
      postTokenBalances: post,
    },
  };
}

describe('detectOneshotEmptiedDump', () => {
  it('fires when seller empties bag and sold USD clears floor', () => {
    // 1e9 raw / 1e6 decimals = 1000 tokens @ $1 = $1000
    const tx = txWithBalances([SELLER], [bal(SELLER, '1000000000')], [bal(SELLER, '0')]);
    const ev = detectOneshotEmptiedDump(
      tx,
      MINT,
      { minSellUsd: 500, maxPostResidualFrac: 0.02 },
      { priceUsd: 1, tsMs: 1_700_000_000_000 },
    );
    expect(ev).not.toBeNull();
    expect(ev!.seller).toBe(SELLER);
    expect(ev!.postRaw).toBe(0n);
    expect(ev!.soldUsd).toBeGreaterThanOrEqual(500);
  });

  it('ignores residual bag (continuing seller)', () => {
    const tx = txWithBalances(
      [SELLER],
      [bal(SELLER, '1000000000')],
      [bal(SELLER, '400000000')],
    );
    const ev = detectOneshotEmptiedDump(
      tx,
      MINT,
      { minSellUsd: 100, maxPostResidualFrac: 0.02 },
      { priceUsd: 1 },
    );
    expect(ev).toBeNull();
  });

  it('allows dust residual ≤ maxPostResidualFrac', () => {
    // 1% left, sold ≈ $990
    const tx = txWithBalances(
      [SELLER],
      [bal(SELLER, '1000000000')],
      [bal(SELLER, '10000000')],
    );
    const ev = detectOneshotEmptiedDump(
      tx,
      MINT,
      { minSellUsd: 100, maxPostResidualFrac: 0.02 },
      { priceUsd: 1 },
    );
    expect(ev).not.toBeNull();
    expect(ev!.residualFrac).toBeLessThanOrEqual(0.02);
  });

  it('ignores dust notional below minSellUsd', () => {
    const tx = txWithBalances([SELLER], [bal(SELLER, '1000')], [bal(SELLER, '0')]);
    const ev = detectOneshotEmptiedDump(
      tx,
      MINT,
      { minSellUsd: 500, maxPostResidualFrac: 0.02 },
      { priceUsd: 1 },
    );
    expect(ev).toBeNull();
  });

  it('accepts emptied bag without price when raw ≥ 1 token', () => {
    const tx = txWithBalances([SELLER], [bal(SELLER, '1000000000')], [bal(SELLER, '0')]);
    const ev = detectOneshotEmptiedDump(
      tx,
      MINT,
      { minSellUsd: 500, maxPostResidualFrac: 0.02 },
      { priceUsd: 0 },
    );
    expect(ev).not.toBeNull();
    expect(ev!.postRaw).toBe(0n);
    expect(ev!.residualFrac).toBe(0);
  });

  it('ignores buys / non-sellers', () => {
    const tx = txWithBalances([OTHER], [bal(OTHER, '0')], [bal(OTHER, '500000')]);
    expect(
      detectOneshotEmptiedDump(
        tx,
        MINT,
        { minSellUsd: 1, maxPostResidualFrac: 0.02 },
        { priceUsd: 1 },
      ),
    ).toBeNull();
  });
});

describe('oneshot dump grace vs exits', () => {
  const gates: MildDipExitGates = {
    armPct: 5,
    partialGivebackPct: 3,
    scaleOutFraction: 0.5,
    givebackPct: 8,
    mfeBankEnabled: false,
    mfeBank1Pct: 8,
    mfeBank1Fraction: 0.4,
    mfeBank2Pct: 15,
    mfeBank2Fraction: 0.4,
    mfeBankSleeveGivebackPct: 12,
    neverArmPatienceMs: 0,
    neverArmMaxHoldMs: 5_400_000,
    neverArmDeadMinMs: 1_800_000,
    neverArmDeadPnlPct: 10,
    neverArmStaleMinMs: 600_000,
    neverArmStaleMaxMfePct: 2,
    neverArmStalePnlPct: 5,
    neverArmVolFadeMinMs: 900_000,
    neverArmVolFadeRatio: 0.25,
    neverArmVolFadeFloorUsd: 300,
    neverArmVolFadeSampleMs: 300_000,
    neverArmVolFadeWeakWindows: 3,
    cliffDumpPnlPct: 0,
    hardStopPnlPct: 15,
    hardStopPartialFraction: 0,
    neverArmBounceMinDumpPct: 8,
    neverArmBouncePct: 8,
    neverArmBounceMinTroughAgeMs: 60_000,
    neverArmBounceRequireRedPct: 3,
    neverArmBouncePartialFraction: 0.5,
    neverArmBounce2Pct: 16,
    mfeBankSleeveLossPartialFraction: 0.5,
    neverArmFreefallPnlPct: 25,
    neverArmFreefallMinMs: 60_000,
    neverArmTimeRedMinMs: 0,
    neverArmTimeRedPnlPct: 5,
    neverArmTimeRedMaxPc5mPct: 0,
  };

  it('defers peak_giveback while grace active', () => {
    const hold = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.8,
      peakPriceUsd: 115,
      armed: true,
      gates,
      oneshotDumpGraceActive: true,
    });
    expect(hold.shouldExit).toBe(false);
    expect(hold.reason).toBeNull();
  });

  it('still fires peak_giveback_partial when grace inactive (half-first)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.8,
      peakPriceUsd: 115,
      armed: true,
      scaleOutDone: false,
      gates,
      oneshotDumpGraceActive: false,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback_partial');
    expect(v.fraction).toBe(0.5);
  });

  it('full peak_giveback after scale-out when grace inactive', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 105.8,
      peakPriceUsd: 115,
      armed: true,
      scaleOutDone: true,
      gates,
      oneshotDumpGraceActive: false,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('peak_giveback');
    expect(v.fraction).toBe(1);
  });

  it('hard_stop still fires under grace when loss bounce off', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 85,
      peakPriceUsd: 115,
      armed: true,
      gates: { ...gates, lossExitMinBouncePct: 0 },
      oneshotDumpGraceActive: true,
    });
    expect(v.shouldExit).toBe(true);
    expect(v.reason).toBe('hard_stop');
  });

  it('hard_stop waits for bounce under grace when prod loss defer on', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 80,
      peakPriceUsd: 115,
      armed: true,
      gates: { ...gates, lossExitMinBouncePct: 12, neverArmBounceMinTroughAgeMs: 60_000 },
      oneshotDumpGraceActive: true,
      postEntryTroughPriceUsd: 80,
      postEntryTroughAtMs: Date.now() - 90_000,
      nowMs: Date.now(),
    });
    expect(v.shouldExit).toBe(false);
  });

  it('deep dump does not cliff under grace (cliff removed 1.11.933)', () => {
    const v = evaluateMildDipPeakGiveback({
      entryPriceUsd: 100,
      markPriceUsd: 40,
      peakPriceUsd: 115,
      armed: true,
      gates: { ...gates, hardStopPnlPct: 0 },
      oneshotDumpGraceActive: true,
    });
    expect(v.reason).not.toBe('cliff_dump');
  });

  it('decideMarkExit respects grace flag', () => {
    const pos: MildDipOpenPosition = {
      mint: MINT,
      symbol: 'T',
      entryPriceUsd: 100,
      peakPriceUsd: 115,
      openedAtMs: Date.now() - 60_000,
      trailArmed: true,
      sizeUsd: 5,
      tokenRaw: '1',
      entryPc5mPct: -10,
      buySignature: null,
    };
    const d = decideMarkExit({
      mint: MINT,
      pos,
      markPriceUsd: 105.8,
      gates,
      oneshotDumpGraceActive: true,
    });
    expect(d?.shouldExit).toBe(false);
  });
});

describe('createOneshotDumpGraceTracker', () => {
  it('notes and expires grace', () => {
    const t = createOneshotDumpGraceTracker();
    const now = 1_000_000;
    t.note(MINT, now, 60_000);
    expect(t.isActive(MINT, now + 1_000)).toBe(true);
    expect(t.isActive(MINT, now + 60_001)).toBe(false);
  });
});
