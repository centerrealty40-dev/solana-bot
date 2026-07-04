import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendTagged } = vi.hoisted(() => ({
  sendTagged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/core/telegram/sender.js', () => ({
  sendTagged,
}));

import {
  __resetBirdeyeTelegramCooldownsForTests,
  handleBirdeyeObservabilityTelegram,
  notifyBirdeyeTierInsufficient,
} from '../src/live/birdeye-telegram-alerts.js';

describe('birdeye telegram alerts', () => {
  beforeEach(() => {
    __resetBirdeyeTelegramCooldownsForTests();
    sendTagged.mockClear();
    process.env.BIRDEYE_TELEGRAM_ENABLED = '1';
    process.env.BIRDEYE_TELEGRAM_BOT_TOKEN = 'test-bot';
    process.env.BIRDEYE_TELEGRAM_CHAT_ID = '-1001';
    process.env.BIRDEYE_TELEGRAM_TIER_COOLDOWN_MS = '0';
  });

  afterEach(() => {
    delete process.env.BIRDEYE_TELEGRAM_ENABLED;
    delete process.env.BIRDEYE_TELEGRAM_BOT_TOKEN;
    delete process.env.BIRDEYE_TELEGRAM_CHAT_ID;
    delete process.env.BIRDEYE_TELEGRAM_TIER_COOLDOWN_MS;
  });

  it('sends tier insufficient ALERT with Russian headline', () => {
    notifyBirdeyeTierInsufficient({
      mint: 'Mint11111111111111111111111111111111111111',
      lane: 'pumpswap',
      errorKind: 'quota',
      surface: 'collector',
    });
    expect(sendTagged).toHaveBeenCalledTimes(1);
    const [, tag, text] = sendTagged.mock.calls[0]!;
    expect(tag).toBe('birdeye_tier_insufficient');
    expect(text).toContain('Birdeye Lite');
    expect(text).toContain('апгрейд');
  });

  it('routes journal row via handleBirdeyeObservabilityTelegram', () => {
    handleBirdeyeObservabilityTelegram({
      kind: 'birdeye_tier_insufficient',
      mint: 'Mint22222222222222222222222222222222222222',
      lane: 'dip',
      errorKind: 'rate_limit',
    });
    expect(sendTagged).toHaveBeenCalledTimes(1);
  });

  it('no-op when BIRDEYE_TELEGRAM_ENABLED is off', () => {
    process.env.BIRDEYE_TELEGRAM_ENABLED = '0';
    notifyBirdeyeTierInsufficient({
      mint: 'Mint33333333333333333333333333333333333333',
      errorKind: 'quota',
    });
    expect(sendTagged).not.toHaveBeenCalled();
  });
});
