import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';

vi.mock('../src/live/reconcile-live.js', () => ({
  fetchLiveWalletSplBalancesByMint: vi.fn(),
}));

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: vi.fn(),
}));

vi.mock('../src/live/phase4-execution.js', () => ({
  executeLiveTokenToSolPipeline: vi.fn(),
}));

vi.mock('../src/papertrader/pricing.js', () => ({
  fetchJupiterTokenUsdPrice: vi.fn(),
  fetchLatestSnapshotPrice: vi.fn(),
}));

const mint = 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function liveCfg(over: Partial<LiveOscarConfig> = {}): LiveOscarConfig {
  return {
    strategyEnabled: true,
    executionMode: 'live',
    livePostCloseTailSweepDelayMs: 60_000,
    livePostCloseTailSweepMaxAttempts: 3,
    livePostCloseTailSweepRetryMs: 30_000,
    livePostCloseTailSweepMinUsd: 0.05,
    ...over,
  } as LiveOscarConfig;
}

describe('scheduleLivePostCloseTailSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries tail sweep when balance remains after first attempt', async () => {
    const { scheduleLivePostCloseTailSweep, cancelLivePostCloseTailSweepForMint } = await import(
      '../src/live/post-close-tail-sweep.js'
    );
    const { fetchLiveWalletSplBalancesByMint } = await import('../src/live/reconcile-live.js');
    const { appendLiveJsonlEvent } = await import('../src/live/store-jsonl.js');
    const { executeLiveTokenToSolPipeline } = await import('../src/live/phase4-execution.js');
    const { fetchLatestSnapshotPrice } = await import('../src/papertrader/pricing.js');

    vi.mocked(fetchLatestSnapshotPrice).mockResolvedValue(1);
    vi.mocked(executeLiveTokenToSolPipeline).mockResolvedValue({ ok: true } as never);
    vi.mocked(fetchLiveWalletSplBalancesByMint)
      .mockResolvedValueOnce(new Map([[mint, 1_000_000n]]))
      .mockResolvedValueOnce(new Map([[mint, 0n]]));

    scheduleLivePostCloseTailSweep({
      liveCfg: liveCfg(),
      mint,
      symbol: 'ABC',
      decimals: 6,
      priceUsdPerToken: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(executeLiveTokenToSolPipeline).toHaveBeenCalledTimes(1);
    expect(appendLiveJsonlEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'live_post_close_tail', note: 'sweep_ok attempt=1' }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeLiveTokenToSolPipeline).toHaveBeenCalledTimes(1);
    expect(appendLiveJsonlEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'live_post_close_tail', note: 'zero_balance attempt=2' }),
    );

    cancelLivePostCloseTailSweepForMint(mint);
  });

  it('stops after max attempts without further retries', async () => {
    const { scheduleLivePostCloseTailSweep } = await import('../src/live/post-close-tail-sweep.js');
    const { fetchLiveWalletSplBalancesByMint } = await import('../src/live/reconcile-live.js');
    const { executeLiveTokenToSolPipeline } = await import('../src/live/phase4-execution.js');
    const { fetchLatestSnapshotPrice } = await import('../src/papertrader/pricing.js');

    vi.mocked(fetchLatestSnapshotPrice).mockResolvedValue(1);
    vi.mocked(executeLiveTokenToSolPipeline).mockResolvedValue({ ok: true } as never);
    vi.mocked(fetchLiveWalletSplBalancesByMint).mockResolvedValue(new Map([[mint, 1_000_000n]]));

    scheduleLivePostCloseTailSweep({
      liveCfg: liveCfg({ livePostCloseTailSweepMaxAttempts: 2 }),
      mint,
      symbol: 'ABC',
      decimals: 6,
      priceUsdPerToken: 1,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeLiveTokenToSolPipeline).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executeLiveTokenToSolPipeline).toHaveBeenCalledTimes(2);
  });
});
