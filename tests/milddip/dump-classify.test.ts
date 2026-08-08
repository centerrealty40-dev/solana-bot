import { describe, expect, it } from 'vitest';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';
import {
  classifyDumpFromPrints,
  createDumpSellTape,
  createGivebackDumpGate,
  extractMintSellPrints,
  type DumpClassifyOpts,
  type DumpSellPrint,
} from '../../src/milddip/dump-classify.js';

const MINT = 'TokenMint1111111111111111111111111111111111';
const W1 = 'WhaleWallet1111111111111111111111111111111';
const W2 = 'SellerTwo111111111111111111111111111111111';
const W3 = 'SellerThree1111111111111111111111111111111';

const opts: DumpClassifyOpts = {
  windowMs: 30_000,
  minSellUsd: 500,
  maxPostResidualFrac: 0.02,
  massMinSellers: 3,
  whaleShare: 0.6,
};

function print(
  seller: string,
  soldUsd: number,
  args?: Partial<DumpSellPrint>,
): DumpSellPrint {
  return {
    mint: MINT,
    signature: args?.signature ?? `sig-${seller}-${soldUsd}`,
    seller,
    soldRaw: BigInt(Math.round(soldUsd * 1e6)),
    soldUsd,
    residualFrac: args?.residualFrac ?? 0,
    emptied: args?.emptied ?? (args?.residualFrac ?? 0) <= 0.02,
    tsMs: args?.tsMs ?? 1_000_000,
  };
}

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
      signatures: ['sigExtract111111111111111111111111111111111'],
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

describe('extractMintSellPrints', () => {
  it('extracts partial and emptied sells', () => {
    const tx = txWithBalances(
      [W1],
      [bal(W1, '1000000000')],
      [bal(W1, '400000000')],
    );
    const prints = extractMintSellPrints(tx, MINT, { priceUsd: 1, tsMs: 1 });
    expect(prints).toHaveLength(1);
    expect(prints[0]!.emptied).toBe(false);
    expect(prints[0]!.soldUsd).toBe(600);
  });
});

describe('classifyDumpFromPrints', () => {
  it('unknown with empty tape', () => {
    expect(classifyDumpFromPrints([], 1_000_000, opts).class).toBe('unknown');
  });

  it('whale_oneshot on emptied large bag', () => {
    const r = classifyDumpFromPrints(
      [print(W1, 2000, { emptied: true, residualFrac: 0 })],
      1_000_000,
      opts,
    );
    expect(r.class).toBe('whale_oneshot');
    expect(r.topEmptied).toBe(true);
  });

  it('whale_oneshot on dominant share', () => {
    const r = classifyDumpFromPrints(
      [
        print(W1, 2000, { emptied: false, residualFrac: 0.5 }),
        print(W2, 200, { emptied: false, residualFrac: 0.5 }),
      ],
      1_000_000,
      opts,
    );
    expect(r.class).toBe('whale_oneshot');
    expect(r.topShare).toBeGreaterThanOrEqual(0.6);
  });

  it('mass_flee when ≥3 sellers', () => {
    const r = classifyDumpFromPrints(
      [
        print(W1, 600, { emptied: false, residualFrac: 0.5 }),
        print(W2, 600, { emptied: false, residualFrac: 0.5 }),
        print(W3, 600, { emptied: false, residualFrac: 0.5 }),
      ],
      1_000_000,
      opts,
    );
    expect(r.class).toBe('mass_flee');
    expect(r.sellers).toBe(3);
  });
});

describe('createGivebackDumpGate', () => {
  it('holds unknown until wait, then allows', () => {
    const g = createGivebackDumpGate();
    const unknown = classifyDumpFromPrints([], 1_000_000, opts);
    const first = g.allowGiveback({
      mint: MINT,
      nowMs: 1_000_000,
      classify: unknown,
      waitMs: 5_000,
      onWhale: () => {
        throw new Error('no whale');
      },
    });
    expect(first.allow).toBe(false);
    expect(first.pending).toBe(true);

    const later = g.allowGiveback({
      mint: MINT,
      nowMs: 1_005_000,
      classify: unknown,
      waitMs: 5_000,
      onWhale: () => {
        throw new Error('no whale');
      },
    });
    expect(later.allow).toBe(true);
    expect(later.class).toBe('unknown');
  });

  it('whale blocks giveback and arms callback', () => {
    const g = createGivebackDumpGate();
    let armed = false;
    const whale = classifyDumpFromPrints(
      [print(W1, 2000, { emptied: true })],
      1_000_000,
      opts,
    );
    const r = g.allowGiveback({
      mint: MINT,
      nowMs: 1_000_000,
      classify: whale,
      waitMs: 5_000,
      onWhale: () => {
        armed = true;
      },
    });
    expect(r.allow).toBe(false);
    expect(r.class).toBe('whale_oneshot');
    expect(armed).toBe(true);
  });

  it('mass_flee allows immediately', () => {
    const g = createGivebackDumpGate();
    const mass = classifyDumpFromPrints(
      [
        print(W1, 600, { emptied: false, residualFrac: 0.4 }),
        print(W2, 600, { emptied: false, residualFrac: 0.4 }),
        print(W3, 600, { emptied: false, residualFrac: 0.4 }),
      ],
      1_000_000,
      opts,
    );
    const r = g.allowGiveback({
      mint: MINT,
      nowMs: 1_000_000,
      classify: mass,
      waitMs: 5_000,
      onWhale: () => {
        throw new Error('no whale');
      },
    });
    expect(r.allow).toBe(true);
    expect(r.class).toBe('mass_flee');
  });
});

describe('createDumpSellTape', () => {
  it('dedupes signature+seller', () => {
    const tape = createDumpSellTape();
    const p = print(W1, 900, { emptied: true, signature: 'same' });
    tape.note(p);
    tape.note(p);
    expect(tape.prints(MINT, 1_000_000, 30_000)).toHaveLength(1);
  });
});
