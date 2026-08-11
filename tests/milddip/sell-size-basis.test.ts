import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 1.11.831 — the pre-sell balance read has the same staleness as the post-sell
 * one. Live `J7o48eA9q` after the settlement fix: bank_1 settled correctly to
 * 10_954_995_881, then bank_2 asked the chain, still got the pre-bank_1 balance,
 * and burned three `Custom:6024` legs over 11s before the node caught up.
 *
 * The executor sells `min(tokenRawBase, on-chain)`, so a settled `tokenRaw` is a
 * safe cap — but a buy quote's `outAmount` is not, which is why the basis is
 * gated on `tokenRawSettled`.
 */
describe('sell sizing basis', () => {
  const loop = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
  const state = readFileSync(resolve('src/milddip/state.ts'), 'utf8');

  it('passes a settled tokenRaw as the sell cap', () => {
    expect(loop).toContain(
      '...(pos.tokenRawSettled && pos.tokenRaw ? { tokenRawBase: pos.tokenRaw } : {})',
    );
  });

  it('marks tokenRaw settled only after a sell settles', () => {
    expect(loop).toContain('live.tokenRaw = settle.remainingRaw.toString();');
    expect(loop).toContain('live.tokenRawSettled = true;');
  });

  it('clears the flag when the bag grows on scale-in', () => {
    expect(loop).toContain('live.tokenRawSettled = false;');
  });

  it('clears the flag when tokenRaw comes from a bare chain read', () => {
    expect(loop).toContain('state.open[mint]!.tokenRawSettled = false;');
  });

  it('the flag is part of the persisted position', () => {
    expect(state).toContain('tokenRawSettled?: boolean;');
  });
});
