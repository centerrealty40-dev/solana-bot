/**
 * Live Oscar — periodic stale-open diagnostics plus optional stuck-open force exit (live).
 * Tail sweeps after close are handled only by `post-close-tail-sweep.ts` (short retry window).
 */
import type { PaperTraderConfig, TpLadderLevel } from '../papertrader/config.js';
import type { TrackerStats, TrackerArgs } from '../papertrader/executor/tracker.js';
import { trackerForceFullExitLive } from '../papertrader/executor/tracker.js';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import {
  fetchJupiterTokenUsdPrice,
  fetchLatestSnapshotPrice,
} from '../papertrader/pricing.js';
import type { LiveOscarConfig } from './config.js';
import type { LiveOscarRuntimeBundle } from './phase4-types.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';

export interface LivePeriodicSelfHealFactoryContext {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  getOpen: () => Map<string, OpenTrade>;
  getClosed: () => ClosedTrade[];
  tpLadder: TpLadderLevel[];
  trackerStats: TrackerStats;
  btcCtx: TrackerArgs['btcCtx'];
  journalAppend: TrackerArgs['journalAppend'];
  journalLiveStrategy?: TrackerArgs['journalLiveStrategy'];
  resolveLiveOscar: () => LiveOscarRuntimeBundle | undefined;
  isTrackerBusy: () => boolean;
}

/** Passed from papertrader; `live/main` merges `liveCfg` before calling `startLivePeriodicSelfHeal`. */
export type LivePeriodicSelfHealPaperContext = Omit<LivePeriodicSelfHealFactoryContext, 'liveCfg'>;

/** USD **за 1 токен** (spot). Не путать с `getLiveMcUsd` — там market cap для метаданных. */
async function resolveSpotUsdPerToken(
  mint: string,
  source?: 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap',
): Promise<number | null> {
  const snap = await fetchLatestSnapshotPrice(mint, source);
  if (snap != null && snap > 0 && Number.isFinite(snap)) return snap;
  return fetchJupiterTokenUsdPrice(mint);
}

export function startLivePeriodicSelfHeal(ctx: LivePeriodicSelfHealFactoryContext): NodeJS.Timeout | null {
  const { liveCfg, paperCfg } = ctx;
  if (liveCfg.executionMode !== 'live' || !liveCfg.strategyEnabled) return null;
  const intervalMs = liveCfg.livePeriodicSelfHealMs;
  if (!(intervalMs > 0)) return null;

  let running = false;

  async function runTick(): Promise<void> {
    if (running || ctx.isTrackerBusy()) return;
    running = true;
    let staleOpensObserved = 0;
    let staleOpensForced = 0;
    let staleOpensForceCloseDisabled = 0;
    let note: string | undefined;

    try {
      const open = ctx.getOpen();
      const closed = ctx.getClosed();

      const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
      if (!chainMap) {
        note = 'spl_balance_rpc_null';
        appendLiveJsonlEvent({
          kind: 'live_periodic_self_heal',
          ok: false,
          reconcileOk: true,
          staleOpensObserved,
          staleOpensForced,
          staleOpensForceCloseDisabled,
          tailSweepsAttempted: 0,
          tailSweepsOk: 0,
          note,
        });
        return;
      }

      const stuckThresholdH = paperCfg.timeoutHours + liveCfg.livePeriodicStuckGraceHours;
      const forceCloseEnabled = liveCfg.livePeriodicStuckForceCloseEnabled;
      const liveOscar = forceCloseEnabled ? ctx.resolveLiveOscar() : undefined;
      const phase4 = liveOscar?.tracker;

      const openEntries = [...open.entries()];
      for (const [mint, ot] of openEntries) {
        const ageH = (Date.now() - ot.entryTs) / 3_600_000;
        if (!(ageH >= stuckThresholdH)) continue;
        const bal = chainMap.get(mint);
        if (!bal || bal === 0n) continue;
        staleOpensObserved++;

        if (!forceCloseEnabled) {
          staleOpensForceCloseDisabled++;
          continue;
        }

        const spotExit = await resolveSpotUsdPerToken(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        if (typeof spotExit !== 'number' || !Number.isFinite(spotExit) || spotExit <= 0) continue;

        const ok = await trackerForceFullExitLive({
          cfg: paperCfg,
          open,
          closed,
          tpLadder: ctx.tpLadder,
          stats: ctx.trackerStats,
          btcCtx: ctx.btcCtx,
          journalAppend: ctx.journalAppend,
          journalLiveStrategy: ctx.journalLiveStrategy,
          livePhase4: phase4,
          liveOscarCfg: liveCfg,
          mint,
          marketSell: spotExit,
        });
        if (ok) staleOpensForced++;
      }

      if (staleOpensForceCloseDisabled > 0) {
        note = 'stale_open_force_close_disabled';
      }

      appendLiveJsonlEvent({
        kind: 'live_periodic_self_heal',
        ok: true,
        reconcileOk: true,
        staleOpensObserved,
        staleOpensForced,
        staleOpensForceCloseDisabled,
        tailSweepsAttempted: 0,
        tailSweepsOk: 0,
        note,
      });
    } catch (e) {
      note = (e as Error)?.message?.slice(0, 400) ?? 'tick_err';
      appendLiveJsonlEvent({
        kind: 'live_periodic_self_heal',
        ok: false,
        reconcileOk: true,
        staleOpensObserved,
        staleOpensForced,
        staleOpensForceCloseDisabled,
        tailSweepsAttempted: 0,
        tailSweepsOk: 0,
        note,
      });
    } finally {
      running = false;
    }
  }

  const handle = setInterval(() => {
    void runTick();
  }, intervalMs);
  return handle;
}
