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
import { computeDynamicKillstopShadowForOpen } from './pricing/dynamic-killstop-shadow.js';
import { runOpenSimAudit } from './pricing/sim-audit.js';
import { runImpulseConfirmGate, takeImpulseJupiterReuse } from './pricing/impulse-confirm.js';
import {
  evaluatedAtMap,
  lastEntryTsByMintMap,
  lastPostExitBuyCooldownTsByMintMap,
  lastExitMarketSnapshotByMintMap,
  lastRealExitMarketSnapshotByMintMap,
  recordAfterFullCloseForMintRepeatGateFromClosedTrade,
  recordEntryTs,
  runDipDiscovery,
  type EvalDecision,
} from './discovery/dip-clones.js';
import { runPresetCDiscovery } from '../preset-c/discovery.js';
import { isPresetCScalpModeEnabled, loadPresetCScalpConfig } from '../preset-c/scalp-config.js';
import {
  findPresetCScalpEntriesReady,
  markPresetCScalpPendingEntryDone,
  presetCScalpFillTooDeep,
  presetCScalpReadyToEvalDecision,
  presetCScalpSignalDropPct,
  pruneExpiredPresetCScalpPending,
  removePresetCScalpPending,
  upsertPresetCScalpPendingFromDecision,
  PRESET_C_SCALP_FILL_TOO_DEEP_REASON,
  type PresetCScalpReadyEntry,
} from '../preset-c/scalp-pending.js';
import {
  matchingPresetCTelegramGateKeys,
  stampPresetCTgDedupeKeysOnOpen,
} from '../preset-c/telegram-gate.js';
import {
  isLiveOscarMainStrategyId,
  isLiveOscarPresetCStrategyId,
  isLiveOscarTradingStrategyId,
} from '../preset-c/live-oscar-family.js';
import { gmgnMintHrefHtml, isAwaitingDipQualityHold } from './discovery/near-ready-dip-watch.js';
import { syncPriorityOpenMints } from './discovery/priority-discovery-registry.js';
import { updateNearReadyDipWatchlist } from './discovery-health-window.js';
import { runSmartLotteryDiscovery } from './discovery/smart-lottery.js';
import { fetchLaunchpadCandidates } from './discovery/launchpad.js';
import { fetchFreshValidatedCandidates } from './discovery/fresh-validated.js';
import { stampLiveOscarExitPolicyOnOpen } from './executor/exit-policy-wave-b.js';
import {
  applyCanonicalOpenLegUsd,
  resolveLiveOscarEntrySplitLegUsd,
  resolveLiveOscarStagedAvgLegUsd,
} from './live-oscar-entry-sizing.js';
import {
  countOpenScalpWavePositions,
  liveOscarMintOpenSkipReason,
  liveOscarScalpWaveOpenLegUsd,
  resolveLiveOscarTradeLaneFromOpen,
  stampLiveOscarTradeLaneOnOpen,
  type LiveOscarTradeLane,
} from './live-oscar-scalp-wave.js';
import {
  countOpenRunnerProbePositions,
  resolveOpenMapKey,
  runnerProbeMintOpenSkipReason,
  runnerProbeOpenLegUsd,
  stampRunnerProbeOnOpen,
  sumRunnerProbeExposureUsd,
} from './live-oscar-runner-probe.js';
import { applyLiveOscarPhaseEscalation, computeDropFromScalpAnchor } from './live-oscar-phase-escalation.js';
import { makeOpenTradeFromEntry, snapshotSourceToDex } from './executor/open.js';
import { configureWaveBPostTp1ScratchReentry } from './executor/wave-b-post-tp1-scratch-reentry.js';
import {
  buildLiveStagedEntryState,
  liveStagedEntrySignalExpiresAt,
  planLiveStagedEntrySignalResolution,
  liveStagedEntrySignalTtlEnabled,
  markEntrySplitLeg1Filled,
  stagedEntryPlanInvestedCapUsd,
} from './executor/live-staged-entry-gates.js';
import {
  liveMintFirstProbeKillDropPct,
  shouldUseLiveMintFirstProbe,
} from '../live/mint-first-probe.js';
import { liveStagedOpenLabelRuFromCfg } from './executor/live-staged-entry-labels.js';
import { fetchPreEntryDynamics } from './executor/dynamics.js';
import { fetchContextSwaps } from './executor/context-swaps.js';
import { followupTick, schedulePendingFollowups, pendingFollowupsCount } from './executor/followup.js';
import {
  trackerTick,
  finalizeLiveCapitalRotatePaperClose,
  type TrackerStats,
} from './executor/tracker.js';
import { startEntrySplitFastPoll, stopEntrySplitFastPoll } from './executor/entry-split-fast-poll.js';
import { reconcileOpenTradeDcaFromLegs } from './executor/dca-state.js';
import { reconcileE2OpenOnRestore } from './executor/live-oscar-e2-open-reconcile.js';
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
import type { LiveOpenPositionHotTickPaperContext } from '../live/open-position-hot-tick.js';
import { applyLiveBuyAnchorsAfterOpen } from '../live/live-buy-anchor.js';
import { applyCopyToOscarPromotionAccounting } from '../live/copy-to-oscar-promotion.js';
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
import { isEntryPriceStale, snapshotPriceAgeMs } from './stale-price.js';
import { buildShadowPriceEvent } from './stream/shadow-price.js';
import {
  getShyftShadowStreamPrice,
  isShyftShadowEnabled,
  setShyftShadowWatchedMints,
} from './stream/shadow-state.js';
import {
  isLiveBuyDiscoveryTelegramSuppressed,
  refreshLiveBuyTelegramSuppressForTick,
  resetLiveBuyTelegramSuppressTick,
} from '../live/wallet-buy-affordability.js';

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

function isOnlyLocalHighVetoReasons(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r.startsWith('local_high_veto_'));
}

function isOnlyVolumeEphemeralBlockReasons(reasons: string[]): boolean {
  return reasons.length > 0 && reasons.every((r) => r.startsWith('volume_ephemeral:'));
}

