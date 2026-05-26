import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLiveBtcGateStatus } from '../src/live/btc-gate.js';
import type { LiveOscarConfig } from '../src/live/config.js';
import { resetLiveBtcGateTelegramState, tickLiveBtcGateTelegram } from '../src/live/btc-gate-telegram.js';

const pricing = vi.hoisted(() => ({
  btc: {
    ret1h_pct: 0 as number | null,
    ret4h_pct: 0 as number | null,
    updated_ts: Date.now() as number | null,
  },
}));

vi.mock('../src/papertrader/pricing.js', () => ({
  getBtcContext: () => pricing.btc,
  getSolUsd: () => 150,
}));

vi.mock('../src/core/telegram/sender.js', () => ({
  sendTagged: vi.fn(async () => true),
}));

import { sendTagged } from '../src/core/telegram/sender.js';

function liveCfg(): LiveOscarConfig {
  return {
    executionMode: 'live',
    liveBtcGateEnabled: true,
    liveBtcGateMaxStaleMs: 900_000,
    liveBtcBlockNewBuys1hDrawdownPct: 2.5,
    liveBtcBlockNewBuys4hDrawdownPct: 5,
  } as LiveOscarConfig;
}

describe('live btc gate', () => {
  beforeEach(() => {
    resetLiveBtcGateTelegramState();
    pricing.btc = { ret1h_pct: 0, ret4h_pct: 0, updated_ts: Date.now() };
    process.env.LIVE_BTC_GATE_TELEGRAM_ENABLED = '1';
    process.env.LIVE_BTC_GATE_TELEGRAM_BOT_TOKEN = 't';
    process.env.LIVE_BTC_GATE_TELEGRAM_CHAT_ID = 'c';
    vi.mocked(sendTagged).mockClear();
  });

  afterEach(() => {
    delete process.env.LIVE_BTC_GATE_TELEGRAM_BOT_TOKEN;
    delete process.env.LIVE_BTC_GATE_TELEGRAM_CHAT_ID;
  });

  it('blocks new buys when ret1h below threshold', () => {
    pricing.btc.ret1h_pct = -3;
    pricing.btc.ret4h_pct = -1;
    const s = resolveLiveBtcGateStatus(liveCfg());
    expect(s.kind).toBe('blocked');
    if (s.kind === 'blocked') expect(s.limit).toBe('btc_dump_1h');
  });

  it('sends telegram on transition to blocked', async () => {
    const cfg = liveCfg();
    tickLiveBtcGateTelegram(cfg);
    expect(sendTagged).not.toHaveBeenCalled();

    pricing.btc.ret1h_pct = -4;
    tickLiveBtcGateTelegram(cfg);
    await vi.waitFor(() => expect(sendTagged).toHaveBeenCalledTimes(1));
    expect(vi.mocked(sendTagged).mock.calls[0]?.[1]).toBe('live_btc_gate_block');
  });

  it('sends clear telegram when dump ends', async () => {
    const cfg = liveCfg();
    pricing.btc.ret1h_pct = -4;
    tickLiveBtcGateTelegram(cfg);
    await vi.waitFor(() => expect(sendTagged).toHaveBeenCalledTimes(1));

    pricing.btc.ret1h_pct = 0.5;
    pricing.btc.ret4h_pct = 0.5;
    tickLiveBtcGateTelegram(cfg);
    await vi.waitFor(() => expect(sendTagged).toHaveBeenCalledTimes(2));
    expect(vi.mocked(sendTagged).mock.calls[1]?.[1]).toBe('live_btc_gate_clear');
  });
});
