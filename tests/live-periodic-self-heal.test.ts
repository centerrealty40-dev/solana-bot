import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveOscarConfig } from '../src/live/config.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import type { OpenTrade } from '../src/papertrader/types.js';

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

vi.mock('../src/papertrader/executor/tracker.js', () => ({
  trackerForceFullExitLive: vi.fn(),
}));

const mint = 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function liveCfg(over: Partial<LiveOscarConfig> = {}): LiveOscarConfig {
  return {
    strategyEnabled: true,
    executionMode: 'live',
    profile: 'oscar',
    liveTradesPath: '/tmp/live.jsonl',
    strategyId: 'live-oscar',
    heartbeatIntervalMs: 60_000,
    liveJupiterQuoteTimeoutMs: 5000,
    liveJupiterSwapTimeoutMs: 8000,
    liveDefaultSlippageBps: 400,
    liveSimEnabled: true,
    liveSimTimeoutMs: 12_000,
    liveSimCreditsPerCall: 30,
    liveSimReplaceRecentBlockhash: true,
    liveSimSigVerify: false,
    liveJupiterSwapPriorityLevel: 'medium',
    livePeriodicSelfHealMs: 1000,
    livePeriodicSweepMinUsd: 0.25,
    livePeriodicSweepUnknownChainOnly: false,
    livePeriodicStuckForceCloseEnabled: false,
    livePeriodicStuckGraceHours: 0,
    livePolicyOnlyExitsEnabled: true,
    livePolicyPostHealChurnBlockMs: 0,
    ...over,
  } as LiveOscarConfig;
}

describe('startLivePeriodicSelfHeal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-12T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not force-sell stale live opens by age when force-close is disabled', async () => {
    const { startLivePeriodicSelfHeal } = await import('../src/live/periodic-self-heal.js');
    const { fetchLiveWalletSplBalancesByMint } = await import('../src/live/reconcile-live.js');
    const { appendLiveJsonlEvent } = await import('../src/live/store-jsonl.js');
    const { trackerForceFullExitLive } = await import('../src/papertrader/executor/tracker.js');

    vi.mocked(fetchLiveWalletSplBalancesByMint).mockResolvedValue(new Map([[mint, 1_000_000n]]));
    const open = new Map<string, OpenTrade>([
      [
        mint,
        {
          mint,
          symbol: 'ABC',
          entryTs: Date.now() - 2 * 3_600_000,
          entry: 1,
          qty: 1,
          remainingQty: 1,
          source: 'raydium',
          tokenDecimals: 6,
        } as OpenTrade,
      ],
    ]);
    const resolveLiveOscar = vi.fn();

    const handle = startLivePeriodicSelfHeal({
      liveCfg: liveCfg(),
      paperCfg: { timeoutHours: 1 } as PaperTraderConfig,
      getOpen: () => open,
      getClosed: () => [],
      tpLadder: [],
      trackerStats: { closed: { PERIODIC_HEAL: 0 } } as never,
      btcCtx: undefined,
      journalAppend: vi.fn(),
      resolveLiveOscar,
      isTrackerBusy: () => false,
    });

    await vi.advanceTimersByTimeAsync(1000);
    if (handle) clearInterval(handle);

    expect(resolveLiveOscar).not.toHaveBeenCalled();
    expect(trackerForceFullExitLive).not.toHaveBeenCalled();
    expect(appendLiveJsonlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'live_periodic_self_heal',
        ok: true,
        staleOpensObserved: 1,
        staleOpensForced: 0,
        staleOpensForceCloseDisabled: 1,
        note: 'stale_open_force_close_disabled',
      }),
    );
  });
});