/** True when coverage guard is the sole blocker (snapshot/dip/volume gates already passed). */
function isOnlyDataCoverageBlock(reasons: string[]): boolean {
  if (reasons.length === 0) return false;
  return reasons.every((r) => r.startsWith('data_coverage:'));
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

  /** Live-oscar: fast executable sell probes for open positions (Phase 1 hot tick). */
  liveOpenPositionHotTickFactory?: (
    ctx: LiveOpenPositionHotTickPaperContext,
  ) => ReturnType<typeof setInterval> | null;

  /**
   * Live-oscar: override paper `PAPER_HEARTBEAT_INTERVAL_MS` for JSONL + `onOscarHeartbeat` cadence.
   */
  heartbeatIntervalMsOverride?: number;

  onOscarHeartbeat?: (payload: {
    openPositions: number;
    closedTotal: number;
    open: ReadonlyMap<string, OpenTrade>;
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
  configureWaveBPostTp1ScratchReentry(cfg);
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
        lastExitMarketSnapshotByMint: new Map(),
        lastRealExitMarketSnapshotByMint: new Map(),
        open: new Map<string, OpenTrade>(),
      }
    : loadStore(cfg.storePath);
  for (const [mint, ts] of restored.evaluatedAt) evaluatedAtMap.set(mint, ts);
  for (const [mint, ts] of restored.lastEntryTsByMint) lastEntryTsByMintMap.set(mint, ts);
  for (const [mint, ts] of restored.lastPostExitBuyCooldownTsByMint) {
    lastPostExitBuyCooldownTsByMintMap.set(mint, ts);
  }
  for (const [mint, snap] of restored.lastExitMarketSnapshotByMint) {
    lastExitMarketSnapshotByMintMap.set(mint, snap);
  }
  for (const [mint, snap] of restored.lastRealExitMarketSnapshotByMint) {
    lastRealExitMarketSnapshotByMintMap.set(mint, snap);
  }
  if (opts?.skipPaperJsonlStore && opts.liveStrategyReplay?.closed?.length) {
    for (const ct of opts.liveStrategyReplay.closed) {
      if (!(ct.exitTs > 0)) continue;
      recordAfterFullCloseForMintRepeatGateFromClosedTrade(cfg, {
        mint: ct.mint,
        exitTs: ct.exitTs,
        theoretical_exit_price: ct.theoretical_exit_price,
        effective_exit_price: ct.effective_exit_price,
        netPnlUsd: ct.netPnlUsd,
        exitReason: ct.exitReason,
      });
    }
  }
  const open: Map<string, OpenTrade> =
    opts?.skipPaperJsonlStore && opts.liveStrategyReplay ? opts.liveStrategyReplay.open : restored.open;
  for (const ot of open.values()) {
    reconcileOpenTradeDcaFromLegs(ot, dcaLevels);
    if (isLiveOscarTradingStrategyId(cfg.strategyId)) {
      reconcileE2OpenOnRestore(ot, cfg);
    }
    if (ot.entryTs > 0) recordEntryTs(ot.mint, ot.entryTs);
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
  const stagedEntryBuyInFlight = new Set<string>();
  const localHighVetoTelegramLastMs = new Map<string, number>();
  const volumeEphemeralTelegramLastMs = new Map<string, number>();
  const dataCoverageTelegramLastMs = new Map<string, number>();
  const stalePriceTelegramLastMs = new Map<string, number>();

  function liveStagedEntryActive(): boolean {
    return (isLiveOscarTradingStrategyId(cfg.strategyId) || cfg.strategyId === 'live-oscar-risky') && cfg.liveStagedEntryEnabled;
  }

  function attachLiveStagedEntryPlan(
    ot: OpenTrade,
    mint: string,
    signal: { signalTs: number; signalPriceUsd: number },
    marketCapUsd: number | null,
    liveOscarMcapTier?: 'micro' | 'low' | 'prod',
  ): void {
    if (!liveStagedEntryActive()) return;
    const liveCfg = resolveLiveOscar()?.liveCfg;
    const firstMintProbe =
      cfg.strategyId === 'live-oscar' && liveCfg != null && shouldUseLiveMintFirstProbe(liveCfg, mint);
    const firstMintKillDropPct = firstMintProbe ? liveMintFirstProbeKillDropPct(liveCfg!) : undefined;
    if (liveOscarMcapTier === 'micro' || liveOscarMcapTier === 'low' || liveOscarMcapTier === 'prod') {
      ot.liveOscarMcapTier = liveOscarMcapTier;
    }
    ot.liveStagedEntry = buildLiveStagedEntryState(cfg, signal, {
      firstMintProbe,
      firstMintKillDropPct,
      marketCapUsd,
    });
    if (firstMintProbe) {
      ot.liveMintFirstProbe = true;
      ot.liveMintFirstProbeKillDropPct = firstMintKillDropPct ?? 7;
    }
    markEntrySplitLeg1Filled(ot.liveStagedEntry, ot);
    applyCanonicalOpenLegUsd(cfg, ot);
  }

  function isSignalMintMissingFromLiveWhitelist(mint: string): boolean {
    const liveOscar = resolveLiveOscar();
    if (!liveOscar?.liveCfg.liveMintWhitelistEnabled) return false;
    if (isPaperOscarFamilyStrategyId(cfg.strategyId)) return false;
    try {
      return !isMintOnLiveWhitelist(liveOscar.liveCfg.liveMintWhitelistPath, mint);
    } catch (e) {
      logger.warn({ err: String(e), mint }, 'live signal whitelist lookup failed');
      return false;
    }
  }

  function resolveDecisionTradeLane(d: EvalDecision): LiveOscarTradeLane {
    if (d.liveOscarTradeLane) return d.liveOscarTradeLane;
    if (d.positionSource === 'runner_probe') return 'runner_probe';
    return 'prod';
  }

  type ScalpDiscoveryDecision = EvalDecision & { _presetCScalpFromPending?: PresetCScalpReadyEntry };
  const presetCScalpDeferredOpens: PresetCScalpReadyEntry[] = [];

  async function queuePresetCScalpDeferredEntries(): Promise<void> {
    if (!isPresetCScalpModeEnabled(cfg)) return;
    const ready = await findPresetCScalpEntriesReady(new Set(open.keys()));
    for (const r of ready) {
      if (!presetCScalpDeferredOpens.some((x) => x.mint === r.mint)) {
        presetCScalpDeferredOpens.push(r);
      }
    }
  }

  function liveStagedEntryActiveForDecision(d: EvalDecision): boolean {
    if (isPresetCScalpModeEnabled(cfg) && isLiveOscarPresetCStrategyId(cfg.strategyId)) return false;
    return (
      liveStagedEntryActive() &&
      resolveDecisionTradeLane(d) !== 'scalp_wave' &&
      resolveDecisionTradeLane(d) !== 'runner_probe'
    );
  }

  function liveOscarDiscoveryBuyLegUsd(
    d: EvalDecision,
    tier?: 'micro' | 'low' | 'prod' | 'scalp_wave',
  ): number {
    if (resolveDecisionTradeLane(d) === 'scalp_wave') {
      return liveOscarScalpWaveOpenLegUsd(cfg);
    }
    if (resolveDecisionTradeLane(d) === 'runner_probe') {
      return runnerProbeOpenLegUsd(cfg);
    }
    if (liveStagedEntryActiveForDecision(d)) {
      const mcap = d.features.market_cap_usd ?? null;
      const leg = resolveLiveOscarEntrySplitLegUsd(cfg, tier === 'scalp_wave' ? undefined : tier, mcap);
      if (leg > 0) return leg;
    }
    return cfg.positionUsd * cfg.entryFirstLegFraction;
  }

  function notifyLiveStagedEntrySignal(args: {
    mint: string;
    symbol: string;
    marketCapUsd: number | null;
    holderCount: number | null;
  }): void {
    if (process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_ENABLED === '0') return;
    if (isLiveBuyDiscoveryTelegramSuppressed()) return;
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
    if (isSignalMintMissingFromLiveWhitelist(args.mint)) {
      logger.info({ mint: args.mint }, 'live staged-entry signal telegram skipped: mint not in whitelist');
      return;
    }

    const symbol = args.symbol?.trim() || '?';
    const splitUsd = cfg.liveStagedEntryEntrySplitLegUsd;
    const split2Usd =
      cfg.liveStagedEntryEntrySplitLeg2Usd > 0
        ? cfg.liveStagedEntryEntrySplitLeg2Usd
        : splitUsd;
    const sl = cfg.liveStagedEntrySecondLegUsd;
    const sd = cfg.liveStagedEntrySecondDropPct;
    const td = cfg.liveStagedEntryThirdDropPct;
    const tl = cfg.liveStagedEntryThirdLegUsd;
    const kill = cfg.liveStagedEntryKillDropPct;
    const ttlMin = liveStagedEntrySignalTtlEnabled(cfg)
      ? (cfg.liveStagedEntrySignalTtlMs / 60_000).toFixed(0)
      : null;
    const firstLegExplain =
      cfg.liveStagedEntryFirstDropPct <= 0
        ? cfg.liveStagedEntryEntrySplitTargetDropPct > 0
          ? `Сплит входа (не усреднение): <b>$${splitUsd.toFixed(0)}</b> по сигналу, 2-я нога <b>$${split2Usd.toFixed(0)}</b> при −${cfg.liveStagedEntryEntrySplitTargetDropPct}% от сигнала.`
          : `Сплит входа (не усреднение): <b>$${splitUsd.toFixed(0)}</b> сразу, затем <b>$${split2Usd.toFixed(0)}</b> через 10 с, если цена в коридоре +3% / −10% к 1-й ноге.`
        : cfg.liveStagedEntryEntrySplitTargetDropPct > 0
          ? `Сплит входа (не усреднение): 1-я нога <b>$${splitUsd.toFixed(0)}</b> при −${cfg.liveStagedEntryFirstDropPct}% от сигнала; 2-я нога <b>$${split2Usd.toFixed(0)}</b> при −${cfg.liveStagedEntryEntrySplitTargetDropPct}% от сигнала.`
          : ttlMin != null
            ? `Сплит входа после −${cfg.liveStagedEntryFirstDropPct}% от сигнала (TTL <b>${ttlMin} мин</b>).`
            : `Сплит входа после −${cfg.liveStagedEntryFirstDropPct}% от сигнала.`;
    const secondLine =
      sl > 0
        ? `Усреднение staged (не сплит): <b>$${sl.toFixed(0)}</b> на −${sd}% и <b>$${tl.toFixed(0)}</b> на −${td}% — не раньше 3 и 5 мин после предыдущей ноги.`
        : '';
    const text =
      `<b>Live Oscar signal</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(args.mint, args.mint)}\n` +
      `Market cap: <b>${escapeHtmlPlain(fmtUsdCompact(args.marketCapUsd))}</b>\n` +
      `Holders: <b>${escapeHtmlPlain(fmtCount(args.holderCount))}</b>\n` +
      `${firstLegExplain}\n` +
      (secondLine ? `${secondLine}\n` : '') +
      `Kill-stop: <b>−${kill}%</b> от цены сигнала.`;

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
    if (isLiveBuyDiscoveryTelegramSuppressed()) return;
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
    const whitelistWarning = isSignalMintMissingFromLiveWhitelist(args.mint)
      ? `\n<b>Важно:</b> Мы начали следить за этой монетой, но её нет в white list.`
      : '';
    const text =
      `<b>Live Oscar Risky signal</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(args.mint, args.mint)}\n` +
      `Market cap: <b>${escapeHtmlPlain(fmtUsdCompact(args.marketCapUsd))}</b>\n` +
      `Holders: <b>${escapeHtmlPlain(fmtCount(args.holderCount))}</b>\n` +
      `Кандидат прошёл первичные гейты; ждём recheck перед покупкой.${whitelistWarning}`;

    void sendTagged('ADVICE', 'live_oscar_risky_entry_signal', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }).catch((e) =>
      logger.warn({ err: String(e), mint: args.mint }, 'live-oscar-risky signal telegram failed'),
    );
  }

  function notifyLiveOscarLocalHighVetoOnly(d: EvalDecision): void {
    if (!isLiveOscarMainStrategyId(cfg.strategyId)) return;
    if (process.env.LIVE_LOCAL_HIGH_VETO_TELEGRAM_ENABLED === '0') return;
    if (isLiveBuyDiscoveryTelegramSuppressed()) return;
    const cooldownMs = Math.max(0, Number(process.env.LIVE_LOCAL_HIGH_VETO_TELEGRAM_COOLDOWN_MS ?? 30 * 60_000));
    const now = Date.now();
    const prev = localHighVetoTelegramLastMs.get(d.mint) ?? 0;
    if (cooldownMs > 0 && now - prev < cooldownMs) return;
    localHighVetoTelegramLastMs.set(d.mint, now);

    const token =
      process.env.LIVE_LOCAL_HIGH_VETO_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_LOCAL_HIGH_VETO_TELEGRAM_CHAT_ID?.trim() ||
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) {
      logger.warn({ mint: d.mint }, 'live local-high veto telegram skipped: bot token/chat missing');
      return;
    }

    const symbol = d.symbol?.trim() || '?';
    const text =
      `<b>Live Oscar local-high veto</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(d.mint, d.mint)}\n` +
      `Статус: покупка пропущена, и это единственная причина — новый local-high veto.\n` +
      `Причины: <code>${escapeHtmlPlain(d.reasons.join('; '))}</code>\n` +
      `Price: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.price_usd))}</b>\n` +
      `Market cap: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.market_cap_usd))}</b>\n` +
      `Holders: <b>${escapeHtmlPlain(fmtCount(d.features.holders))}</b>\n` +
      `Dip window: <b>${escapeHtmlPlain(String(d.features.dip_lookback_min ?? 'n/a'))}m</b>, ` +
      `dip: <b>${escapeHtmlPlain(d.features.dip_pct == null ? 'n/a' : `${d.features.dip_pct.toFixed(2)}%`)}</b>.`;

    void sendTagged('ADVICE', 'live_oscar_local_high_veto', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }    ).catch((e) =>
      logger.warn({ err: String(e), mint: d.mint }, 'live local-high veto telegram failed'),
    );
  }

  function notifyLiveOscarVolumeEphemeralGuard(d: EvalDecision): void {
    if (!isLiveOscarMainStrategyId(cfg.strategyId)) return;
    if (d.features.volume_ephemeral?.knownMint === true) return;
    if (process.env.LIVE_VOLUME_EPHEMERAL_TELEGRAM_ENABLED === '0') return;
    if (isLiveBuyDiscoveryTelegramSuppressed()) return;
    const cooldownMs = Math.max(
      0,
      Number(process.env.LIVE_VOLUME_EPHEMERAL_TELEGRAM_COOLDOWN_MS ?? 30 * 60_000),
    );
    const now = Date.now();
    const prev = volumeEphemeralTelegramLastMs.get(d.mint) ?? 0;
    if (cooldownMs > 0 && now - prev < cooldownMs) return;
    volumeEphemeralTelegramLastMs.set(d.mint, now);

    const token =
      process.env.LIVE_VOLUME_EPHEMERAL_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_VOLUME_EPHEMERAL_TELEGRAM_CHAT_ID?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) {
      logger.warn({ mint: d.mint }, 'live volume-ephemeral telegram skipped: bot token/chat missing');
      return;
    }

    const ve = d.features.volume_ephemeral;
    const symbol = d.symbol?.trim() || '?';
    const ephemeralReasons = d.reasons.filter((r) => r.startsWith('volume_ephemeral:'));
    const text =
      `<b>Live Oscar — подозрительный всплеск объёма</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(d.mint, d.mint)}\n` +
      `Статус: на этом eval покупка не открывается — объём сжат в узкое окно (разовый burst).\n` +
      `(Следующий eval может пройти, если PG/объём обновятся.)\n` +
      `Причины: <code>${escapeHtmlPlain(ephemeralReasons.join('; '))}</code>\n` +
      `Активных часов: <b>${escapeHtmlPlain(String(ve?.activeHours ?? 'n/a'))}</b> / ` +
      `<b>${escapeHtmlPlain(String(ve?.hoursWithData ?? 'n/a'))}</b> с данными за ` +
      `<b>${escapeHtmlPlain(String(ve?.lookbackHours ?? 'n/a'))}h</b>\n` +
      `Пик vol5m (час): <b>${escapeHtmlPlain(fmtUsdCompact(ve?.peakHourVol5mUsd))}</b>, ` +
      `сейчас vol5m: <b>${escapeHtmlPlain(fmtUsdCompact(ve?.currentVol5mUsd ?? d.features.vol5m_usd))}</b>\n` +
      `Price: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.price_usd))}</b>\n` +
      `Market cap: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.market_cap_usd))}</b>`;

    void sendTagged('ADVICE', 'live_oscar_volume_ephemeral', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }    ).catch((e) =>
      logger.warn({ err: String(e), mint: d.mint }, 'live volume-ephemeral telegram failed'),
    );
  }

  function notifyLiveOscarDataCoverageSkip(d: EvalDecision): void {
    if (!isLiveOscarMainStrategyId(cfg.strategyId)) return;
    if (process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_ENABLED === '0') return;
    if (isLiveBuyDiscoveryTelegramSuppressed()) return;
    if (!d.features.pg_data_coverage?.nearEntry) return;

    const cooldownMs = Math.max(
      0,
      Number(process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_COOLDOWN_MS ?? 30 * 60_000),
    );
    const now = Date.now();
    const prev = dataCoverageTelegramLastMs.get(d.mint) ?? 0;
    if (cooldownMs > 0 && now - prev < cooldownMs) return;
    dataCoverageTelegramLastMs.set(d.mint, now);

    const token =
      process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_CHAT_ID?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) {
      logger.warn({ mint: d.mint }, 'live pg-data-coverage telegram skipped: bot token/chat missing');
      return;
    }

    const cov = d.features.pg_data_coverage;
    const symbol = d.symbol?.trim() || '?';
    const coverageReasons = d.reasons.filter((r) => r.startsWith('data_coverage:'));
    const hourPct =
      cov?.hourCoverageRatio != null ? `${(cov.hourCoverageRatio * 100).toFixed(0)}%` : 'n/a';
    const sysPct =
      cov?.global.systemHourRatio != null
        ? `${(cov.global.systemHourRatio * 100).toFixed(0)}%`
        : 'n/a';
    const recoveryNote = cov?.global.strictRecoveryActive
      ? `\nРежим: строгий после восстановления PG (${cov.global.hoursSinceLastRecovery?.toFixed(1) ?? '?'} ч назад).`
      : cov?.global.coverageMode === 'relaxed'
        ? '\nРежим PG coverage: упрощённый (recent window) — дыра или восстановление PG.'
        : '';

    const text =
      `<b>Live Oscar — покупка пропущена (дыра / неполные PG-данные)</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(d.mint, d.mint)}\n` +
      `Статус: snapshot и dip-гейты пройдены; покупка пропущена — PG-история неполная для проверки объёма.\n` +
      `Причины: <code>${escapeHtmlPlain(coverageReasons.join('; '))}</code>\n` +
      `PG mint (recent ${escapeHtmlPlain(String(cov?.recentHours ?? cov?.lookbackHours ?? 'n/a'))}h): ` +
      `<b>${escapeHtmlPlain(String(cov?.recentHoursWithData ?? cov?.hoursWithData ?? 'n/a'))}h</b> ` +
      `(покрытие ${escapeHtmlPlain(cov?.recentHourCoverageRatio != null ? `${(cov.recentHourCoverageRatio * 100).toFixed(0)}%` : hourPct)}), ` +
      `max gap (recent): <b>${escapeHtmlPlain(cov?.maxGapMinutes != null ? `${Math.round(cov.maxGapMinutes)}m` : 'n/a')}</b>, ` +
      `sybil samples: <b>${escapeHtmlPlain(String(cov?.sybilBaselineSamples ?? 'n/a'))}</b>\n` +
      `Система PG: hour_ratio=${escapeHtmlPlain(sysPct)}, stale_now=${escapeHtmlPlain(String(cov?.global.pgStaleNow ?? false))}` +
      recoveryNote +
      `\nPrice: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.price_usd))}</b>, ` +
      `vol5m: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.vol5m_usd))}</b>, ` +
      `mcap: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.market_cap_usd))}</b>`;

    void sendTagged('ADVICE', 'live_oscar_pg_data_coverage', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }    ).catch((e) =>
      logger.warn({ err: String(e), mint: d.mint }, 'live pg-data-coverage telegram failed'),
    );
  }

  function notifyLiveOscarPgCoverageModeChange(mode: 'full' | 'relaxed'): void {
    if (!isLiveOscarMainStrategyId(cfg.strategyId)) return;
    if (process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_ENABLED === '0') return;

    const token =
      process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_PG_DATA_COVERAGE_TELEGRAM_CHAT_ID?.trim() ||
      process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) return;

    const text =
      mode === 'full'
        ? `<b>Live Oscar — PG coverage: полный режим</b>\n` +
          `24h system ratio, strict-after-recovery и полная mint-история снова активны. Покупки проходят только при здоровом PG.`
        : `<b>Live Oscar — PG coverage: упрощённый режим</b>\n` +
          `PG дыра или восстановление — проверки по recent window (6h). Полный режим включится автоматически, когда PG стабилен.`;

    void sendTagged('ADVICE', 'live_oscar_pg_coverage_mode', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }).catch((e) =>
      logger.warn({ err: String(e), mode }, 'live pg-coverage-mode telegram failed'),
    );
  }

  /**
   * Observability only (Stage 0, 1.11.466): at the entry-decision point, measure how stale the polled
   * PG snapshot price is and, if older than `liveOscarStalePriceWarnMs`, emit a `live_stale_price_warn`
   * journal metric (+ optional throttled alert). Does NOT change any trading decision — pure telemetry to
   * quantify the 30–90s price-blindness before the Shyft hybrid (Stage 1).
   */
  function observeStaleEntryPrice(d: EvalDecision): void {
    const warnMs = cfg.liveOscarStalePriceWarnMs;
    const tsMs = d.features.snapshot_ts_ms ?? null;
    const now = Date.now();
    if (!isEntryPriceStale(tsMs, now, warnMs)) return;
    const priceAgeMs = snapshotPriceAgeMs(tsMs, now) ?? 0;
    const event = {
      kind: 'live_stale_price_warn' as const,
      lane: d.lane,
      source: d.source,
      mint: d.mint,
      symbol: d.symbol,
      priceAgeMs: Math.round(priceAgeMs),
      warnThresholdMs: warnMs,
      priceUsd: d.features.price_usd,
      snapshotTsMs: tsMs,
    };
    journalAppend(event);
    journalLiveStrategy?.(event);
    notifyLiveOscarStalePrice(d, priceAgeMs);
  }

  /**
   * Observability only (Stage 1.1, 1.11.467): at the entry-decision point, pair the PG price being used
   * with the freshest Shyft stream price (if any) and journal a `live_shyft_shadow_price` record to
   * measure how far PG lags behind the live stream. Gated by `liveOscarShyftShadowEnabled` (default OFF)
   * + `live-oscar`. **Never changes a trading decision** — the stream price is not read by any gate/eval.
   */
  function observeShyftShadowEntryPrice(d: EvalDecision): void {
    if (!cfg.liveOscarShyftShadowEnabled || !isLiveOscarMainStrategyId(cfg.strategyId)) return;
    if (!isShyftShadowEnabled()) return;
    const now = Date.now();
    const stream = getShyftShadowStreamPrice(d.mint, now);
    if (!stream) return;
    const event = buildShadowPriceEvent({
      mint: d.mint,
      lane: String(d.lane),
      surface: 'entry',
      streamPriceUsd: stream.priceUsd,
      pgPriceUsd: d.features.price_usd,
      streamTsMs: stream.streamTsMs,
      pgSnapshotTsMs: d.features.snapshot_ts_ms ?? null,
      streamSlot: stream.slot,
      nowMs: now,
    });
    journalAppend(event);
    journalLiveStrategy?.(event);
  }

  function notifyLiveOscarStalePrice(d: EvalDecision, priceAgeMs: number): void {
    if (!isLiveOscarMainStrategyId(cfg.strategyId)) return;
    // Throttled alert is opt-in (default OFF) — journal metric above is the primary observability surface.
    if (process.env.LIVE_OSCAR_STALE_PRICE_TELEGRAM_ENABLED !== '1') return;
    if (isLiveBuyDiscoveryTelegramSuppressed()) return;
    const cooldownMs = Math.max(
      0,
      Number(process.env.LIVE_OSCAR_STALE_PRICE_TELEGRAM_COOLDOWN_MS ?? 30 * 60_000),
    );
    const now = Date.now();
    const prev = stalePriceTelegramLastMs.get(d.mint) ?? 0;
    if (cooldownMs > 0 && now - prev < cooldownMs) return;
    stalePriceTelegramLastMs.set(d.mint, now);

    const token =
      process.env.LIVE_OSCAR_STALE_PRICE_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_BOT_TOKEN?.trim() ||
      process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chat =
      process.env.LIVE_OSCAR_STALE_PRICE_TELEGRAM_CHAT_ID?.trim() ||
      process.env.LIVE_STAGED_ENTRY_SIGNAL_TELEGRAM_CHAT_ID?.trim() ||
      '-1003878024799';
    if (!token || !chat) {
      logger.warn({ mint: d.mint }, 'live stale-price telegram skipped: bot token/chat missing');
      return;
    }

    const symbol = d.symbol?.trim() || '?';
    const ageSec = (priceAgeMs / 1000).toFixed(1);
    const thrSec = (cfg.liveOscarStalePriceWarnMs / 1000).toFixed(0);
    const text =
      `<b>Live Oscar — устаревшая цена входа</b>\n` +
      `Монета: <b>${escapeHtmlPlain(symbol)}</b>\n` +
      `Адрес: ${gmgnMintHrefHtml(d.mint, d.mint)}\n` +
      `Возраст PG-цены: <b>${escapeHtmlPlain(ageSec)}s</b> (порог ${escapeHtmlPlain(thrSec)}s)\n` +
      `Lane: <code>${escapeHtmlPlain(`${d.lane}${d.source ? `/${d.source}` : ''}`)}</code>\n` +
      `Price: <b>${escapeHtmlPlain(fmtUsdCompact(d.features.price_usd))}</b>\n` +
      `Решение торговли не изменено — это только наблюдаемость.`;

    void sendTagged('ADVICE', 'live_oscar_stale_price', text, {
      parseMode: 'HTML',
      skipQuietHours: true,
      telegramBotToken: token,
      telegramChatId: chat,
    }).catch((e) =>
      logger.warn({ err: String(e), mint: d.mint }, 'live stale-price telegram failed'),
    );
  }

  function isStagedEntryReanchorBlocked(mint: string): boolean {
    return stagedEntryBuyInFlight.has(mint) || isMintBlockedForAmbiguousLiveBuy(mint);
  }

  function clearStagedEntrySignalForConfirmedBuy(
    mint: string,
    signal?: {
      signalTs: number;
      signalPriceUsd: number;
      expiresAt: number;
    },
  ): void {
    if (!stagedEntrySignals.delete(mint)) return;
    journalLiveStrategy?.({
      kind: 'staged_entry_cleared_for_buy',
      mint,
      signalPriceUsd: signal?.signalPriceUsd,
      signalTs: signal?.signalTs,
      expiresAt: signal?.expiresAt,
    });
  }

  function restoreStagedEntrySignalAfterBuyFail(
    mint: string,
    signal: {
      signalTs: number;
      signalPriceUsd: number;
      signalMarketCapUsd: number | null;
      holderCount: number | null;
      expiresAt: number;
    },
  ): void {
    stagedEntrySignals.set(mint, signal);
    journalLiveStrategy?.({
      kind: 'staged_entry_restored_after_buy_fail',
      mint,
      signalPriceUsd: signal.signalPriceUsd,
      signalTs: signal.signalTs,
      expiresAt: signal.expiresAt,
    });
  }

  function resolveLiveStagedEntrySignal(args: {
    mint: string;
    symbol: string;
    lane: string;
    source?: string;
    currentPriceUsd: number;
    marketCapUsd: number | null;
    holderCount: number | null;
  }):
    | {
        ok: true;
        signal: {
          signalTs: number;
          signalPriceUsd: number;
          signalMarketCapUsd: number | null;
          holderCount: number | null;
          expiresAt: number;
        };
      }
    | { ok: false } {
    if (!liveStagedEntryActive()) {
      const now = Date.now();
      return {
        ok: true,
        signal: {
          signalTs: now,
          signalPriceUsd: args.currentPriceUsd,
          signalMarketCapUsd: args.marketCapUsd,
          holderCount: args.holderCount,
          expiresAt: now,
        },
      };
    }
    const now = Date.now();
    const reanchorBlocked = isStagedEntryReanchorBlocked(args.mint);
    const plan = planLiveStagedEntrySignalResolution({
      existing: stagedEntrySignals.get(args.mint),
      now,
      currentPriceUsd: args.currentPriceUsd,
      marketCapUsd: args.marketCapUsd,
      holderCount: args.holderCount,
      reanchorBlocked,
      cfg,
    });

    if (plan.action === 'ttl_expired_clear') {
      stagedEntrySignals.delete(args.mint);
      journalLiveStrategy?.({
        kind: 'staged_entry_ttl_expired',
        mint: args.mint,
        symbol: args.symbol,
        lane: args.lane,
        source: args.source,
        signalPriceUsd: plan.expired.signalPriceUsd,
        signalTs: plan.expired.signalTs,
        expiresAt: plan.expired.expiresAt,
      });
      journalAppend({
        kind: 'eval-skip-open',
        lane: args.lane,
        source: args.source,
        mint: args.mint,
        symbol: args.symbol,
        reason: 'staged_entry_ttl_expired',
        stagedEntry: {
          signalPriceUsd: plan.expired.signalPriceUsd,
          currentPriceUsd: args.currentPriceUsd,
          expiresAt: plan.expired.expiresAt,
        },
      });
      return { ok: false };
    }

    if (plan.action === 'blocked_no_anchor') return { ok: false };

    let signal = plan.signal;

    if (plan.action === 'create_new') {
      stagedEntrySignals.set(args.mint, signal);
      if (resolveLiveOscar()?.liveCfg.executionMode === 'live') {
        cancelLivePostCloseTailSweepForMint(args.mint);
      }
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
        secondDropPct: cfg.liveStagedEntrySecondDropPct,
        thirdDropPct: cfg.liveStagedEntryThirdDropPct,
        expiresAt: signal.expiresAt,
      });
      if (isLiveOscarMainStrategyId(cfg.strategyId)) {
        notifyLiveStagedEntrySignal({
          mint: args.mint,
          symbol: args.symbol,
          marketCapUsd: signal.signalMarketCapUsd,
          holderCount: signal.holderCount,
        });
      }
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

    return { ok: true, signal };
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
            onMintFullClose: (mint) => {
              stagedEntrySignals.delete(mint);
            },
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
      BREAKEVEN_EXIT: 0,
      LIQ_DRAIN: 0,
      FLASH_CRASH_KILL: 0,
      RECONCILE_ORPHAN: 0,
      PERIODIC_HEAL: 0,
      CAPITAL_ROTATE: 0,
      WAVE_B_POST_TP1_SCRATCH: 0,
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
      resetLiveBuyTelegramSuppressTick();
      const liveOscarForTg = resolveLiveOscar();
      if (isLiveOscarMainStrategyId(cfg.strategyId) && liveOscarForTg?.liveCfg.executionMode === 'live') {
        await refreshLiveBuyTelegramSuppressForTick(
          liveOscarForTg.liveCfg,
          resolveLiveOscarEntrySplitLegUsd(cfg),
        );
      }
      if (cfg.strategyKind !== 'dip' && cfg.strategyKind !== 'smart_lottery') return;
      syncPriorityOpenMints(open.keys());
      const res =
        cfg.strategyKind === 'dip'
          ? isLiveOscarPresetCStrategyId(cfg.strategyId)
            ? await runPresetCDiscovery(cfg)
            : await runDipDiscovery(cfg)
          : await runSmartLotteryDiscovery(cfg);
      for (const row of res.auditRows ?? []) {
        journalAppend(row);
      }
      stats.discovered += res.discovered;
      stats.evaluated += res.evaluated;
      stats.passed += res.passed;
      if (isLiveOscarMainStrategyId(cfg.strategyId) && res.pgCoverageModeChanged) {
        notifyLiveOscarPgCoverageModeChange(res.pgCoverageModeChanged);
      }
      if (isLiveOscarMainStrategyId(cfg.strategyId)) {
        const near = res.decisions.filter((d) => !d.pass && isAwaitingDipQualityHold(d.reasons));
        updateNearReadyDipWatchlist(near.map((d) => ({ mint: d.mint, symbol: d.symbol ?? '?' })));
      }
      // Stage 1.1 shadow: feed the narrow watched/open mint set to the Shyft gRPC consumer (default OFF).
      if (cfg.liveOscarShyftShadowEnabled && isLiveOscarMainStrategyId(cfg.strategyId)) {
        const shadowMints = new Set<string>(open.keys());
        for (const d of res.decisions) shadowMints.add(d.mint);
        setShyftShadowWatchedMints(shadowMints);
      }
      const openedBeforeDiscoveryBatch = stats.opened;
      const btc = getBtcContext();

      await queuePresetCScalpDeferredEntries();
      for (const mint of pruneExpiredPresetCScalpPending(tickNow)) {
        journalAppend({
          kind: 'preset_c_scalp_pending_expired',
          mint,
          ts: tickNow,
        });
        removePresetCScalpPending(mint);
      }

      const scalpOpenDecisions: ScalpDiscoveryDecision[] = presetCScalpDeferredOpens.splice(0).map(
        (ready) => ({
          ...presetCScalpReadyToEvalDecision(ready),
          pass: true,
          reasons: [],
          _presetCScalpFromPending: ready,
        }),
      );
      const discoveryDecisions: ScalpDiscoveryDecision[] = [...scalpOpenDecisions, ...res.decisions];

      for (const d of discoveryDecisions) {
        const priorityFlag = res.priorityMintSet?.has(d.mint) ?? false;
        const deepAuditFlag =
          cfg.discoveryDeepAuditJsonl === true &&
          (priorityFlag || Boolean(cfg.discoveryDeepAuditWhitelistMintSet?.has(d.mint)));
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
          tradeLane: resolveDecisionTradeLane(d),
          _liveDiscoveryDeepAudit: deepAuditFlag,
          _priorityDiscovery: priorityFlag,
        });
        if (!d.pass && isOnlyLocalHighVetoReasons(d.reasons) && !open.has(d.mint)) {
          notifyLiveOscarLocalHighVetoOnly(d);
        }
        if (!d.pass && isOnlyVolumeEphemeralBlockReasons(d.reasons) && !open.has(d.mint)) {
          notifyLiveOscarVolumeEphemeralGuard(d);
        }
        if (!d.pass && isOnlyDataCoverageBlock(d.reasons) && !open.has(d.mint)) {
          notifyLiveOscarDataCoverageSkip(d);
        }
        if (!d.pass && handleFailedEntryRecheckDecision(d, tickNow)) continue;
        if (!d.pass) continue;
        if (
          cfg.mintBlacklistEnabled &&
          cfg.mintBlacklistPath?.trim() &&
          isMintBlacklisted(cfg.mintBlacklistPath.trim(), d.mint)
        ) {
          continue;
        }
        if (resolveDecisionTradeLane(d) === 'runner_probe') {
          const skipReason = runnerProbeMintOpenSkipReason({ open, mint: d.mint });
          if (skipReason) {
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              symbol: d.symbol,
              reason: skipReason,
              tradeLane: 'runner_probe',
            });
            continue;
          }
        } else if (open.has(d.mint)) {
          const incomingLane = resolveDecisionTradeLane(d);
          const existing = open.get(d.mint)!;
          const skipReason = liveOscarMintOpenSkipReason({
            open,
            mint: d.mint,
            incomingTradeLane: incomingLane,
            cfg,
          });
          if (skipReason === 'phase_escalation_handoff') {
            const escalated = applyLiveOscarPhaseEscalation({
              cfg,
              ot: existing,
              trigger: 'discovery_handoff',
              marketCapUsd: d.features.market_cap_usd ?? null,
              curPriceUsd: d.features.price_usd,
            });
            if (escalated) {
              const dropPct = computeDropFromScalpAnchor(existing, d.features.price_usd);
              journalAppend({
                kind: 'live_phase_escalation',
                mint: d.mint,
                symbol: d.symbol,
                lane: d.lane,
                source: d.source,
                fromLane: 'scalp_wave',
                toLane: 'prod',
                toTier: existing.liveOscarMcapTier,
                trigger: 'discovery_handoff',
                liveExitPolicyId: existing.liveExitPolicyId,
                ...(dropPct != null ? { dropFromEntryPct: +dropPct.toFixed(3) } : {}),
              });
              journalLiveStrategy?.({
                kind: 'live_phase_escalation',
                mint: d.mint,
                symbol: d.symbol,
                fromLane: 'scalp_wave',
                toLane: 'prod',
                toTier: existing.liveOscarMcapTier,
                trigger: 'discovery_handoff',
                openTrade: serializeOpenTrade(existing),
              });
            }
            continue;
          }
          journalAppend({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            symbol: d.symbol,
            reason: skipReason ?? 'already_open',
            tradeLane: incomingLane,
            openTradeLane: resolveLiveOscarTradeLaneFromOpen(existing),
          });
          continue;
        }
        if (
          resolveDecisionTradeLane(d) === 'runner_probe' &&
          countOpenRunnerProbePositions(open) >= cfg.runnerProbeMaxConcurrent
        ) {
          journalAppend({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            symbol: d.symbol,
            reason: 'runner_probe_max_concurrent',
            tradeLane: 'runner_probe',
            openRunnerProbe: countOpenRunnerProbePositions(open),
            maxRunnerProbe: cfg.runnerProbeMaxConcurrent,
          });
          continue;
        }
        if (
          resolveDecisionTradeLane(d) === 'runner_probe' &&
          sumRunnerProbeExposureUsd(open) + cfg.runnerProbePositionUsd >
            cfg.runnerProbeMaxExposureUsd + 1e-6
        ) {
          journalAppend({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            symbol: d.symbol,
            reason: 'runner_probe_max_exposure',
            tradeLane: 'runner_probe',
            runnerProbeExposureUsd: sumRunnerProbeExposureUsd(open),
            maxRunnerProbeExposureUsd: cfg.runnerProbeMaxExposureUsd,
          });
          continue;
        }
        if (
          resolveDecisionTradeLane(d) === 'scalp_wave' &&
          countOpenScalpWavePositions(open) >= cfg.liveOscarScalpWaveMaxConcurrent
        ) {
          journalAppend({
            kind: 'eval-skip-open',
            lane: d.lane,
            source: d.source,
            mint: d.mint,
            symbol: d.symbol,
            reason: 'scalp_wave_max_concurrent',
            tradeLane: 'scalp_wave',
            openScalpWave: countOpenScalpWavePositions(open),
            maxScalpWave: cfg.liveOscarScalpWaveMaxConcurrent,
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

        if (d._presetCScalpFromPending) {
          const scalpCfg = loadPresetCScalpConfig();
          const anchorPx = d._presetCScalpFromPending.signalPriceUsd;
          const quotePx = d.features.price_usd;
          if (presetCScalpFillTooDeep(anchorPx, quotePx, scalpCfg.maxFillDropPct)) {
            const dropPct = presetCScalpSignalDropPct(anchorPx, quotePx);
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              symbol: d.symbol,
              reason: PRESET_C_SCALP_FILL_TOO_DEEP_REASON,
              signalPriceUsd: anchorPx,
              quotePriceUsd: quotePx,
              signalDropPct: dropPct != null ? +dropPct.toFixed(3) : null,
              maxFillDropPct: scalpCfg.maxFillDropPct,
            });
            continue;
          }
        }

        if (
          isPresetCScalpModeEnabled(cfg) &&
          isLiveOscarPresetCStrategyId(cfg.strategyId) &&
          !d._presetCScalpFromPending
        ) {
          const tgKeys = matchingPresetCTelegramGateKeys(d.mint, tickNow);
          const pending = upsertPresetCScalpPendingFromDecision(d, tgKeys, tickNow);
          journalAppend({
            kind: 'preset_c_scalp_pending',
            mint: d.mint,
            symbol: d.symbol,
            lane: d.lane,
            source: d.source,
            signalPriceUsd: pending.signalPriceUsd,
            entryDropPct: loadPresetCScalpConfig().entryDropPct,
            dcaDropPct: loadPresetCScalpConfig().dcaDropPct,
            expiresAtMs: pending.expiresAtMs,
          });
          continue;
        }

        const liveOscarForEntryGates = resolveLiveOscar();
        if (liveOscarForEntryGates && isLiveOscarTradingStrategyId(cfg.strategyId)) {
          if (isMintPermanentlyDeniedLiveOscar(liveOscarForEntryGates.liveCfg, d.mint)) {
            stats.skippedLivePermanentDeny += 1;
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              symbol: d.symbol,
              reason: 'live_permanent_deny',
            });
            journalLiveStrategy?.({
              kind: 'live_permanent_deny_skip',
              mint: d.mint,
              symbol: d.symbol,
              lane: d.lane,
              source: d.source,
            });
            continue;
          }
        }
        if (
          liveOscarForEntryGates?.liveCfg.liveMintWhitelistEnabled &&
          !isPaperOscarFamilyStrategyId(cfg.strategyId)
        ) {
          if (!isMintOnLiveWhitelist(liveOscarForEntryGates.liveCfg.liveMintWhitelistPath, d.mint)) {
            stats.skippedLiveMintWhitelist += 1;
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              symbol: d.symbol,
              reason: 'live_mint_whitelist',
            });
            journalLiveStrategy?.({
              kind: 'live_whitelist_skip',
              mint: d.mint,
              symbol: d.symbol,
              lane: d.lane,
              source: d.source,
            });
            void notifyLiveMintWhitelistSkip(
              d.symbol,
              d.mint,
              liveOscarForEntryGates.liveCfg.liveMintWhitelistNotifyCooldownMs,
              d.features.market_cap_usd,
            );
            continue;
          }
        }

        observeStaleEntryPrice(d);
        observeShyftShadowEntryPrice(d);

        const tradeLane = resolveDecisionTradeLane(d);
        let stagedEntrySignal: Awaited<ReturnType<typeof resolveLiveStagedEntrySignal>> | null = null;
        if (liveStagedEntryActiveForDecision(d)) {
          stagedEntrySignal = resolveLiveStagedEntrySignal({
            mint: d.mint,
            symbol: d.symbol,
            lane: d.lane,
            source: d.source,
            currentPriceUsd: d.features.price_usd,
            marketCapUsd: d.features.market_cap_usd ?? null,
            holderCount: d.features.holders ?? null,
          });
          if (!stagedEntrySignal.ok) continue;
        }

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
        const openLegUsd =
          d._presetCScalpFromPending != null
            ? loadPresetCScalpConfig().entryUsd
            : tradeLane === 'scalp_wave'
              ? liveOscarScalpWaveOpenLegUsd(cfg)
              : tradeLane === 'runner_probe'
                ? runnerProbeOpenLegUsd(cfg)
                : liveStagedEntryActiveForDecision(d)
                ? liveOscarDiscoveryBuyLegUsd(d, d.liveOscarMcapTier)
                : undefined;
        let ot = makeOpenTradeFromEntry({
          cfg,
          row,
          lane: d.lane,
          dex,
          liquidityUsd: d.features.liq_usd,
          ...(openLegUsd != null && openLegUsd > 0 ? { firstLegUsdOverride: openLegUsd } : {}),
        });
        stampLiveOscarTradeLaneOnOpen(ot, tradeLane);
        if (tradeLane === 'runner_probe') stampRunnerProbeOnOpen(ot);
        if (liveStagedEntryActiveForDecision(d) && stagedEntrySignal?.ok) {
          attachLiveStagedEntryPlan(
            ot,
            d.mint,
            {
              signalTs: stagedEntrySignal.signal.signalTs,
              signalPriceUsd: stagedEntrySignal.signal.signalPriceUsd,
            },
            d.features.market_cap_usd,
            d.liveOscarMcapTier === 'scalp_wave' ? undefined : d.liveOscarMcapTier,
          );
        }
        if (d._presetCScalpFromPending) {
          ot.presetCScalpAnchorPriceUsd = d._presetCScalpFromPending.signalPriceUsd;
          if (d._presetCScalpFromPending.tgDedupeKeys?.length) {
            ot.presetCTgDedupeKeys = [...d._presetCScalpFromPending.tgDedupeKeys];
          }
          const scalpCfgPost = loadPresetCScalpConfig();
          const fillPx = ot.avgEntryMarket > 0 ? ot.avgEntryMarket : ot.legs[0]?.marketPrice ?? 0;
          if (
            fillPx > 0 &&
            presetCScalpFillTooDeep(
              d._presetCScalpFromPending.signalPriceUsd,
              fillPx,
              scalpCfgPost.maxFillDropPct,
            )
          ) {
            const dropPct = presetCScalpSignalDropPct(
              d._presetCScalpFromPending.signalPriceUsd,
              fillPx,
            );
            journalAppend({
              kind: 'eval-skip-open',
              lane: d.lane,
              source: d.source,
              mint: d.mint,
              symbol: d.symbol,
              reason: PRESET_C_SCALP_FILL_TOO_DEEP_REASON,
              signalPriceUsd: d._presetCScalpFromPending.signalPriceUsd,
              fillPriceUsd: fillPx,
              signalDropPct: dropPct != null ? +dropPct.toFixed(3) : null,
              maxFillDropPct: scalpCfgPost.maxFillDropPct,
            });
            continue;
          }
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
              sizeUsd: openLegUsd ?? cfg.positionUsd * cfg.entryFirstLegFraction,
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
            const jupLegUsd =
              tradeLane === 'scalp_wave'
                ? liveOscarScalpWaveOpenLegUsd(cfg)
                : liveStagedEntryActiveForDecision(d)
                  ? liveOscarDiscoveryBuyLegUsd(d, d.liveOscarMcapTier)
                  : undefined;
            ot = makeOpenTradeFromEntry({
              cfg,
              row: rowJ,
              lane: d.lane,
              dex,
              liquidityUsd: d.features.liq_usd,
              entryTs: ot.entryTs,
              ...(jupLegUsd != null && jupLegUsd > 0 ? { firstLegUsdOverride: jupLegUsd } : {}),
            });
            stampLiveOscarTradeLaneOnOpen(ot, tradeLane);
            if (tradeLane === 'runner_probe') stampRunnerProbeOnOpen(ot);
            if (liveStagedEntryActiveForDecision(d) && stagedEntrySignal?.ok) {
              attachLiveStagedEntryPlan(
                ot,
                ot.mint,
                {
                  signalTs: stagedEntrySignal.signal.signalTs,
                  signalPriceUsd: stagedEntrySignal.signal.signalPriceUsd,
                },
                d.features.market_cap_usd,
                d.liveOscarMcapTier === 'scalp_wave' ? undefined : d.liveOscarMcapTier,
              );
              applyCanonicalOpenLegUsd(cfg, ot);
            }
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
        if (cfg.dynamicKillstopShadowEnabled) {
          try {
            ot.dynamicKillstopShadow = await computeDynamicKillstopShadowForOpen({ cfg, ot });
          } catch (e) {
            logger.warn(
              { err: (e as Error)?.message ?? String(e), mint: ot.mint },
              'dynamicKillstopShadow failed',
            );
          }
        }
        /**
         * Live Oscar: режим A/B не ставим на входе — сплит 75%+25% обязателен и не является DCA.
         * A включается трекером при первой ступени TP-сетки; B — при реальном DCA по просадке.
         */
        if (
          cfg.liveExitModeAbEnabled &&
          !isPaperOscarIdealizedStackStrategyId(cfg.strategyId) &&
          !isLiveOscarTradingStrategyId(cfg.strategyId)
        ) {
          ot.liveExitProfileMode = 'A';
        }

        const liveOscar = liveOscarForEntryGates ?? resolveLiveOscar();
        if (liveOscar && isLiveOscarTradingStrategyId(cfg.strategyId)) {
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
              d.features.market_cap_usd,
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
          stagedEntryBuyInFlight.add(d.mint);
          let opened: Awaited<ReturnType<typeof liveOscar.discovery.tryExecuteBuyOpen>>;
          try {
            opened = await liveOscar.discovery.tryExecuteBuyOpen({
              liveCfg: liveOscar.liveCfg,
              paperCfg: cfg,
              ot,
              decision: d,
              snapshotEntryPriceUsd,
              tokenDecimals,
            });
          } finally {
            stagedEntryBuyInFlight.delete(d.mint);
          }
          if (!opened.ok) {
            if (liveStagedEntryActiveForDecision(d) && stagedEntrySignal?.ok) {
              restoreStagedEntrySignalAfterBuyFail(d.mint, stagedEntrySignal.signal);
            }
            continue;
          }
          applyLiveBuyAnchorsAfterOpen(ot, opened);
          if (opened.copyToOscarPromotion) {
            applyCopyToOscarPromotionAccounting({
              ot,
              cfg,
              res: opened,
              plan: opened.copyToOscarPromotion,
              snapshotPriceUsd: snapshotEntryPriceUsd,
            });
            journalLiveStrategy?.({
              kind: 'copy_to_oscar_promotion',
              mint: ot.mint,
              symbol: ot.symbol,
              copyCostBasisUsd: opened.copyToOscarPromotion.copyCostBasisUsd,
              walletGrossUsd: opened.copyToOscarPromotion.walletGrossUsd,
              targetUsd: opened.copyToOscarPromotion.targetUsd,
              topUpUsd: opened.copyToOscarPromotion.topUpUsd,
              tier: opened.copyToOscarPromotion.tier,
            });
          }
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

        if (isLiveOscarTradingStrategyId(cfg.strategyId)) stampLiveOscarExitPolicyOnOpen(ot, cfg);
        if (isLiveOscarPresetCStrategyId(cfg.strategyId) && !d._presetCScalpFromPending) {
          stampPresetCTgDedupeKeysOnOpen(ot);
        }

        open.set(resolveOpenMapKey(ot), ot);
        if (d._presetCScalpFromPending) {
          markPresetCScalpPendingEntryDone(d.mint);
          removePresetCScalpPending(d.mint);
          journalAppend({
            kind: 'preset_c_scalp_entry',
            mint: d.mint,
            symbol: d.symbol,
            signalPriceUsd: d._presetCScalpFromPending.signalPriceUsd,
            entryPriceUsd: d.features.price_usd,
            signalDropPct: +d._presetCScalpFromPending.signalDropPct.toFixed(3),
            entryUsd: loadPresetCScalpConfig().entryUsd,
          });
        }
        if (liveStagedEntryActiveForDecision(d) && stagedEntrySignal?.ok) {
          clearStagedEntrySignalForConfirmedBuy(ot.mint, {
            signalTs: ot.liveStagedEntry?.signalTs ?? ot.entryTs,
            signalPriceUsd: ot.liveStagedEntry?.signalPriceUsd ?? ot.legs[0]?.marketPrice ?? 0,
            expiresAt: liveStagedEntrySignalExpiresAt(cfg, ot.liveStagedEntry?.signalTs ?? ot.entryTs),
          });
        }
        const liveOscarForJournal = resolveLiveOscar();
        const liveOpenExtras: Record<string, unknown> =
          liveOscarForJournal && liveStagedEntryActiveForDecision(d)
            ? (() => {
                const sigPx = ot.liveStagedEntry?.signalPriceUsd ?? 0;
                const targetUsd = (dropPct: number): number | null =>
                  sigPx > 0 ? +(sigPx * (1 - dropPct / 100)).toFixed(8) : null;
                const v2Split = cfg.liveStagedEntryEntrySplitLegUsd > 0;
                const firstProbe = ot.liveMintFirstProbe === true;
                const killDropPct = firstProbe
                  ? (ot.liveMintFirstProbeKillDropPct ?? ot.liveStagedEntry?.killDropPct ?? 7)
                  : cfg.liveStagedEntryKillDropPct;
                const tradeTier = ot.liveOscarMcapTier;
                const totalNotional = firstProbe
                  ? cfg.liveStagedEntryEntrySplitLegUsd * 2
                  : v2Split
                    ? stagedEntryPlanInvestedCapUsd(cfg, tradeTier, ot.entryMarketCapUsd)
                    : cfg.liveStagedEntryFirstLegUsd +
                      cfg.liveStagedEntrySecondLegUsd +
                      cfg.liveStagedEntryThirdLegUsd;
                const sharedParams = {
                  signalPriceUsd: sigPx > 0 ? sigPx : null,
                  entrySplitV2: v2Split,
                  ...(firstProbe ? { mintFirstProbe: true } : {}),
                  killDropPct,
                  killTargetUsd: targetUsd(killDropPct),
                  signalTtlMs: cfg.liveStagedEntrySignalTtlMs,
                  totalNotionalUsd: totalNotional,
                  tpGridProfile: cfg.tpGridSellFractionByStep ?? [],
                  tpGridStepPnl: cfg.tpGridStepPnl,
                  tpGridFirstRungRetraceMinPnlPct: cfg.tpGridFirstRungRetraceMinPnlPct,
                  liveExitPolicyId: ot.liveExitPolicyId ?? 'legacy_grid',
                  avgKillstopPct: cfg.dcaKillstop,
                  policyAPlusEnabled: cfg.policyAPlusEnabled,
                };
                if (v2Split) {
                  const leg1 = cfg.liveStagedEntryEntrySplitLegUsd;
                  const leg2 =
                    cfg.liveStagedEntryEntrySplitLeg2Usd > 0
                      ? cfg.liveStagedEntryEntrySplitLeg2Usd
                      : leg1;
                  const firstDrop = cfg.liveStagedEntryFirstDropPct;
                  const leg1When =
                    firstDrop > 0 ? `при −${firstDrop}% от сигнала` : 'по сигналу';
                  const leg3Usd = firstProbe ? 0 : resolveLiveOscarStagedAvgLegUsd(cfg, tradeTier, ot.entryMarketCapUsd);
                  const leg3Drop = firstProbe ? 0 : cfg.liveStagedEntrySecondDropPct;
                  const leg3Suffix =
                    leg3Usd > 0 && leg3Drop > 0
                      ? `; 3-я нога ${leg3Usd.toFixed(0)} USD при −${leg3Drop}% от сигнала`
                      : '';
                  const description = firstProbe
                    ? `${cfg.strategyId} first-mint-probe: split ${leg1.toFixed(0)}+${leg1.toFixed(0)} USD, kill −${killDropPct}% от сигнала, без усреднения; при убытке → denylist, при прибыли → обычный режим.`
                    : cfg.liveStagedEntryEntrySplitTargetDropPct > 0
                      ? `${cfg.strategyId} entry-split v2: 1-я нога ${leg1.toFixed(0)} USD ${leg1When}; 2-я нога ${leg2.toFixed(0)} USD при −${cfg.liveStagedEntryEntrySplitTargetDropPct}% от сигнала${leg3Suffix}; kill −${killDropPct}% от сигнала.`
                      : `${cfg.strategyId} entry-split v2: нотионал до $${totalNotional.toFixed(0)}. ` +
                        `1-я нога сплита ${leg1.toFixed(0)} USD ${leg1When}; 2-я нога сплита ${leg2.toFixed(0)} USD через ${(cfg.liveStagedEntryEntrySplitDelayMs / 1000).toFixed(0)} с в коридоре +${cfg.liveStagedEntryEntrySplitMaxUpPct}%…−${cfg.liveStagedEntryEntrySplitMaxDownPct}% к якорю (не усреднение). ` +
                        `1-е усреднение $${cfg.liveStagedEntrySecondLegUsd.toFixed(0)} при −${cfg.liveStagedEntrySecondDropPct}%…−${cfg.liveStagedEntryThirdDropPct}% от сигнала (≥${(cfg.liveStagedEntryAvgCooldownMs / 60_000).toFixed(0)} мин). ` +
                        `2-е усреднение $${cfg.liveStagedEntryThirdLegUsd.toFixed(0)} при ≤−${cfg.liveStagedEntryThirdDropPct}% (≥${(cfg.liveStagedEntryAvgSecondCooldownMs / 60_000).toFixed(0)} мин после 1-го).`;
                  return {
                    timelineOpenLabelRu: firstProbe
                      ? `Первый live-вход: split $${leg1.toFixed(0)}+$${leg1.toFixed(0)}, kill −${killDropPct}%`
                      : liveStagedOpenLabelRuFromCfg(cfg),
                    liveStagedEntryParams: {
                      ...sharedParams,
                      firstLegUsd: leg1,
                      entrySplitLegUsd: leg1,
                      entrySplitLeg2Usd: leg2,
                      firstDropPct: firstDrop,
                      entrySplitDelayMs: cfg.liveStagedEntryEntrySplitDelayMs,
                      entrySplitMaxUpPct: cfg.liveStagedEntryEntrySplitMaxUpPct,
                      entrySplitMaxDownPct: cfg.liveStagedEntryEntrySplitMaxDownPct,
                      entrySplitTargetDropPct: cfg.liveStagedEntryEntrySplitTargetDropPct,
                      avgSecondLegUsd: firstProbe ? 0 : resolveLiveOscarStagedAvgLegUsd(cfg, tradeTier, ot.entryMarketCapUsd),
                      avgSecondDropPct: firstProbe ? 0 : cfg.liveStagedEntrySecondDropPct,
                      avgThirdLegUsd: firstProbe ? 0 : cfg.liveStagedEntryThirdLegUsd,
                      avgThirdDropPct: firstProbe ? 0 : cfg.liveStagedEntryThirdDropPct,
                      description,
                    },
                  };
                }
                const dcaParts: string[] = [];
                if (cfg.liveStagedEntrySecondLegUsd > 0) {
                  dcaParts.push(
                    `$${cfg.liveStagedEntrySecondLegUsd.toFixed(0)} на −${cfg.liveStagedEntrySecondDropPct}%`,
                  );
                }
                if (cfg.liveStagedEntryThirdLegUsd > 0) {
                  dcaParts.push(
                    `$${cfg.liveStagedEntryThirdLegUsd.toFixed(0)} на −${cfg.liveStagedEntryThirdDropPct}%`,
                  );
                }
                const description =
                  `${cfg.strategyId} staged-entry (legacy): полный нотионал $${totalNotional.toFixed(0)}. ` +
                  `Первая нога $${cfg.liveStagedEntryFirstLegUsd.toFixed(0)} по сигналу; ` +
                  (dcaParts.length > 0
                    ? liveStagedEntrySignalTtlEnabled(cfg)
                      ? `DCA: ${dcaParts.join(' и ')} (${(cfg.liveStagedEntrySignalTtlMs / 60_000).toFixed(0)} мин). `
                      : `DCA: ${dcaParts.join(' и ')}. `
                    : '') +
                  `kill −${cfg.liveStagedEntryKillDropPct}% от сигнала.`;
                return {
                  timelineOpenLabelRu:
                    cfg.liveStagedEntryFirstDropPct <= 0
                      ? `Первая нога $${cfg.liveStagedEntryFirstLegUsd.toFixed(0)} по сигналу`
                      : `Первая нога $${cfg.liveStagedEntryFirstLegUsd.toFixed(0)} на −${cfg.liveStagedEntryFirstDropPct}% от сигнала`,
                  liveStagedEntryParams: {
                    ...sharedParams,
                    firstDropPct: cfg.liveStagedEntryFirstDropPct,
                    firstLegUsd: cfg.liveStagedEntryFirstLegUsd,
                    firstTargetUsd: targetUsd(cfg.liveStagedEntryFirstDropPct),
                    secondDropPct: cfg.liveStagedEntrySecondDropPct,
                    secondLegUsd: cfg.liveStagedEntrySecondLegUsd,
                    secondTargetUsd:
                      cfg.liveStagedEntrySecondLegUsd > 0
                        ? targetUsd(cfg.liveStagedEntrySecondDropPct)
                        : null,
                    thirdDropPct: cfg.liveStagedEntryThirdDropPct,
                    thirdLegUsd: cfg.liveStagedEntryThirdLegUsd,
                    thirdTargetUsd:
                      cfg.liveStagedEntryThirdLegUsd > 0
                        ? targetUsd(cfg.liveStagedEntryThirdDropPct)
                        : null,
                    description,
                  },
                };
              })()
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
          entryPath: d.entryPath ?? null,
          runnerFeatures: d.entryPath === 'runner' ? (d.features?.runner ?? null) : null,
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
          onMintFullClose: (mint) => {
            stagedEntrySignals.delete(mint);
            removePresetCScalpPending(mint);
          },
          processPresetCScalpDeferredEntries: async () => {
            await queuePresetCScalpDeferredEntries();
            if (presetCScalpDeferredOpens.length > 0 && !discoveryRunning) {
              await withTimeout(discoveryTick(), 60_000, 'discoveryTickScalpDeferred');
            }
          },
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
      open,
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

  const entrySplitFastPollTimer = liveStagedEntryActive()
    ? startEntrySplitFastPoll({
        paperCfg: cfg,
        getOpen: () => open,
        isTrackerBusy: () => trackerRunning,
        journalAppend,
        journalLiveStrategy: opts?.journalLiveStrategy,
        resolveLivePhase4: () => resolveLiveOscar()?.tracker,
        resolveLiveOscarCfg: () => resolveLiveOscar()?.liveCfg,
      })
    : null;

  const liveOpenHotTickTimer = opts?.liveOpenPositionHotTickFactory?.({
    paperCfg: cfg,
    getOpen: () => open,
    isTrackerBusy: () => trackerRunning,
    runTrackerTick: () =>
      withTimeout(
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
          onMintFullClose: (mint) => {
            stagedEntrySignals.delete(mint);
            removePresetCScalpPending(mint);
          },
          processPresetCScalpDeferredEntries: async () => {
            await queuePresetCScalpDeferredEntries();
            if (presetCScalpDeferredOpens.length > 0 && !discoveryRunning) {
              await withTimeout(discoveryTick(), 60_000, 'discoveryTickScalpDeferredHot');
            }
          },
        }),
        45_000,
        'trackerTickHot',
      ),
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
    stopEntrySplitFastPoll(entrySplitFastPollTimer);
    if (liveOpenHotTickTimer) clearInterval(liveOpenHotTickTimer);
    clearInterval(solTimer);
    clearInterval(btcTimer);
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
