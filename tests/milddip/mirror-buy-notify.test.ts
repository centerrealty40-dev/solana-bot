import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  flushMirrorBuyAttemptNotifications,
  formatMirrorBuyAttempt,
  formatMirrorBuySuccess,
  mirrorBuyGmgnUrl,
  notifyMirrorBuyAttemptOnce,
  notifyMirrorBuySuccessOnce,
} from '../../src/milddip/mirror-buy-notify.js';
import { loadMildDipState } from '../../src/milddip/state.js';
import { fetch } from 'undici';

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

  it('uses a short mint for unknown symbols', () => {
    const short = `${mint.slice(0, 6)}…${mint.slice(-4)}`;
    expect(formatMirrorBuySuccess({ mint, symbol: 'unknown', spentUsd: 100 })).toContain(
      `Купил ${short} на $100.00`,
    );
    expect(formatMirrorBuyAttempt({ mint, symbol: ' N/A ', reason: 'no_funds' })).toContain(
      `Была попытка купить ${short} — no_funds`,
    );
  });

  it('drops a pending attempt when the mint is bought before the delay', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-buy-notify-'));
    const statePath = path.join(dir, 'state.json');
    const state = { open: {}, cooldownUntilMs: {}, updatedAtMs: 1 } as any;
    const cfg = {
      statePath,
      journalPath: path.join(dir, 'journal.jsonl'),
      leaderMirror: {
        notifyBuyEnabled: true,
        notifyAttemptDelayMs: 300_000,
        notifyBotToken: 'token',
        notifyChatId: 'chat',
      },
    } as never;
    vi.setSystemTime(1_000);
    await notifyMirrorBuyAttemptOnce({ cfg, state, mint, symbol: 'TEST', reason: 'leader_balance_zero' });
    vi.setSystemTime(2_000);
    await notifyMirrorBuyAttemptOnce({ cfg, state, mint, symbol: 'TEST', reason: 'no_funds' });
    expect(state.mirrorBuyNotify?.[mint]?.attemptPending).toMatchObject({
      firstFailAtMs: 1_000,
      lastFailAtMs: 2_000,
      reason: 'no_funds',
    });
    const pendingLoaded = loadMildDipState(statePath);
    expect(pendingLoaded.mirrorBuyNotify?.[mint]?.attemptPending).toMatchObject({
      firstFailAtMs: 1_000,
      lastFailAtMs: 2_000,
      reason: 'no_funds',
    });
    state.open[mint] = { symbol: 'TEST' };
    await flushMirrorBuyAttemptNotifications({ cfg, state, nowMs: 301_000 });
    expect(state.mirrorBuyNotify?.[mint]?.attemptPending).toBeUndefined();
    expect(state.mirrorBuyNotify?.[mint]?.attemptAtMs).toBeUndefined();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const loaded = loadMildDipState(statePath);
    expect(loaded.mirrorBuyNotify?.[mint]?.attemptPending).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends one delayed attempt with the latest reason and keeps the first failure time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-buy-notify-'));
    const state = { open: {}, cooldownUntilMs: {}, updatedAtMs: 1 } as any;
    const cfg = {
      statePath: path.join(dir, 'state.json'),
      journalPath: path.join(dir, 'journal.jsonl'),
      leaderMirror: {
        notifyBuyEnabled: true,
        notifyAttemptDelayMs: 300_000,
        notifyBotToken: 'token',
        notifyChatId: 'chat',
      },
    } as never;
    vi.mocked(fetch).mockClear();
    vi.setSystemTime(10_000);
    await notifyMirrorBuyAttemptOnce({ cfg, state, mint, symbol: 'unknown', reason: 'first' });
    vi.setSystemTime(20_000);
    await notifyMirrorBuyAttemptOnce({ cfg, state, mint, symbol: 'unknown', reason: 'latest_reason' });
    await flushMirrorBuyAttemptNotifications({ cfg, state, nowMs: 309_999 });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    await flushMirrorBuyAttemptNotifications({ cfg, state, nowMs: 310_000 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.text).toContain('latest_reason');
    expect(body.text).toContain(`${mint.slice(0, 6)}…${mint.slice(-4)}`);
    expect(state.mirrorBuyNotify?.[mint]?.attemptPending).toBeUndefined();
    expect(state.mirrorBuyNotify?.[mint]?.attemptAtMs).toBeTypeOf('number');
    await flushMirrorBuyAttemptNotifications({ cfg, state, nowMs: 610_000 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the open-position symbol when the success symbol is empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-buy-notify-'));
    const state = {
      open: { [mint]: { symbol: 'KNOWN' } },
      cooldownUntilMs: {},
      updatedAtMs: 1,
    } as any;
    const cfg = {
      statePath: path.join(dir, 'state.json'),
      journalPath: path.join(dir, 'journal.jsonl'),
      leaderMirror: {
        notifyBuyEnabled: true,
        notifyBotToken: 'token',
        notifyChatId: 'chat',
      },
    } as never;
    vi.mocked(fetch).mockClear();
    await notifyMirrorBuySuccessOnce({ cfg, state, mint, symbol: '', spentUsd: 50 });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.text).toContain('Купил KNOWN на $50.00');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
