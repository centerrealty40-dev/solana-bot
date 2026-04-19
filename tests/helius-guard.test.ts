import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Guard must short-circuit when HELIUS_MODE=off, refusing to do any network
 * call regardless of how it's invoked. This is the primary defence against
 * the 2026-04 program-subscription burn.
 */
describe('heliusFetch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws HeliusGuardError(mode_off) when HELIUS_MODE=off', async () => {
    process.env.HELIUS_MODE = 'off';
    process.env.HELIUS_API_KEY = 'test_key';
    const { heliusFetch, HeliusGuardError } = await import('../src/core/helius-guard.js');
    await expect(
      heliusFetch({ url: 'https://api.helius.xyz/v0/webhooks', kind: 'webhook_list' }),
    ).rejects.toBeInstanceOf(HeliusGuardError);
  });

  it('throws HeliusGuardError(no_key) when HELIUS_API_KEY is empty', async () => {
    process.env.HELIUS_MODE = 'wallets';
    process.env.HELIUS_API_KEY = '';
    const { heliusFetch, HeliusGuardError } = await import('../src/core/helius-guard.js');
    await expect(
      heliusFetch({ url: 'https://api.helius.xyz/v0/webhooks', kind: 'webhook_list' }),
    ).rejects.toBeInstanceOf(HeliusGuardError);
  });
});

describe('ensureHeliusWebhook safety checks', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null when HELIUS_MODE=off (no network attempt)', async () => {
    process.env.HELIUS_MODE = 'off';
    process.env.HELIUS_API_KEY = 'test_key';
    process.env.HELIUS_WEBHOOK_URL = 'https://example.com/wh';
    const { ensureHeliusWebhook } = await import('../src/collectors/helius-webhook.js');
    const id = await ensureHeliusWebhook();
    expect(id).toBeNull();
  });
});
