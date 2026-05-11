import pino from 'pino';
import {
  loadPaperTraderConfig,
  parseDcaLevels,
  parseFollowupOffsets,
  parseTpLadder,
} from './config.js';
import { configureStore, appendEvent } from './store-jsonl.js';
import type { LiveOscarRuntimeBundle, LiveOscarStrategyDeps } from '../live/phase4-types.js';
import {
  refreshSolPrice,
  getSolUsd,
  refreshBtcContext,
  getBtcContext,
  getLiveMcUsd,
} from './pricing.js';
import { startPriorityFeeTicker, stopPriorityFeeTicker, getPriorityFeeUsd } from './pricing/priority-fee.js';
import { verifyEntryPrice } from './pricing/price-verify.js';
import { resolveTpRegimeForOpen } from './pricing/tp-regime.js';
import { runOpenSimAudit } from './pricing/sim-audit.js';
import { runImpulseConfirmGate, takeImpulseJupiterReuse } from './pricing/impulse-confirm.js';
import {
  evaluatedAtMap,
  lastEntryTsByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
  recordEntryTs,
  recordLastExitMarketSnapshotAfterClose,
  runDipDiscovery,
  type EvalDecision,
} from './discovery/dip-clones.js';
import { gmgnMintHrefHtml, isAwaitingDipQualityHold } from './discovery/near-ready-dip-watch.js';
import { updateNearReadyDipWatchlist } from './discovery-health-window.js';
import { runSmartLotteryDiscovery } from './discovery/smart-lottery.js';
import { fetchLaunchpadCandidates } from './discovery/launchpad.js';
import { fetchFreshValidatedCandidates } from './discovery/fresh-validated.js';
import { makeOpenTradeFromEntry, snapshotSourceToDex } from './executor/open.js';
import { fetchPreEntryDynamics } from './executor/dynamics.js';
import { fetchContextSwaps } from './executor/context-swaps.js';
import { followupTick, schedulePendingFollowups, pendingFollowupsCount } from './executor/followup.js';
import {
  trackerTick,
  finalizeLiveCapitalRotatePaperClose,
  type TrackerStats,
} from './executor/tracker.js';
import { reconcileOpenTradeDcaFromLegs } from './executor/dca-state.js';
import { loadStore } from './executor/store-restore.js';
import type {
  ClosedTrade,
  ExitReason,
  OpenTrade,
  PriceVerifyVerdict,
  SafetyVerdict,
  SimAuditStamp,
} from './types.js';
import { isMintBlockedForAmbiguousLiveBuy } from '../live/pending-buy-cooldown.js';
import { isMintPermanentlyDeniedLiveOscar } from '../live/mint-permanent-denylist.js';
import { isMintOnLiveWhitelist, notifyLiveMintWhitelistSkip } from '../live/mint-whitelist.js';
import { isMintBlacklisted } from './discovery/mint-blacklist-file.js';
import type { LivePeriodicSelfHealPaperContext } from '../live/periodic-self-heal.js';
import { applyLiveBuyAnchorsAfterOpen } from '../live/live-buy-anchor.js';
import { scheduleSignalLabPreBuyOpen } from '../live/signal-lab.js';
import { serializeOpenTrade } from '../live/strategy-snapshot.js';
import { cancelLivePostCloseTailSweepForMint } from '../live/post-close-tail-sweep.js';
import { evaluateMintSafety } from './safety/index.js';
import { getHoldersResolveStats } from './holders/holders-resolve.js';
import {
  isPaperOscarIdealizedStackStrategyId,
  isPaperOscarFamilyStrategyId,
  usesPaperOscarSecondLegScaleIn,
} from './paper-oscar-v21.js';
import { readPaperOscarScaleInEnv } from './executor/paper-scale-in-env.js';
import { recordDiscoveryHealthSample } from './discovery-health-window.js';
import { sendTagged } from '../core/telegram/sender.js';

const logger = pino({ name: 'papertrader' });

