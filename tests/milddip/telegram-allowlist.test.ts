import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTagged } from '../../src/core/telegram/sender.js';

describe('Telegram subtag allowlist', () => {
  afterEach(() => {
    delete process.env.TELEGRAM_ONLY_SUBTAGS;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.unstubAllGlobals();
  });

  it('drops non-listed subtags and sends listed subtags', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    process.env.TELEGRAM_CHAT_ID = 'chat';
    process.env.TELEGRAM_ONLY_SUBTAGS = 'allowed';

    await expect(sendTagged('ALERT', 'blocked', 'text')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(sendTagged('ALERT', 'ALLOWED', 'text')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves sending behavior when the allowlist is unset', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    process.env.TELEGRAM_CHAT_ID = 'chat';

    await expect(sendTagged('ALERT', 'anything', 'text')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
