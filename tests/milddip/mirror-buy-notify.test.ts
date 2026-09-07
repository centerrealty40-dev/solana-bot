import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  formatMirrorBuyAttempt,
  formatMirrorBuySuccess,
  mirrorBuyGmgnUrl,
  notifyMirrorBuyAttemptOnce,
  notifyMirrorBuySuccessOnce,
} from '../../src/milddip/mirror-buy-notify.js';
import { loadMildDipState } from '../../src/milddip/state.js';

vi.mock('undici', () => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

describe('mirror buy notifications', () => {
  const mint = 'So11111111111111111111111111111111111111112';

  it('formats the successful buy with GMGN and mint', () => {
    const text = formatMirrorBuySuccess({ mint, symbol: 'TEST', spentUsd: 100 });
    expect(text).toContain('Купил TEST на $100.00');
    expect(text).toContain(`<a href="${mirrorBuyGmgnUrl(mint)}">GMGN</a>`);
    expect(text).toContain(`<code>${mint}</code>`);
  });

  it('formats a failed attempt distinctly', () => {
    const text = formatMirrorBuyAttempt({
      mint,
      symbol: 'TEST',
      reason: 'insufficient_funds',
    });
    expect(text).toContain('Была попытка купить TEST — insufficient_funds');
    expect(text).toContain(`https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`);
    expect(text).not.toContain('Купил TEST');
  });

  it('deduplicates attempts and persists notification marks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-buy-notify-'));
    const statePath = path.join(dir, 'state.json');
    const state = { open: {}, cooldownUntilMs: {}, updatedAtMs: 1 };
    const cfg = {
      statePath,
      journalPath: path.join(dir, 'journal.jsonl'),
      leaderMirror: {
        notifyBuyEnabled: true,
        notifyBotToken: 'token',
        notifyChatId: 'chat',
      },
    } as never;
    await notifyMirrorBuyAttemptOnce({ cfg, state, mint, symbol: 'TEST', reason: 'no_funds' });
    await notifyMirrorBuyAttemptOnce({ cfg, state, mint, symbol: 'TEST', reason: 'no_funds' });
    await notifyMirrorBuySuccessOnce({ cfg, state, mint, symbol: 'TEST', spentUsd: 100 });
    expect(state.mirrorBuyNotify?.[mint]?.attemptAtMs).toBeTypeOf('number');
    expect(state.mirrorBuyNotify?.[mint]?.buyAtMs).toBeTypeOf('number');
    const loaded = loadMildDipState(statePath);
    expect(loaded.mirrorBuyNotify?.[mint]?.attemptAtMs).toBeTypeOf('number');
    expect(loaded.mirrorBuyNotify?.[mint]?.buyAtMs).toBeTypeOf('number');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