function escapeHtmlPlain(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtUsdCompact(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtCount(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 'n/a';
  return Math.round(n).toLocaleString('en-US');
}

export interface PapertraderMainOptions {
  /** Default: paper JSONL `appendEvent`. Live-oscar mirrors discovery audit rows via `discovery-audit-jsonl.ts`. */
  journalAppend?: (event: Record<string, unknown>) => void;
  /** Live-oscar: do not read/write paper store path. */
  skipPaperJsonlStore?: boolean;
  liveOscar?: LiveOscarRuntimeBundle;
  /** Phase 5 — bundle needs live open/closed maps; preferred over `liveOscar` when both set. */
  liveOscarFactory?: (deps: LiveOscarStrategyDeps) => LiveOscarRuntimeBundle;
  /** Phase 7 — seed from live JSONL replay (`live-oscar` + `skipPaperJsonlStore`). */
  liveStrategyReplay?: { open: Map<string, OpenTrade>; closed: ClosedTrade[] };
  /** Phase 7 — validated live JSONL mirror events (`live_position_*`). */
  journalLiveStrategy?: (event: Record<string, unknown>) => void;
  /** Live: tracker tick — opens with zero on-chain SPL balance → RECONCILE_ORPHAN (see `tracker.ts`). */
  reconcilePaperCloseZeroMints?: (
    open: Map<string, OpenTrade>,
  ) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** Live: SPL re-read before orphan close — avoid false orphan on transient RPC/indexer empty reads. */
  verifyReconcileOrphanWalletZero?: (mint: string) => Promise<boolean>;
  /** Optional: min age since `entryTs` before RECONCILE_ORPHAN paper-close (live integrations). */
  reconcileOrphanMinPositionAgeMs?: number;
  onShutdown?: (signal: string) => void;
  /**
   * Live-oscar only: periodic tail sweep + stuck-open force exit (`live/main` closes over `liveCfg`).
   */
  livePeriodicSelfHealFactory?: (
    ctx: LivePeriodicSelfHealPaperContext,
  ) => ReturnType<typeof setInterval> | null;

  /**
   * Live-oscar: override paper `PAPER_HEARTBEAT_INTERVAL_MS` for JSONL + `onOscarHeartbeat` cadence.
   */
  heartbeatIntervalMsOverride?: number;

  onOscarHeartbeat?: (payload: {
    openPositions: number;
    closedTotal: number;
      stats: {
      discovered: number;
      evaluated: number;
      passed: number;
      opened: number;
      skippedSafety: number;
      skippedPriceVerify: number;
      skippedLiveMintWhitelist: number;
      skippedLivePermanentDeny: number;
      ticks: number;
      errors: number;
    };
    trackerClosed: TrackerStats['closed'];
  }) => void;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

export async function main(opts?: PapertraderMainOptions): Promise<void> {
  const cfg = loadPaperTraderConfig();
  logger.info(
    {
      strategyId: cfg.strategyId,
      tpX: cfg.tpX,
      slX: cfg.slX,
      dcaKillstop: cfg.dcaKillstop,
      timeoutHours: cfg.timeoutHours,
      trailMode: cfg.trailMode,
      trailTriggerX: cfg.trailTriggerX,
      trailDrop: cfg.trailDrop,
    },
    'papertrader resolved exit thresholds (audit SL/KILLSTOP/TIMEOUT/TRAIL)',
  );
  const journalAppend =
    opts?.journalAppend ??
    ((e: Record<string, unknown>) => {
      appendEvent(e as never);
    });
  const journalLiveStrategy = opts?.journalLiveStrategy;

  if (!opts?.skipPaperJsonlStore) {
    configureStore({ storePath: cfg.storePath, strategyId: cfg.strategyId });
  }

  void fetchLaunchpadCandidates;
  void fetchFreshValidatedCandidates;

  const dcaLevels = parseDcaLevels(cfg.dcaLevelsSpec);
  const tpLadder = cfg.tpGridStepPnl > 0 ? [] : parseTpLadder(cfg.tpLadderSpec);
  const followupOffsets = parseFollowupOffsets(cfg.followupOffsetsMinSpec);

  const restored = opts?.skipPaperJsonlStore
    ? {
        evaluatedAt: new Map<string, number>(),
        lastEntryTsByMint: new Map<string, number>(),
        lastPostExitBuyCooldownTsByMint: new Map<string, number>(),
        open: new Map<string, OpenTrade>(),
      }
    : loadStore(cfg.storePath);
  for (const [mint, ts] of restored.evaluatedAt) evaluatedAtMap.set(mint, ts);
  for (const [mint, ts] of restored.lastEntryTsByMint) lastEntryTsByMintMap.set(mint, ts);
  for (const [mint, ts] of restored.lastPostExitBuyCooldownTsByMint) {
    lastPostExitBuyCooldownTsByMintMap.set(mint, ts);
  }
  if (opts?.skipPaperJsonlStore && opts.liveStrategyReplay?.closed?.length) {
    for (const ct of opts.liveStrategyReplay.closed) {
      if (!(ct.exitTs > 0)) continue;
      const prev = lastPostExitBuyCooldownTsByMintMap.get(ct.mint) ?? 0;
      if (ct.exitTs >= prev) lastPostExitBuyCooldownTsByMintMap.set(ct.mint, ct.exitTs);
      const px =
        ct.theoretical_exit_price > 0 ? ct.theoretical_exit_price : ct.effective_exit_price;
      recordLastExitMarketSnapshotAfterClose(ct.mint, ct.exitTs, px);
    }
  }
  const open: Map<string, OpenTrade> =
    opts?.skipPaperJsonlStore && opts.liveStrategyReplay ? opts.liveStrategyReplay.open : restored.open;
  for (const ot of open.values()) {
    reconcileOpenTradeDcaFromLegs(ot, dcaLevels);
  }
  const closed: ClosedTrade[] =
    opts?.skipPaperJsonlStore && opts.liveStrategyReplay ? [...opts.liveStrategyReplay.closed] : [];
  const stagedEntrySignals = new Map<
    string,
    {
      signalTs: number;
      signalPriceUsd: number;
      signalMarketCapUsd: number | null;
      holderCount: number | null;
      expiresAt: number;
    }
  >();

  function liveStagedEntryActive(): boolean {
    return cfg.strategyId === 'live-oscar' && cfg.liveStagedEntryEnabled;
  }

  function notifyLiveStagedEntrySignal(args: {
    mint: string;
    symbol: string;
    marketCapUsd: number | null;
    holderCount: number | null;
  }): void {
    const token =
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) {
      logger.warn({ mint: args.mint }, 'live staged-entry signal telegram skipped: bot token/chat missing');
      return;
    }

    const symbol = args.symbol?.trim() || '?';
    const text =
      `<b>Live Oscar signal</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(args.mint, args.mint)}\n` +
      `Market cap: <b>${escapeHtmlPlain(fmtUsdCompact(args.marketCapUsd))}</b>\n` +
      `Holders: <b>${escapeHtmlPlain(fmtCount(args.holderCount))}</b>\n` +
      `Начинаем отсчёт входа: −7% / −14% от цены сигнала`;

    void sendTagged('ADVICE', 'live_oscar_staged_signal', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }).catch((e) =>
      logger.warn({ err: String(e), mint: args.mint }, 'live staged-entry signal telegram failed'),
    );
  }

  function notifyLiveOscarRiskyEntrySignal(args: {
    mint: string;
    symbol: string;
    marketCapUsd: number | null;
    holderCount: number | null;
  }): void {
    const token =
      process.env.LIVE_RISKY_ENTRY_SIGNAL_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_RISKY_ENTRY_SIGNAL_TELEGRAM_CHAT_ID?.trim() ||
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) {
      logger.warn({ mint: args.mint }, 'live-oscar-risky signal telegram skipped: bot token/chat missing');
      return;
    }

    const symbol = args.symbol?.trim() || '?';
    const text =
      `<b>Live Oscar Risky signal</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(args.mint, args.mint)}\n` +
      `Market cap: <b>${escapeHtmlPlain(fmtUsdCompact(args.marketCapUsd))}</b>\n` +
      `Holders: <b>${escapeHtmlPlain(fmtCount(args.holderCount))}</b>\n` +
      `Кандидат прошёл первичные гейты; ждём recheck перед покупкой.`;

    void sendTagged('ADVICE', 'live_oscar_risky_entry_signal', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }).catch((e) =>
      logger.warn({ err: String(e), mint: args.mint }, 'live-oscar-risky signal telegram failed'),
    );
  }

  function resolveLiveStagedEntrySignal(args: {
    mint: string;
    symbol: string;
    lane: string;
    source?: string;
    currentPriceUsd: number;
    marketCapUsd: number | null;
    holderCount: number | null;
  }): { ok: true; signalTs: number; signalPriceUsd: number } | { ok: false } {
    if (!liveStagedEntryActive()) return { ok: true, signalTs: Date.now(), signalPriceUsd: args.currentPriceUsd };
    const now = Date.now();
    const existing = stagedEntrySignals.get(args.mint);
    const signal =
      existing && existing.expiresAt > now
        ? existing
        : {
            signalTs: now,
            signalPriceUsd: args.currentPriceUsd,
            signalMarketCapUsd: args.marketCapUsd,
            holderCount: args.holderCount,
            expiresAt: now + cfg.liveStagedEntrySignalTtlMs,
          };
    if (!existing || existing.expiresAt <= now) {
      stagedEntrySignals.set(args.mint, signal);
      journalLiveStrategy?.({
        kind: 'live_staged_entry_signal',
        mint: args.mint,
        symbol: args.symbol,
        lane: args.lane,
        source: args.source,
        signalPriceUsd: signal.signalPriceUsd,
        signalMarketCapUsd: signal.signalMarketCapUsd,
        holderCount: signal.holderCount,
        firstDropPct: cfg.liveStagedEntryFirstDropPct,
        firstTargetUsd: signal.signalPriceUsd * (1 - cfg.liveStagedEntryFirstDropPct / 100),
        expiresAt: signal.expiresAt,
      });
      notifyLiveStagedEntrySignal({
        mint: args.mint,
        symbol: args.symbol,
        marketCapUsd: signal.signalMarketCapUsd,
        holderCount: signal.holderCount,
      });
    }

    const firstTargetUsd = signal.signalPriceUsd * (1 - cfg.liveStagedEntryFirstDropPct / 100);
    if (args.currentPriceUsd > firstTargetUsd) {
      journalAppend({
        kind: 'eval-skip-open',
        lane: args.lane,
        source: args.source,
        mint: args.mint,
        symbol: args.symbol,
        reason: `staged_entry_wait_first_leg_${cfg.liveStagedEntryFirstDropPct}%`,
        stagedEntry: {
          signalPriceUsd: signal.signalPriceUsd,
          currentPriceUsd: args.currentPriceUsd,
          firstTargetUsd,
          expiresAt: signal.expiresAt,
        },
      });
      return { ok: false };
    }

    stagedEntrySignals.delete(args.mint);
    return { ok: true, signalTs: signal.signalTs, signalPriceUsd: signal.signalPriceUsd };
  }

  let liveOscarResolved = false;
  let cachedLiveOscar: LiveOscarRuntimeBundle | undefined;
  function resolveLiveOscar(): LiveOscarRuntimeBundle | undefined {
    if (liveOscarResolved) return cachedLiveOscar;
    liveOscarResolved = true;
    if (opts?.liveOscarFactory) {
      cachedLiveOscar = opts.liveOscarFactory({
        getOpen: () => open,
        getClosed: () => closed,
        finalizeCapitalRotatePaperClose: async (mint, marketSellPx, liveOscarCfg) => {
          await finalizeLiveCapitalRotatePaperClose({
            cfg,
            mint,
            marketSellPx,
            open,
            closed,
            stats: trackerStats,
            tpLadder,
            journalAppend,
            journalLiveStrategy: opts?.journalLiveStrategy,
            btcCtx: getBtcContext,
            liveOscarCfg,
          });
        },
      });
      return cachedLiveOscar;
    }
    cachedLiveOscar = opts?.liveOscar;
    return cachedLiveOscar;
  }

  const startedAt = Date.now();
  const stats = {
    discovered: 0,
    evaluated: 0,
    passed: 0,
    opened: 0,
    skippedSafety: 0,
    skippedPriceVerify: 0,
    skippedLiveMintWhitelist: 0,
    skippedLivePermanentDeny: 0,
    ticks: 0,
    errors: 0,
  };
  const trackerStats: TrackerStats = {
    closed: {
      TP: 0,
      SL: 0,
      TRAIL: 0,
      TIMEOUT: 0,
      NO_DATA: 0,
      KILLSTOP: 0,
      LIQ_DRAIN: 0,
      RECONCILE_ORPHAN: 0,
      PERIODIC_HEAL: 0,
      CAPITAL_ROTATE: 0,
    } as Record<ExitReason, number>,
    skippedPriceVerifyExit: 0,
  };

  type PendingEntryRecheck = {
    mint: string;
    symbol: string;
    lane: EvalDecision['lane'];
    source: string;
    signalTs: number;
    dueTs: number;
    signalPriceUsd: number;
  };

  const entryRecheckPending = new Map<string, PendingEntryRecheck>();
  const entryRecheckEnabled = cfg.strategyId === 'live-oscar-risky' && cfg.entryRecheckDelayMs > 0;
  const entryRecheckStaleMs = Math.max(cfg.entryRecheckDelayMs * 3, cfg.entryRecheckDelayMs + 30 * 60_000);

  function cleanupStaleEntryRechecks(now: number): void {
    if (!entryRecheckEnabled || entryRecheckPending.size === 0) return;
    for (const [mint, p] of entryRecheckPending) {
      if (now - p.dueTs > entryRecheckStaleMs || open.has(mint)) {
        entryRecheckPending.delete(mint);
      }
    }
  }

  function handleFailedEntryRecheckDecision(d: EvalDecision, now: number): boolean {
    if (!entryRecheckEnabled) return false;
    const pending = entryRecheckPending.get(d.mint);
    if (!pending || now < pending.dueTs) return false;
    entryRecheckPending.delete(d.mint);
    journalAppend({
      kind: 'eval-skip-open',
      lane: d.lane,
      source: d.source,
      mint: d.mint,
      symbol: d.symbol,
      reason: 'entry_recheck:gate_failed_after_delay',
      entryRecheck: {
        signalTs: pending.signalTs,
        dueTs: pending.dueTs,
        delayMs: cfg.entryRecheckDelayMs,
        signalPriceUsd: pending.signalPriceUsd,
        recheckPass: false,
        recheckReasons: d.reasons,
      },
    });
    journalLiveStrategy?.({
      kind: 'entry_recheck_skip',
      mint: d.mint,
      symbol: d.symbol,
      reason: 'gate_failed_after_delay',
      recheckReasons: d.reasons,
    });
    return true;
  }

  function handlePassedEntryRecheckDecision(d: EvalDecision, now: number): boolean {
    if (!entryRecheckEnabled) return true;
    if (open.has(d.mint)) {
      entryRecheckPending.delete(d.mint);
      return false;
    }

    const currentPriceUsd = Number(d.features.price_usd);
    const pending = entryRecheckPending.get(d.mint);
    if (!pending) {
      if (!(currentPriceUsd > 0)) return false;
      const next: PendingEntryRecheck = {
        mint: d.mint,
        symbol: d.symbol,
        lane: d.lane,
        source: d.source,
        signalTs: now,
        dueTs: now + cfg.entryRecheckDelayMs,
        signalPriceUsd: currentPriceUsd,
      };
      entryRecheckPending.set(d.mint, next);
      journalAppend({
        kind: 'eval-skip-open',
        lane: d.lane,
        source: d.source,
        mint: d.mint,
        symbol: d.symbol,
        reason: 'entry_recheck:pending',
        entryRecheck: {
          signalTs: next.signalTs,
          dueTs: next.dueTs,
          delayMs: cfg.entryRecheckDelayMs,
          signalPriceUsd: next.signalPriceUsd,
          minChangePct: cfg.entryRecheckMinChangePct,
          maxChangePct: cfg.entryRecheckMaxChangePct,
        },
      });
      journalLiveStrategy?.({
        kind: 'entry_recheck_pending',
        mint: d.mint,
        symbol: d.symbol,
        dueTs: next.dueTs,
        signalPriceUsd: next.signalPriceUsd,
        minChangePct: cfg.entryRecheckMinChangePct,
        maxChangePct: cfg.entryRecheckMaxChangePct,
      });
      notifyLiveOscarRiskyEntrySignal({
        mint: d.mint,
        symbol: d.symbol,
        marketCapUsd: d.features.market_cap_usd ?? null,
        holderCount: d.features.holders ?? null,
      });
      return false;
    }

    if (now < pending.dueTs) return false;

    const changePct = pending.signalPriceUsd > 0 ? (currentPriceUsd / pending.signalPriceUsd - 1) * 100 : NaN;
    const priceOk =
      Number.isFinite(changePct) &&
      changePct >= cfg.entryRecheckMinChangePct &&
      changePct <= cfg.entryRecheckMaxChangePct;

    entryRecheckPending.delete(d.mint);
    const stamp = {
      signalTs: pending.signalTs,
      dueTs: pending.dueTs,
      delayMs: cfg.entryRecheckDelayMs,
      signalPriceUsd: pending.signalPriceUsd,
      recheckPriceUsd: currentPriceUsd,
      changePct: Number.isFinite(changePct) ? +changePct.toFixed(3) : null,
      minChangePct: cfg.entryRecheckMinChangePct,
      maxChangePct: cfg.entryRecheckMaxChangePct,
    };

    if (!priceOk) {
      journalAppend({
        kind: 'eval-skip-open',
        lane: d.lane,
        source: d.source,
        mint: d.mint,
        symbol: d.symbol,
        reason: 'entry_recheck:price_out_of_band',
        entryRecheck: stamp,
      });
      journalLiveStrategy?.({
        kind: 'entry_recheck_skip',
        mint: d.mint,
        symbol: d.symbol,
        reason: 'price_out_of_band',
        ...stamp,
      });
      return false;
    }

    journalLiveStrategy?.({
      kind: 'entry_recheck_pass',
      mint: d.mint,
      symbol: d.symbol,
      ...stamp,
    });
    return true;
  }

  logger.info({
    msg: 'papertrader executor start',
    strategyId: cfg.strategyId,
    strategyKind: cfg.strategyKind,
    storePath: cfg.storePath,
    positionUsd: cfg.positionUsd,
    dryRun: cfg.dryRun,
    whaleEnabled: cfg.whaleEnabled,
    dcaLevels: dcaLevels.length,
    tpLadder: tpLadder.length,
    tpGridStepPnl: cfg.tpGridStepPnl,
    followupOffsets,
    tpX: cfg.tpX,
    slX: cfg.slX,
    trailDrop: cfg.trailDrop,
    trailTriggerX: cfg.trailTriggerX,
    trailMode: cfg.trailMode,
    timeoutHours: cfg.timeoutHours,
    restoredOpen: open.size,
    safetyCheckEnabled: cfg.safetyCheckEnabled,
    priorityFeeEnabled: cfg.priorityFeeEnabled,
    entryRecheck: entryRecheckEnabled
      ? {
          delayMs: cfg.entryRecheckDelayMs,
          minChangePct: cfg.entryRecheckMinChangePct,
          maxChangePct: cfg.entryRecheckMaxChangePct,
        }
      : { enabled: false },
    holdersLive: cfg.holdersLiveEnabled
      ? {
          enabled: true,
          minHolderCount: cfg.globalMinHolderCount,
          ttlMs: cfg.holdersTtlMs,
          maxPerTick: cfg.holdersMaxPerTick,
          includeToken2022: cfg.holdersIncludeToken2022,
          onFail: cfg.holdersOnFail,
          dbWriteback: cfg.holdersDbWriteback,
          useAddon: cfg.holdersUseQnAddon,
        }
      : { enabled: false },
    impulseConfirm: cfg.impulseConfirmEnabled
      ? {
          enabled: true,
          dipPolicy: cfg.impulseDipPolicy,
          pgDropPct: cfg.impulsePgMinDropPct,
          dipPolicyDetail: cfg.impulsePgAbsMode ? `abs>=${cfg.impulsePgMinAbsPct}%` : undefined,
        }
      : { enabled: false },
  });

  await Promise.allSettled([refreshSolPrice(), refreshBtcContext(cfg)]);
  startPriorityFeeTicker(cfg);

  async function discoveryTick(): Promise<void> {
    stats.ticks++;
    try {
      const tickNow = Date.now();
      cleanupStaleEntryRechecks(tickNow);
      if (cfg.strategyKind !== 'dip' && cfg.strategyKind !== 'smart_lottery') return;
      const res =
        cfg.strategyKind === 'dip'
          ? await runDipDiscovery(cfg)
          : await runSmartLotteryDiscovery(cfg);
      for (const row of res.auditRows ?? []) {
        journalAppend(row);
      }
      stats.discovered += res.discovered;
      stats.evaluated += res.evaluated;
      stats.passed += res.passed;
      if (cfg.strategyId === 'live-oscar') {
        const near = res.decisions.filter((d) => !d.pass && isAwaitingDipQualityHold(d.reasons));
        updateNearReadyDipWatchlist(near.map((d) => ({ mint: d.mint, symbol: d.symbol ?? '?' })));
      }
      const openedBeforeDiscoveryBatch = stats.opened;
      const btc = getBtcContext();
      for (const d of res.decisions) {
        const deepAuditFlag =
          cfg.discoveryDeepAuditJsonl === true &&
          Boolean(cfg.discoveryDeepAuditWhitelistMintSet?.has(d.mint));
        journalAppend({
          kind: 'eval',
          lane: d.lane,
          source: d.source,
          mint: d.mint,
          symbol: d.symbol,
          ageMin: d.ageMin,
          pass: d.pass,
          reasons: d.reasons,
          m: d.features,
          btc,
          whale_analysis: d.whale,
          holders_meta: d.holdersMeta ?? null,
          entry_path: d.entryPath,
          _liveDiscoveryDeepAudit: deepAuditFlag,
        });
        if (!d.pass && handleFailedEntryRecheckDecision(d, tickNow)) continue;
        if (!d.pass) continue;
        if (
          cfg.mintBlacklistEnabled &&
          cfg.mintBlacklistPath?.trim() &&
          isMintBlacklisted(cfg.mintBlacklistPath.trim(), d.mint)
        ) {
          continue;
        }
        if (open.has(d.mint)) {
          journalAppend({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            reason: 'already_open',
          });
          continue;
        }
        if (resolveLiveOscar() && isMintBlockedForAmbiguousLiveBuy(d.mint)) {
          opts?.journalLiveStrategy?.({
            kind: 'execution_skip',
            reason: 'live_ambiguous_buy_cooldown:discovery',
            detail: d.mint.slice(0, 12),
          });
          continue;
        }
        if (cfg.dryRun && !resolveLiveOscar()) continue;
        if (!handlePassedEntryRecheckDecision(d, tickNow)) continue;
        const stagedEntrySignal = resolveLiveStagedEntrySignal({
          mint: d.mint,
          symbol: d.symbol,
          lane: d.lane,
          source: d.source,
          currentPriceUsd: d.features.price_usd,
          marketCapUsd: d.features.market_cap_usd ?? null,
          holderCount: d.features.holders ?? null,
        });
        if (!stagedEntrySignal.ok) continue;

        const dex = snapshotSourceToDex(d.source);
        const row = {
          mint: d.mint,
          symbol: d.symbol,
          ts: new Date(),
          launch_ts: null,
          age_min: d.ageMin,
          price_usd: d.features.price_usd,
          liquidity_usd: d.features.liq_usd,
          volume_5m: d.features.vol5m_usd,
          volume_1h: d.features.vol1h_usd ?? 0,
          buys_5m: d.features.buys5m,
          sells_5m: d.features.sells5m,
          market_cap_usd: d.features.market_cap_usd,
          source: d.source,
          holder_count: d.features.holders,
          token_age_min: d.features.token_age_min,
          pair_address: d.features.pair_address ?? null,
        };
        let ot = makeOpenTradeFromEntry({
          cfg,
          row,
          lane: d.lane,
          dex,
          liquidityUsd: d.features.liq_usd,
        });
        if (liveStagedEntryActive()) {
          ot.liveStagedEntry = {
            signalTs: stagedEntrySignal.signalTs,
            signalPriceUsd: stagedEntrySignal.signalPriceUsd,
            firstDropPct: cfg.liveStagedEntryFirstDropPct,
            firstLegUsd: cfg.liveStagedEntryFirstLegUsd,
            secondDropPct: cfg.liveStagedEntrySecondDropPct,
            secondLegUsd: cfg.liveStagedEntrySecondLegUsd,
            killDropPct: cfg.liveStagedEntryKillDropPct,
            secondLegDone: false,
          };
        }

        const preDyn = cfg.preEntryDynamicsEnabled
          ? await fetchPreEntryDynamics(d.mint, ot.entryTs)
          : null;
        const ctxSwaps = await fetchContextSwaps(cfg, d.mint, ot.entryTs);

        let safetyAttached: SafetyVerdict | { skipped: string } | null = null;
        if (cfg.safetyCheckEnabled) {
          const isAmm = ot.metricType !== 'mc';
          const outcome = await evaluateMintSafety(d.mint, {
            topHolderMaxPct: cfg.safetyTopHolderMaxPct,
            requireMintAuthorityNull: cfg.safetyRequireMintAuthNull,
            requireFreezeAuthorityNull: cfg.safetyRequireFreezeAuthNull,
            treatAsAmm: isAmm,
            timeoutMs: cfg.safetyTimeoutMs,
          });
          if (outcome.kind === 'verdict' && !outcome.verdict.ok) {
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              reason: `safety:${outcome.verdict.reasons.join(',')}`,
            });
            stats.skippedSafety += 1;
            continue;
          }
          safetyAttached = outcome.kind === 'verdict' ? outcome.verdict : { skipped: outcome.reason };
        }

        let impulseConfirm: import('./pricing/impulse-confirm.js').ImpulseConfirmStamp | null = null;
        let impulseJupiterReuse: PriceVerifyVerdict | null = null;
        if (cfg.impulseConfirmEnabled) {
          const liveSol = getSolUsd() ?? 0;
          let baseDec: number | null = null;
          if (safetyAttached && 'decimals' in safetyAttached && safetyAttached.decimals != null) {
            const d0 = Number(safetyAttached.decimals);
            if (Number.isFinite(d0) && d0 >= 0 && d0 <= 24) baseDec = Math.floor(d0);
          }
          const ig = await runImpulseConfirmGate({
            cfg,
            lane: d.lane,
            mint: d.mint,
            symbol: d.symbol,
            source: d.source,
            pairAddress: row.pair_address,
            anchorPriceUsd: d.features.price_usd,
            baseDecimals: baseDec,
            solUsd: liveSol,
          });
          impulseConfirm = ig.stamp;
          if (ig.blocksOpen) {
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              reason: ig.reason,
              impulseConfirm: ig.stamp,
            });
            continue;
          }
          impulseJupiterReuse = ig.jupiterVerdictForReuse;
        }

        /** Same as ladder/close rows — lets dashboards show mcap at Open when snapshots have it. */
        let mcUsdLiveOpen: number | null = null;
        try {
          mcUsdLiveOpen = await getLiveMcUsd(
            ot.mint,
            ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap',
          );
        } catch {
          /* best-effort */
        }

        const snapshotEntryPriceUsd = d.features.price_usd;
        let priceVerify: PriceVerifyVerdict | null = null;
        if (cfg.priceVerifyEnabled) {
          let dec = 6;
          if (safetyAttached && 'decimals' in safetyAttached && safetyAttached.decimals != null) {
            const d0 = Number(safetyAttached.decimals);
            if (Number.isFinite(d0) && d0 >= 0) dec = Math.floor(d0);
          }
          try {
            const reused =
              impulseJupiterReuse ??
              takeImpulseJupiterReuse(ot.mint, 3000) ??
              null;
            priceVerify = await verifyEntryPrice({
              cfg,
              mint: ot.mint,
              outMintDecimals: dec,
              sizeUsd: cfg.positionUsd * cfg.entryFirstLegFraction,
              solUsd: getSolUsd() ?? 0,
              snapshotPriceUsd: snapshotEntryPriceUsd,
              reuseVerdict: reused?.kind === 'ok' ? reused : undefined,
            });
          } catch (e) {
            logger.warn({ err: (e as Error)?.message, mint: ot.mint }, 'verifyEntryPrice threw');
            priceVerify = { kind: 'skipped', reason: 'fetch-fail', ts: Date.now() };
          }
          if (priceVerify.kind === 'blocked' && cfg.priceVerifyBlockOnFail) {
            stats.skippedPriceVerify += 1;
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: ot.mint,
              reason: `price_verify:${priceVerify.reason}`,
              snapshotPriceUsd: priceVerify.snapshotPriceUsd,
              jupiterPriceUsd: priceVerify.jupiterPriceUsd,
              slipPct: priceVerify.slipPct,
              priceImpactPct: priceVerify.priceImpactPct,
            });
            continue;
          }
          if (
            priceVerify.kind === 'ok' &&
            cfg.priceVerifyUseJupiterPrice &&
            priceVerify.jupiterPriceUsd > 0
          ) {
            const rowJ = { ...row, price_usd: priceVerify.jupiterPriceUsd, pair_address: row.pair_address };
            ot = makeOpenTradeFromEntry({
              cfg,
              row: rowJ,
              lane: d.lane,
              dex,
              liquidityUsd: d.features.liq_usd,
              entryTs: ot.entryTs,
            });
          }
        }

        const pfQuoteOpen = getPriorityFeeUsd(cfg, getSolUsd() ?? 0);

        let simAudit: SimAuditStamp | null = null;
        if (cfg.simAuditEnabled) {
          try {
            simAudit = await runOpenSimAudit({
              cfg,
              mint: ot.mint,
              entryTs: ot.entryTs,
              solUsd: getSolUsd() ?? 0,
            });
          } catch (e) {
            logger.warn({ err: (e as Error)?.message, mint: ot.mint }, 'runOpenSimAudit threw');
            simAudit = { kind: 'skipped', reason: 'exception', ts: Date.now(), wallMs: 0 };
          }
        }

        let tokenDecimals: number | null = null;
        if (safetyAttached && 'decimals' in safetyAttached && safetyAttached.decimals != null) {
          const d0 = Number(safetyAttached.decimals);
          if (Number.isFinite(d0) && d0 >= 0 && d0 <= 24) tokenDecimals = Math.floor(d0);
        }
        ot.tokenDecimals = tokenDecimals;

        await resolveTpRegimeForOpen(cfg, ot);
        /**
         * Live Oscar: режим A/B не ставим на входе — сплит 75%+25% обязателен и не является DCA.
         * A включается трекером при первой ступени TP-сетки; B — при реальном DCA по просадке.
         */
        if (
          cfg.liveExitModeAbEnabled &&
          !isPaperOscarIdealizedStackStrategyId(cfg.strategyId) &&
          cfg.strategyId !== 'live-oscar'
        ) {
          ot.liveExitProfileMode = 'A';
        }

        const liveOscar = resolveLiveOscar();
        if (liveOscar && cfg.strategyId === 'live-oscar') {
          if (isMintPermanentlyDeniedLiveOscar(liveOscar.liveCfg, ot.mint)) {
            stats.skippedLivePermanentDeny += 1;
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: ot.mint,
              symbol: ot.symbol,
              reason: 'live_permanent_deny',
            });
            journalLiveStrategy?.({
              kind: 'live_permanent_deny_skip',
              mint: ot.mint,
              symbol: ot.symbol,
              lane: d.lane,
              source: d.source,
            });
            continue;
          }
        }
        if (
          liveOscar?.liveCfg.liveMintWhitelistEnabled &&
          !isPaperOscarFamilyStrategyId(cfg.strategyId)
        ) {
          if (!isMintOnLiveWhitelist(liveOscar.liveCfg.liveMintWhitelistPath, ot.mint)) {
            stats.skippedLiveMintWhitelist += 1;
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: ot.mint,
              symbol: ot.symbol,
              reason: 'live_mint_whitelist',
            });
            journalLiveStrategy?.({
              kind: 'live_whitelist_skip',
              mint: ot.mint,
              symbol: ot.symbol,
              lane: d.lane,
              source: d.source,
            });
            void notifyLiveMintWhitelistSkip(
              ot.symbol,
              ot.mint,
              liveOscar.liveCfg.liveMintWhitelistNotifyCooldownMs,
            );
            continue;
          }
        }
        if (liveOscar) {
          scheduleSignalLabPreBuyOpen({
            liveCfg: liveOscar.liveCfg,
            paperCfg: cfg,
            ot,
            decision: d,
            snapshotEntryPriceUsd,
            tokenDecimals,
            priceVerify,
          });
          const opened = await liveOscar.discovery.tryExecuteBuyOpen({
            liveCfg: liveOscar.liveCfg,
            paperCfg: cfg,
            ot,
            decision: d,
            snapshotEntryPriceUsd,
            tokenDecimals,
          });
          if (!opened.ok) continue;
          applyLiveBuyAnchorsAfterOpen(ot, opened);
          if (
            liveOscar.liveCfg.liveEntryScaleInEnabled &&
            liveOscar.liveCfg.executionMode === 'live' &&
            cfg.entryFirstLegFraction < 1 - 1e-9 &&
            !liveStagedEntryActive()
          ) {
            const secondUsd = cfg.positionUsd * (1 - cfg.entryFirstLegFraction);
            if (secondUsd > 1e-6) {
              ot.livePendingScaleIn = {
                anchorMarketUsd: ot.legs[0]?.marketPrice ?? snapshotEntryPriceUsd,
                secondLegUsd: secondUsd,
                executeAfterTs: Date.now() + liveOscar.liveCfg.liveEntryScaleInDelayMs,
                corridorUpPct: liveOscar.liveCfg.liveEntryScaleInCorridorUpPct,
                corridorDownPct: liveOscar.liveCfg.liveEntryScaleInCorridorDownPct,
                maxSwapAttempts: liveOscar.liveCfg.liveEntryScaleInMaxSwapAttempts,
                swapAttempts: 0,
                nextAttemptAfterTs: 0,
              };
            }
          }
        } else {
          journalAppend({
            kind: 'open',
            mint: ot.mint,
            symbol: ot.symbol,
            lane: ot.lane,
            source: ot.source,
            dex: ot.dex,
            entryTs: ot.entryTs,
            entryMcUsd: ot.entryMcUsd,
            entryMarketPrice: ot.legs[0]?.marketPrice ?? ot.entryMcUsd,
            snapshotEntryPriceUsd,
            legs: ot.legs,
            totalInvestedUsd: ot.totalInvestedUsd,
            avgEntry: ot.avgEntry,
            avgEntryMarket: ot.avgEntryMarket,
            pairAddress: ot.pairAddress,
            entryLiqUsd: ot.entryLiqUsd,
            eval_reasons: d.reasons,
            features: d.features,
            btc,
            whale_analysis: d.whale,
            pre_entry_dynamics: preDyn,
            context_swaps: ctxSwaps,
            safety: safetyAttached,
            mcUsdLive: mcUsdLiveOpen,
            priorityFee: pfQuoteOpen,
            priceVerify: cfg.priceVerifyEnabled ? priceVerify : null,
            impulseConfirm: impulseConfirm ?? undefined,
            ...(simAudit != null ? { simAudit } : {}),
            ...(ot.tpRegime ? { tpRegime: ot.tpRegime } : {}),
            ...(ot.tpRegimeFeatures ? { tpRegimeFeatures: { ...ot.tpRegimeFeatures } } : {}),
            ...(ot.tpGridOverrides ? { tpGridOverrides: { ...ot.tpGridOverrides } } : {}),
            ...(cfg.liveExitModeAbEnabled && ot.liveExitProfileMode
              ? { liveExitProfileMode: ot.liveExitProfileMode }
              : {}),
          });
          if (usesPaperOscarSecondLegScaleIn(cfg.strategyId)) {
            const si = readPaperOscarScaleInEnv();
            if (si.enabled && cfg.entryFirstLegFraction < 1 - 1e-9) {
              const secondUsd = cfg.positionUsd * (1 - cfg.entryFirstLegFraction);
              if (secondUsd > 1e-6) {
                ot.livePendingScaleIn = {
                  anchorMarketUsd: ot.legs[0]?.marketPrice ?? snapshotEntryPriceUsd,
                  secondLegUsd: secondUsd,
                  executeAfterTs: Date.now() + si.delayMs,
                  corridorUpPct: si.corridorUpPct,
                  corridorDownPct: si.corridorDownPct,
                  maxSwapAttempts: si.maxSwapAttempts,
                  swapAttempts: 0,
                  nextAttemptAfterTs: 0,
                };
              }
            }
          }
        }

        open.set(ot.mint, ot);
        const liveOscarForJournal = resolveLiveOscar();
        const liveOpenExtras: Record<string, unknown> =
          liveOscarForJournal && liveStagedEntryActive()
            ? {
                timelineOpenLabelRu: `Первая нога $${cfg.liveStagedEntryFirstLegUsd.toFixed(0)} на −${cfg.liveStagedEntryFirstDropPct}% от сигнала`,
                liveStagedEntryParams: {
                  signalPriceUsd: ot.liveStagedEntry?.signalPriceUsd,
                  firstDropPct: cfg.liveStagedEntryFirstDropPct,
                  firstLegUsd: cfg.liveStagedEntryFirstLegUsd,
                  secondDropPct: cfg.liveStagedEntrySecondDropPct,
                  secondLegUsd: cfg.liveStagedEntrySecondLegUsd,
                  killDropPct: cfg.liveStagedEntryKillDropPct,
                  signalTtlMs: cfg.liveStagedEntrySignalTtlMs,
                  description:
                    'Покупка live-oscar теперь staged: сигнал фиксирует якорную цену; первая нога исполняется после падения от сигнала, вторая — как единственное усреднение на более глубоком падении; kill-stop считается от цены сигнала.',
                },
              }
            : liveOscarForJournal && cfg.entryFirstLegFraction < 1 - 1e-9
            ? {
                timelineOpenLabelRu: `Покупка ${Math.round(cfg.entryFirstLegFraction * 100)}% позиции`,
                liveScaleInParams: {
                  liveEntryScaleInEnabled: liveOscarForJournal.liveCfg.liveEntryScaleInEnabled,
                  executionMode: liveOscarForJournal.liveCfg.executionMode,
                  firstLegFraction: cfg.entryFirstLegFraction,
                  secondLegFraction: +(1 - cfg.entryFirstLegFraction).toFixed(6),
                  delayMs: liveOscarForJournal.liveCfg.liveEntryScaleInDelayMs,
                  corridorSymFallbackPct: liveOscarForJournal.liveCfg.liveEntryScaleInCorridorPct,
                  corridorUpPct: liveOscarForJournal.liveCfg.liveEntryScaleInCorridorUpPct,
                  corridorDownPct: liveOscarForJournal.liveCfg.liveEntryScaleInCorridorDownPct,
                  maxSwapAttempts: liveOscarForJournal.liveCfg.liveEntryScaleInMaxSwapAttempts,
                  retryBackoffMs: liveOscarForJournal.liveCfg.liveEntryScaleInRetryBackoffMs,
                  corridorCheckDescription:
                    'Jupiter SOL→token quote implied USD/token vs рыночная цена первой ноги; коридор до +corridorUpPct % и до −corridorDownPct % (если задан только LIVE_ENTRY_SCALE_IN_CORRIDOR_PCT — симметрично).',
                },
              }
            : {};
        if (liveOscarForJournal?.liveCfg.executionMode === 'live') {
          cancelLivePostCloseTailSweepForMint(ot.mint);
        }
        opts?.journalLiveStrategy?.({
          kind: 'live_position_open',
          mint: ot.mint,
          openTrade: serializeOpenTrade(ot),
          ...liveOpenExtras,
        });
        recordEntryTs(ot.mint, ot.entryTs);
        stats.opened++;
        schedulePendingFollowups(
          cfg,
          {
            mint: ot.mint,
            symbol: ot.symbol,
            entryTs: ot.entryTs,
            entryPrice: ot.legs[0]?.price ?? ot.entryMcUsd,
            entryMarketPrice: ot.legs[0]?.marketPrice ?? ot.entryMcUsd,
            metricType: ot.metricType,
            source: ot.source,
          },
          followupOffsets,
        );
      }
      recordDiscoveryHealthSample({
        discovered: res.discovered,
        evaluated: res.evaluated,
        passed: res.passed,
        opened: stats.opened - openedBeforeDiscoveryBatch,
      });
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'discovery tick failed', err: (err as Error).message });
    }
  }

  let discoveryRunning = false;
  let trackerRunning = false;
  let followupRunning = false;

  const discoveryTimer = setInterval(async () => {
    if (discoveryRunning) return;
    discoveryRunning = true;
    try {
      await withTimeout(discoveryTick(), 60_000, 'discoveryTick');
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'discovery error', err: (err as Error).message });
    }
    discoveryRunning = false;
  }, cfg.discoveryIntervalMs);

  const trackerTimer = setInterval(async () => {
    if (trackerRunning) return;
    trackerRunning = true;
    try {
      await withTimeout(
        trackerTick({
          cfg,
          open,
          closed,
          dcaLevels,
          tpLadder,
          stats: trackerStats,
          btcCtx: getBtcContext,
          journalAppend,
          journalLiveStrategy: opts?.journalLiveStrategy,
          livePhase4: resolveLiveOscar()?.tracker,
          liveOscarCfg: resolveLiveOscar()?.liveCfg,
          reconcilePaperCloseZeroMints: opts?.reconcilePaperCloseZeroMints,
          verifyReconcileOrphanWalletZero: opts?.verifyReconcileOrphanWalletZero,
          reconcileOrphanMinPositionAgeMs: opts?.reconcileOrphanMinPositionAgeMs,
        }),
        45_000,
        'trackerTick',
      );
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'tracker error', err: (err as Error).message });
    }
    trackerRunning = false;
  }, cfg.trackIntervalMs);

  const followupTimer = setInterval(async () => {
    if (followupRunning) return;
    followupRunning = true;
    try {
      await followupTick();
    } catch (err) {
      stats.errors++;
      logger.warn({ msg: 'followup error', err: (err as Error).message });
    }
    followupRunning = false;
  }, cfg.followupTickMs);

  const heartbeatMs =
    opts?.heartbeatIntervalMsOverride != null &&
    Number.isFinite(opts.heartbeatIntervalMsOverride) &&
    opts.heartbeatIntervalMsOverride >= 5000
      ? Math.floor(opts.heartbeatIntervalMsOverride)
      : cfg.heartbeatIntervalMs;

  const heartbeatTimer = setInterval(() => {
    const holdersStats = cfg.holdersLiveEnabled ? getHoldersResolveStats() : null;
    journalAppend({
      kind: 'heartbeat',
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      openPositions: open.size,
      closedTotal: closed.length,
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      note: `${cfg.strategyKind} executor: ticks=${stats.ticks} disc=${stats.discovered} eval=${stats.evaluated} pass=${stats.passed} opened=${stats.opened} skip_safety=${stats.skippedSafety} skip_price_verify=${stats.skippedPriceVerify} skip_live_mint_whitelist=${stats.skippedLiveMintWhitelist} skip_live_permanent_deny=${stats.skippedLivePermanentDeny} skip_price_verify_exit=${trackerStats.skippedPriceVerifyExit} closed=${closed.length} pending_followups=${pendingFollowupsCount()} errors=${stats.errors}`,
      skippedPriceVerify: stats.skippedPriceVerify,
      skippedPriceVerifyExit: trackerStats.skippedPriceVerifyExit,
      holdersResolveStats: holdersStats,
      trackerStats: trackerStats.closed,
    });
    opts?.onOscarHeartbeat?.({
      openPositions: open.size,
      closedTotal: closed.length,
      stats: { ...stats },
      trackerClosed: trackerStats.closed,
    });
    logger.info({
      msg: 'heartbeat',
      solUsd: getSolUsd(),
      btc: getBtcContext(),
      stats,
      open: open.size,
      closed: closed.length,
      trackerStats: trackerStats.closed,
      holdersResolveStats: holdersStats,
    });
  }, heartbeatMs);

  const statsTimer = setInterval(() => {
    const wins = closed.filter((c) => c.pnlPct > 0).length;
    const winRate = closed.length > 0 ? (wins / closed.length) * 100 : 0;
    logger.info({
      msg: 'stats',
      open: open.size,
      closed: closed.length,
      wins,
      winRate: +winRate.toFixed(1),
      exits: trackerStats.closed,
    });
  }, cfg.statsIntervalMs);

  const livePeriodicHealTimer = opts?.livePeriodicSelfHealFactory?.({
    paperCfg: cfg,
    getOpen: () => open,
    getClosed: () => closed,
    tpLadder,
    trackerStats,
    btcCtx: getBtcContext,
    journalAppend,
    journalLiveStrategy: opts?.journalLiveStrategy,
    resolveLiveOscar,
    isTrackerBusy: () => trackerRunning,
  });

  const solTimer = setInterval(() => {
    void refreshSolPrice();
  }, cfg.solPriceRefreshMs);
  const btcTimer = setInterval(() => {
    void refreshBtcContext(cfg);
  }, cfg.btcContextRefreshMs);

  await discoveryTick();

  const shutdown = (sig: string) => {
    opts?.onShutdown?.(sig);
    logger.info({ msg: 'papertrader shutdown', sig, stats, open: open.size, closed: closed.length });
    stopPriorityFeeTicker();
    clearInterval(discoveryTimer);
    clearInterval(trackerTimer);
    clearInterval(followupTimer);
    clearInterval(heartbeatTimer);
    clearInterval(statsTimer);
    if (livePeriodicHealTimer) clearInterval(livePeriodicHealTimer);
    clearInterval(solTimer);
    clearInterval(btcTimer);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
