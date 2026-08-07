import { describe, expect, it } from 'vitest';
import {
  createBuyMintResolver,
  extractMintFromParsedTx,
  logsIndicateBuyOrSell,
  needsBuyMintResolve,
} from '../../src/milddip/buy-mint-resolve.js';
import { extractMintCandidatesFromLogs } from '../../src/scripts/awakening/awakening-mint-from-logs.js';
import type { TxJsonParsed } from '../../src/parser/rpc-http.js';
import { MildDipHotMintBuffer } from '../../src/milddip/hot-mints.js';

const MINT = 'AGbfomctz1Pe9fzNuppVZ6jQrjZecRujyx6qt7egpump';
const PAYER = '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5';
const WSOL = 'So11111111111111111111111111111111111111112';

describe('buy-mint-resolve', () => {
  it('detects Buy logs that need getTx because mint is absent', () => {
    const logs = [
      'Program log: Instruction: Buy',
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success',
    ];
    expect(logsIndicateBuyOrSell(logs)).toBe(true);
    const extracted = extractMintCandidatesFromLogs(logs);
    expect(extracted).toEqual([]);
    expect(needsBuyMintResolve(logs, extracted)).toBe(true);
  });

  it('does not spend getTx budget on Sell-only logs', () => {
    const logs = ['Program log: Instruction: Sell'];
    expect(needsBuyMintResolve(logs, [])).toBe(false);
  });

  it('keeps only newest sigs in a short queue (no 5min backlog)', () => {
    const r = createBuyMintResolver({
      rpcUrl: 'http://127.0.0.1:9',
      maxPerMin: 60,
      concurrency: 1,
      queueMax: 3,
      staleJobMs: 60_000,
    });
    for (let i = 0; i < 10; i++) {
      r.enqueue(`${'1'.repeat(40)}${i}`, Date.now());
    }
    const s = r.stats();
    // One may already be in-flight; waiting queue must stay tiny.
    expect(s.droppedOverflow).toBeGreaterThan(0);
    expect(s.queued).toBeLessThanOrEqual(3);
    r.stop();
  });

  it('extracts mint from fee-payer positive token delta (leader Buy shape)', () => {
    const tx: TxJsonParsed = {
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 3,
            mint: MINT,
            owner: PAYER,
            uiTokenAmount: { uiAmount: 0, decimals: 6, amount: '0' },
          },
          {
            accountIndex: 4,
            mint: WSOL,
            owner: PAYER,
            uiTokenAmount: { uiAmount: 2, decimals: 9, amount: '2000000000' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 3,
            mint: MINT,
            owner: PAYER,
            uiTokenAmount: { uiAmount: 4_349_309.29, decimals: 6, amount: '4349309290000' },
          },
          {
            accountIndex: 4,
            mint: WSOL,
            owner: PAYER,
            uiTokenAmount: { uiAmount: 0.2, decimals: 9, amount: '200000000' },
          },
        ],
      },
      transaction: {
        message: {
          accountKeys: [PAYER, 'SomeProgram1111111111111111111111111111111', MINT],
        },
      },
    };
    expect(extractMintFromParsedTx(tx)).toBe(MINT);
  });

  it('falls back to .pump account key when balances sparse', () => {
    const tx: TxJsonParsed = {
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
      transaction: {
        message: {
          accountKeys: [PAYER, MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
        },
      },
    };
    expect(extractMintFromParsedTx(tx)).toBe(MINT);
  });

  it('buyForce pending drains into force-enrich list', () => {
    const buf = new MildDipHotMintBuffer({ maxMints: 50, ttlMs: 60_000 });
    const now = Date.now();
    buf.note(MINT, now, 8);
    buf.markBuyForce(MINT, now);
    expect(buf.takeForceEnrichBuyResolved(now, 16)).toEqual([MINT]);
    expect(buf.takeForceEnrichBuyResolved(now, 16)).toEqual([]);
  });
});
