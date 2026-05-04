/**
 * Live Oscar — periodic stuck-open force exit + chain-only tail sweeps (live).
 */
import type { PaperTraderConfig, TpLadderLevel } from '../papertrader/config.js';
import type { TrackerStats, TrackerArgs } from '../papertrader/executor/tracker.js';
import { trackerForceFullExitLive, trackerPaperCloseReconcileOrphan } from '../papertrader/executor/tracker.js';
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import { WRAPPED_SOL_MINT } from '../papertrader/types.js';
import { getLiveMcUsd } from '../papertrader/pricing.js';
import type { LiveOscarConfig } from './config.js';
import { executeLiveTokenToSolPipeline } from './phase4-execution.js';
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

function lastClosedForMint(closed: ClosedTrade[], mint: string): ClosedTrade | undefined {
  for (let i = closed.length - 1; i >= 0; i--) {
    const c = closed[i];
    if (c?.mint === mint) return c;
  }
  return undefined;
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
    let staleOpensForced = 0;
    let journalWalletZeroClosed = 0;
    let tailSweepsAttempted = 0;
    let tailSweepsOk = 0;
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
          staleOpensForced,
          journalWalletZeroClosed,
          tailSweepsAttempted,
          tailSweepsOk,
          note,
        });
        return;
      }

      const closedMintSeen = new Set(closed.map((c) => c.mint));
      const minUsd = liveCfg.livePeriodicSweepMinUsd;
      const allowUnknown = liveCfg.livePeriodicSweepUnknownChainOnly;

      for (const [mint, rawBal] of chainMap) {
        if (mint === WRAPPED_SOL_MINT || rawBal === 0n) continue;
        if (open.has(mint)) continue;

        const knownFromClosed = closedMintSeen.has(mint);
        if (!allowUnknown && !knownFromClosed) continue;

        const ref = lastClosedForMint(closed, mint);
        const dec = ref?.tokenDecimals ?? 6;
        const mc = await getLiveMcUsd(
          mint,
          ref?.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        if (typeof mc !== 'number' || !Number.isFinite(mc) || mc <= 0) continue;
        const mcUsd = mc;
        const tokens = Number(rawBal) / 10 ** dec;
        const estUsd = tokens * mcUsd;
        if (!(estUsd >= minUsd)) continue;

        tailSweepsAttempted++;
        const sym = ref?.symbol ?? mint.slice(0, 8);
        const res = await executeLiveTokenToSolPipeline(liveCfg, {
          mint,
          symbol: sym,
          usdNotional: Math.max(estUsd, minUsd),
          priceUsdPerToken: mcUsd,
          decimals: dec,
          intentKind: 'sell_full',
        });
        if (res.ok) tailSweepsOk++;
      }

      const stuckThresholdH = paperCfg.timeoutHours + liveCfg.livePeriodicStuckGraceHours;
      const liveOscar = ctx.resolveLiveOscar();
      const phase4 = liveOscar?.tracker;

      const openEntries = [...open.entries()];
      for (const [mint, ot] of openEntries) {
        const ageH = (Date.now() - ot.entryTs) / 3_600_000;
        const bal = chainMap.get(mint) ?? 0n;

        /** Past **`PAPER_TIMEOUT_HOURS`**: if journal still shows open but wallet has no SPL, sync to closed (no Jupiter). */
        if (ageH >= paperCfg.timeoutHours && bal === 0n) {
          await trackerPaperCloseReconcileOrphan({
            mint,
            ot,
            cfg: paperCfg,
            open,
            closed,
            tpLadder: ctx.tpLadder,
            stats: ctx.trackerStats,
            btcCtx: ctx.btcCtx,
            journalAppend: ctx.journalAppend,
            journalLiveStrategy: ctx.journalLiveStrategy,
            liveOscarCfg: liveCfg,
          });
          journalWalletZeroClosed++;
          continue;
        }

        if (!(ageH >= stuckThresholdH) || bal === 0n) continue;

        const mcOpen = await getLiveMcUsd(
          mint,
          ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
        );
        if (typeof mcOpen !== 'number' || !Number.isFinite(mcOpen) || mcOpen <= 0) continue;
        const mcExit = mcOpen;

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
          marketSell: mcExit,
        });
        if (ok) staleOpensForced++;
      }

      appendLiveJsonlEvent({
        kind: 'live_periodic_self_heal',
        ok: true,
        reconcileOk: true,
        staleOpensForced,
        journalWalletZeroClosed,
        tailSweepsAttempted,
        tailSweepsOk,
      });
    } catch (e) {
      note = (e as Error)?.message?.slice(0, 400) ?? 'tick_err';
      appendLiveJsonlEvent({
        kind: 'live_periodic_self_heal',
        ok: false,
        reconcileOk: true,
        staleOpensForced,
        journalWalletZeroClosed,
        tailSweepsAttempted,
        tailSweepsOk,
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
