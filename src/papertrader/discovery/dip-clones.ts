import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow, SnapshotFeatures, WhaleAnalysis } from '../types.js';
import { snapshotRowTsMs } from '../stale-price.js';
import { getShyftShadowStreamPrice, isShyftShadowEnabled } from '../stream/shadow-state.js';
import { resolvePrimaryPriceUsd, buildPricePrimaryEvent } from '../stream/price-primary.js';
import { resolveShyftDefiMcap, type ShyftDefiMcapResult } from '../stream/shyft-defi-mcap.js';
import {
  resolveDiscoveryMarketQuote,
  buildBirdeyeCoverageGapEvent,
  buildBirdeyeTierInsufficientEvent,
  isFreshExternalDiscoveryQuote,
  type DiscoveryQuoteSource,
} from '../pricing/discovery-market-quote.js';
import { fetchLatestCrossVenueSnapshotRowForMint, fetchSnapshotLaneCandidates } from './snapshot.js';
import { dedupeSnapshotTaggedByMintCanonical } from './snapshot-canonical-pick.js';
import { discoverySnapshotSanityCfg } from './snapshot-row-sanity.js';
import { explainCrowdedOutOnly, explainPostLaneUniverseMiss } from './universe-miss-explain.js';
import {
  evaluateSnapshot,
  passesDiscoveryMinMarketCap,
  passesDiscoveryMaxMarketCap,
  evaluateSnapshotPriorityTier,
  resolveDiscoveryRefMcap,
} from '../filters/snapshot-filter.js';
import { globalGate } from '../filters/global-gate.js';
import {
  fetchDipContextMap,
  evaluateDip,
  evaluateLocalHighVeto,
  evaluateRecoveryVeto,
  type LocalHighVetoResult,
  type RecoveryVetoResult,
} from '../dip-detector.js';
import {
  evaluateStressKillReentryPath,
  getStressKillReentryContext,
} from './stress-kill-reentry.js';
import { fetchWhaleAnalysis } from '../whale-analysis.js';
import { resolveHolderCount } from '../holders/holders-resolve.js';
import { impulsePgSnapTriggerOk } from '../pricing/impulse-confirm.js';
import { filterSnapshotTaggedByMintBlacklist, isMintBlacklisted } from './mint-blacklist-file.js';
import {
  fetchPolicyAPlusContextMap,
  evaluatePolicyAPlus,
  type PolicyAPlusFeatures,
} from './policy-a-plus.js';
import {
  fetchPostCrashContextMap,
  evaluatePostCrashFastPath,
  shouldBypassLocalHighVetoForPostCrash,
  type PostCrashFastPathResult,
} from './post-crash-fast-path.js';
import {
  fetchTrendStructureContextMap,
  evaluateTrendStructureVeto,
  type TrendStructureVetoResult,
} from './trend-structure-veto.js';
import {
  fetchVolumeSybilContextMap,
  evaluateVolumeSybilGuard,
  type VolumeSybilFeatures,
} from './volume-sybil-guard.js';
import {
  fetchVolumeEphemeralContextMap,
  evaluateVolumeEphemeralGuard,
  type VolumeEphemeralFeatures,
} from './volume-ephemeral-guard.js';
import {
  fetchGlobalPgCoverageState,
  fetchMintPgCoverageMap,
  evaluatePgDataCoverageGuard,
  type MintPgCoverageFeatures,
} from './pg-data-coverage-guard.js';
import { injectWhitelistDiscoveryCandidates } from './whitelist-discovery-inject.js';
import { writeDiscoveryCollectorPinMints } from './discovery-collector-pin.js';
import { injectPriorityDiscoveryCandidates } from './priority-discovery-inject.js';
import {
  buildPriorityDiscoveryMintSet,
  getPriorityOpenMints,
} from './priority-discovery-registry.js';
import {
  isLiveOscarMcapTieringEnabled,
  liveOscarBelowMcapThresholdUsd,
  liveOscarTierEntryConfig,
  resolveLiveOscarMcapTier,
  type LiveOscarMcapTier,
  type LiveOscarTradeTier,
} from '../live-oscar-mcap-tier.js';
import {
  evaluateLiveOscarScalpWaveDiscovery,
  isLiveOscarScalpWaveLaneEnabled,
} from '../live-oscar-scalp-wave.js';
import {
  evaluateLiveOscarRunnerProbeDiscovery,
  isRunnerProbeLaneEnabled,
  runnerProbeCandidateInBand,
  runnerProbeRunnerFetchConfig,
  summariseRunnerPass,
  type RunnerProbeDiscoveryEval,
} from '../live-oscar-runner-probe.js';
import {
  evaluateLiveOscarRunnerLiteDiscovery,
  isRunnerLiteLaneEnabled,
  runnerLiteDiscoveryPrefilter,
  runnerLiteRunnerFetchConfig,
  type RunnerLiteDiscoveryEval,
} from '../live-oscar-runner-lite.js';
import {
  evaluateLiveOscarPervyyVystrelDiscovery,
  isPervyyVystrelObservabilityActive,
  pervyyVystrelDiscoveryPrefilter,
} from '../live-oscar-pervyy-vystrel.js';
import {
  resolveDiscoveryHardMcapMinUsd,
  resolveDiscoverySqlMinMarketCapUsd,
} from './discovery-mcap-floor.js';
import {
  evaluateOscarIntelGateForRunnerProbe,
  evaluateOscarIntelGateForRunnerLite,
  evaluateOscarIntelGateForProd,
  oscarIntelGateSnapshotFromResult,
  type OscarIntelGateSnapshot,
} from './oscar-intel-gate.js';
import { injectVolumeLeaderCandidates } from './volume-leader-inject.js';
import { refreshPriorityMintPricesFromJupiter } from './priority-dip-price-refresh.js';
import { crossCheckVolumeLeaderSnapshotsFromJupiter } from './volume-leader-jupiter-crosscheck.js';
import { refreshNearMissDipPricesFromJupiter } from './near-miss-dip-jupiter-refresh.js';
import { shouldEvaluateMint } from './discovery-eval-throttle.js';
import {
  fetchRunnerContextMap,
  evaluateRunner,
  type RunnerWindowFeatures,
} from './runner-mode.js';
import {
  buildKnownMintTradeHistory,
  isFamiliarMint,
  isKnownMint,
  isPgCoverageKnownMint as isPgCoverageKnownMintFromHistory,
} from './known-mint.js';
import { scaleMcapWithPrice } from '../pricing/mcap-snapshot.js';
import { isLiveOscarDiscoveryQuoteStrategyId } from '../../preset-c/live-oscar-family.js';

function syncDiscoveryCollectorPin(cfg: PaperTraderConfig, priorityMintSet: ReadonlySet<string>): void {
  if (cfg.strategyId !== 'live-oscar') return;
  try {
    writeDiscoveryCollectorPinMints(priorityMintSet);
  } catch {
    /* non-fatal — collectors keep last pin file */
  }
}

export interface HoldersDecisionMeta {
  holders_db: number;
  holders_live: number | null;
  holders_source: 'qn_addon' | 'qn_gpa' | 'cache_pos' | 'db' | 'none';
  holders_age_ms: number | null;
  holders_fail_reason?: string;
  holders_used_for_gate: number;
}

export interface EvalDecision {
  lane: Lane;
  source: string;
  mint: string;
  symbol: string;
  ageMin: number;
  pass: boolean;
  reasons: string[];
  features: SnapshotFeatures;
  whale: WhaleAnalysis | null;
  holdersMeta?: HoldersDecisionMeta;
  /**
   * Как пройден входной гейт цены (если применимо):
   *  - `dip_windows`     — классический dip-фильтр + recovery/localHigh/policyA+
   *  - `impulse_pg_snap` — bypass через PG-snap impulse confirm (`PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP`)
   *  - `runner`          — параллельный Runner Mode (1.11.232): магнит открытого интереса по 1h/12h/24h
   */
  entryPath?:
    | 'dip_windows'
    | 'impulse_pg_snap'
    | 'runner'
    | 'post_crash_fast'
    | 'stress_kill_reentry'
    | 'preset_c_pullback'
    | 'preset_c_spike';
  /** `micro` = $500k–$1.3M; `low` = $1.3M–$3M; `prod` = mcap ≥ $3M; `scalp_wave` = shallow scalp lane. */
  liveOscarMcapTier?: LiveOscarTradeTier;
  /** Mutex trade lane: `prod` (staged Oscar) vs `scalp_wave` ($300 one-shot); runner lanes parallel. */
  liveOscarTradeLane?: 'prod' | 'scalp_wave' | 'runner_probe' | 'runner_lite' | 'pervyy_vystrel';
  positionSource?: 'runner_probe' | 'runner_lite' | 'pervyy_vystrel';
  /** Wallet-intel gate snapshot (prod / runner_probe / runner_lite). */
  oscarIntel?: OscarIntelGateSnapshot;
  /** PR3 — watchlist state machine shadow telemetry. */
  pervyyVystrel?: {
    phase: string;
    wouldOnboard: boolean;
    shadowMode: boolean;
    watchlistActive?: boolean;
    phantomGatesPass?: boolean;
    volAuth?: {
      washScore: number | null;
      organicScore: number | null;
      pass: boolean;
      insufficientData: boolean;
    };
    organicFlow?: {
      uniqueBuyers1h: number | null;
      clusterBuyerRatio: number | null;
      unclusteredBuyers: number | null;
      pass: boolean;
    };
    clusterDump?: {
      clusterSellRatio: number | null;
      clusterUniqueSellers: number | null;
      pass: boolean;
    };
  };
}

export interface DiscoveryTickResult {
  discovered: number;
  evaluated: number;
  passed: number;
  decisions: EvalDecision[];
  /** Live deep audit rows (flushed via `journalAppend` in `papertrader/main`). */
  auditRows?: Record<string, unknown>[];
  /** PG coverage guard mode flip this tick (for ADVICE Telegram). */
  pgCoverageModeChanged?: 'full' | 'relaxed' | null;
  /** Priority tier mint set this tick (open + near-ready + recent eval + SQL pool). */
  priorityMintSet?: Set<string>;
}

const deepAuditLastLogMs = new Map<string, number>();

function allowDeepAuditLog(key: string, minMs: number): boolean {
  const now = Date.now();
  const prev = deepAuditLastLogMs.get(key) ?? 0;
  if (now - prev < minMs) return false;
  deepAuditLastLogMs.set(key, now);
  return true;
}

export { evaluatedAtMap } from './discovery-eval-throttle.js';
export const lastEntryTsByMintMap = new Map<string, number>();
/** Последний `exitTs` полного закрытия по mint (ms) — пауза перед повторным входом в тот же mint. */
export const lastPostExitBuyCooldownTsByMintMap = new Map<string, number>();

export type LastExitMarketSnapshot = {
  exitTs: number;
  marketUsd: number;
  netPnlUsd?: number;
  exitReason?: string;
};

/** Рыночная цена последнего полного выхода (USD/token) — гейт повторного входа vs снимок. */
export const lastExitMarketSnapshotByMintMap = new Map<string, LastExitMarketSnapshot>();

/** Last on-chain / policy exit (never RECONCILE_ORPHAN / PERIODIC_HEAL) — source of truth for re-entry gates. */
export const lastRealExitMarketSnapshotByMintMap = new Map<string, LastExitMarketSnapshot>();

/** Ledger-only closes must not replace a recent real exit price (FLASH → RECONCILE ~seconds later). */
const ADMIN_LEDGER_EXIT_REASONS = new Set(['RECONCILE_ORPHAN', 'PERIODIC_HEAL']);
const RECONCILE_REENTRY_GRACE_MS = 10 * 60_000;

export function isAdminLedgerExitReason(exitReason?: string): boolean {
  return !!exitReason && ADMIN_LEDGER_EXIT_REASONS.has(exitReason);
}

/** Snapshot used by post-exit dip/cooldown gates (ignores admin-only ledger closes when a real exit exists). */
export function reentryExitSnapshotForGate(mint: string): LastExitMarketSnapshot | undefined {
  const real = lastRealExitMarketSnapshotByMintMap.get(mint);
  if (real) return real;
  const snap = lastExitMarketSnapshotByMintMap.get(mint);
  if (!snap || isAdminLedgerExitReason(snap.exitReason)) return undefined;
  return snap;
}

function postExitBuyCooldownResumeAtMs(
  cfg: PaperTraderConfig,
  exitTsMs: number,
): number {
  const lossMin = cfg.dipLossExitCooldownMinutes;
  const lossH = cfg.dipLossExitCooldownHours;
  if (Number(lossMin) > 0) return exitTsMs + lossMin * 60_000;
  if (Number(lossH) > 0) return exitTsMs + lossH * 3_600_000;
  return 0;
}

export function isPostExitBuyCooldownActive(
  cfg: PaperTraderConfig,
  mint: string,
  nowMs = Date.now(),
): boolean {
  if (!cfg.dipLossExitCooldownEnabled) return false;
  const snap = reentryExitSnapshotForGate(mint);
  const exitTs = snap?.exitTs ?? lastPostExitBuyCooldownTsByMintMap.get(mint) ?? 0;
  if (exitTs <= 0) return false;
  const resumeAt = postExitBuyCooldownResumeAtMs(cfg, exitTs);
  return resumeAt > 0 && nowMs < resumeAt;
}

/** Legacy price-gap path: ceiling only during post-exit cooldown. */
function shouldApplyPostExitReentryPriceGate(
  cfg: PaperTraderConfig,
  _mint: string,
  snap: LastExitMarketSnapshot,
  nowMs: number,
): boolean {
  if (!cfg.dipLossExitCooldownEnabled) return false;
  const resumeAt = postExitBuyCooldownResumeAtMs(cfg, snap.exitTs);
  return resumeAt > 0 && nowMs < resumeAt;
}

function isPostExitReentryForkExpired(
  cfg: PaperTraderConfig,
  snap: LastExitMarketSnapshot,
  nowMs: number,
): boolean {
  const maxAgeH = cfg.liveReentryGateMaxAgeHours;
  if (!(maxAgeH > 0)) return false;
  return nowMs - snap.exitTs > maxAgeH * 3_600_000;
}

function resolvePostExitReentryDropPct(cfg: PaperTraderConfig, lossExit: boolean): number {
  const base = cfg.liveReentryMinDropFromLastExitPct;
  if (!lossExit) return base;
  const lossMin = cfg.liveReentryLossMinDropFromLastExitPct;
  return lossMin > 0 ? Math.max(base, lossMin) : base;
}

export type PostExitReentryForkResult =
  | { kind: 'inactive' }
  | { kind: 'expired' }
  | { kind: 'breakout'; lastExit: number; snap: number; breakoutPct: number }
  | { kind: 'dip_ok'; lastExit: number; snap: number; dropPct: number }
  | { kind: 'wait_dip'; lastExit: number; snap: number; maxBuy: number; dropPct: number };

/** Fork: block between exit and −N% dip; allow at/below −N%; +M% breakout → standard dip eval. */
export function evaluatePostExitReentryFork(
  cfg: PaperTraderConfig,
  snap: LastExitMarketSnapshot,
  snapshotPriceUsd: number,
  nowMs = Date.now(),
): PostExitReentryForkResult {
  if (!(snap.marketUsd > 0) || !(snapshotPriceUsd > 0)) return { kind: 'inactive' };
  if (isPostExitReentryForkExpired(cfg, snap, nowMs)) return { kind: 'expired' };

  const breakoutPct = cfg.liveReentryBreakoutAboveExitPct;
  if (breakoutPct > 0 && snapshotPriceUsd >= snap.marketUsd * (1 + breakoutPct / 100) * (1 - 1e-9)) {
    return {
      kind: 'breakout',
      lastExit: snap.marketUsd,
      snap: snapshotPriceUsd,
      breakoutPct,
    };
  }

  const dropPct = resolvePostExitReentryDropPct(cfg, lastExitWasLossOrStress(snap));
  const maxBuy = snap.marketUsd * (1 - dropPct / 100);
  if (snapshotPriceUsd <= maxBuy * (1 + 1e-9)) {
    return { kind: 'dip_ok', lastExit: snap.marketUsd, snap: snapshotPriceUsd, dropPct };
  }

  return { kind: 'wait_dip', lastExit: snap.marketUsd, snap: snapshotPriceUsd, maxBuy, dropPct };
}

export function postExitReentryForkObservabilityReason(
  result: PostExitReentryForkResult,
): string | null {
  if (result.kind !== 'breakout') return null;
  return `reentry_breakout_standard_dip(last=${result.lastExit.toFixed(8)} snap=${result.snap.toFixed(8)} breakout=+${result.breakoutPct}pct)`;
}

/** Admin ledger close must not mutate re-entry gate state after a recent real exit (KINS audit 04740207). */
export function shouldPreserveRealExitReentryGate(
  mint: string,
  exitReason: string,
  exitTsMs: number,
  cfg: PaperTraderConfig,
  nowMs = Date.now(),
): boolean {
  if (!isAdminLedgerExitReason(exitReason)) return false;
  const real = lastRealExitMarketSnapshotByMintMap.get(mint);
  if (real && exitTsMs - real.exitTs <= RECONCILE_REENTRY_GRACE_MS) return true;
  return isPostExitBuyCooldownActive(cfg, mint, nowMs);
}

const STRESS_EXIT_REASONS = new Set(['FLASH_CRASH_KILL', 'SL', 'KILLSTOP', 'LIQ_DRAIN']);

type PartialSellForReentry = { marketPrice?: number; price?: number; reason?: string };

/** RECONCILE_ORPHAN books remainder at avgEntry; re-entry gate needs last on-chain sell price. */
export function resolveReconcileOrphanReentryGateMeta(
  ot: { partialSells: PartialSellForReentry[] },
  ct: {
    netPnlUsd: number;
    exitReason: string;
    theoretical_exit_price: number;
    effective_exit_price: number;
  },
): { marketUsd: number; netPnlUsd: number; exitReason: string } | null {
  const partials = ot.partialSells;
  if (partials.length === 0) return null;
  const last = partials[partials.length - 1]!;
  const marketUsd = Number(last.marketPrice ?? last.price ?? 0);
  if (!(marketUsd > 0)) return null;
  let exitReason = ct.exitReason;
  for (let i = partials.length - 1; i >= 0; i--) {
    const r = partials[i]!.reason;
    if (r && STRESS_EXIT_REASONS.has(r)) {
      exitReason = r;
      break;
    }
  }
  return { marketUsd, netPnlUsd: ct.netPnlUsd, exitReason };
}

export function recordLastExitMarketSnapshotAfterClose(
  mint: string,
  exitTsMs: number,
  marketUsd: number,
  meta?: { netPnlUsd?: number; exitReason?: string },
): void {
  if (!(exitTsMs > 0)) return;
  const px = Number(marketUsd);
  if (!(px > 0)) return;
  const next: LastExitMarketSnapshot = {
    exitTs: exitTsMs,
    marketUsd: px,
    netPnlUsd: meta?.netPnlUsd,
    exitReason: meta?.exitReason,
  };
  const prev = lastExitMarketSnapshotByMintMap.get(mint);
  const real = lastRealExitMarketSnapshotByMintMap.get(mint);
  if (meta?.exitReason && isAdminLedgerExitReason(meta.exitReason)) {
    if (real && exitTsMs - real.exitTs <= RECONCILE_REENTRY_GRACE_MS) return;
    if (real && px > real.marketUsd * (1 + 1e-9)) return;
    if (
      prev &&
      prev.exitReason &&
      !isAdminLedgerExitReason(prev.exitReason) &&
      exitTsMs - prev.exitTs <= RECONCILE_REENTRY_GRACE_MS
    ) {
      return;
    }
  }
  if (!prev || exitTsMs >= prev.exitTs) {
    lastExitMarketSnapshotByMintMap.set(mint, next);
  }
  if (!isAdminLedgerExitReason(meta?.exitReason)) {
    const realPrev = lastRealExitMarketSnapshotByMintMap.get(mint);
    if (!realPrev || exitTsMs >= realPrev.exitTs) {
      lastRealExitMarketSnapshotByMintMap.set(mint, next);
    }
  }
}

/** После полного закрытия: cooldown по времени + снимок цены выхода для гейта re-entry. */
export function recordAfterFullCloseForMintRepeatGate(
  cfg: PaperTraderConfig,
  mint: string,
  exitTsMs: number,
  theoreticalExitUsd: number,
  effectiveExitUsd: number,
  meta?: { netPnlUsd?: number; exitReason?: string },
): void {
  recordPostExitBuyCooldownIfApplicable(cfg, mint, exitTsMs, meta?.netPnlUsd);
  const px = theoreticalExitUsd > 0 ? theoreticalExitUsd : effectiveExitUsd;
  recordLastExitMarketSnapshotAfterClose(mint, exitTsMs, px, meta);
}

export function recordAfterFullCloseForMintRepeatGateFromClosedTrade(
  cfg: PaperTraderConfig,
  ct: { mint: string; exitTs: number; theoretical_exit_price: number; effective_exit_price: number; netPnlUsd: number; exitReason: string },
  opts?: { openTrade?: { partialSells: PartialSellForReentry[] } },
): void {
  if (shouldPreserveRealExitReentryGate(ct.mint, ct.exitReason, ct.exitTs, cfg)) {
    return;
  }
  let theo = ct.theoretical_exit_price;
  let eff = ct.effective_exit_price;
  let meta: { netPnlUsd: number; exitReason: string } = {
    netPnlUsd: ct.netPnlUsd,
    exitReason: ct.exitReason,
  };
  if (ct.exitReason === 'RECONCILE_ORPHAN' && opts?.openTrade) {
    const resolved = resolveReconcileOrphanReentryGateMeta(opts.openTrade, ct);
    if (resolved) {
      theo = resolved.marketUsd;
      eff = resolved.marketUsd;
      meta = { netPnlUsd: resolved.netPnlUsd, exitReason: resolved.exitReason };
    }
  }
  recordAfterFullCloseForMintRepeatGate(cfg, ct.mint, ct.exitTs, theo, eff, meta);
}

export function isLiveReentryHybridGateEnabled(cfg: PaperTraderConfig): boolean {
  return cfg.liveReentryMinDropFromLastExitPct > 0 && cfg.liveReentryMaxWaitMinutes > 0;
}

function lastExitWasLossOrStress(snap: LastExitMarketSnapshot): boolean {
  if ((snap.netPnlUsd ?? 0) < 0) return true;
  const r = snap.exitReason ?? '';
  return r === 'FLASH_CRASH_KILL' || r === 'SL' || r === 'KILLSTOP' || r === 'LIQ_DRAIN';
}

/** Arm cooldown + exit snapshot when full exit is decided (before Jupiter sell confirms). Idempotent with final close. */
export function armPostExitReentryGateFromClosedTrade(
  cfg: PaperTraderConfig,
  ct: {
    mint: string;
    exitTs: number;
    theoretical_exit_price: number;
    effective_exit_price: number;
    netPnlUsd: number;
    exitReason: string;
  },
): void {
  recordAfterFullCloseForMintRepeatGate(
    cfg,
    ct.mint,
    ct.exitTs,
    ct.theoretical_exit_price,
    ct.effective_exit_price,
    { netPnlUsd: ct.netPnlUsd, exitReason: ct.exitReason },
  );
}

/** Re-entry fork within gate max-age: block between exit and −N%; +M% breakout bypasses wait. */
export function appendLiveReentryHybridGateReasons(
  cfg: PaperTraderConfig,
  mint: string,
  snapshotPriceUsd: number,
  out: string[],
  nowMs = Date.now(),
  observabilityOut?: string[],
): void {
  const baseDropPct = cfg.liveReentryMinDropFromLastExitPct;
  const maxWaitMin = cfg.liveReentryMaxWaitMinutes;
  if (!(baseDropPct > 0) || !(maxWaitMin > 0)) return;

  const snap = reentryExitSnapshotForGate(mint);
  if (!snap || !(snap.marketUsd > 0) || !(snapshotPriceUsd > 0)) return;

  const fork = evaluatePostExitReentryFork(cfg, snap, snapshotPriceUsd, nowMs);
  const obs = postExitReentryForkObservabilityReason(fork);
  if (obs && observabilityOut) observabilityOut.push(obs);

  if (fork.kind !== 'wait_dip') return;

  out.push(
    `reentry_wait_dip_below_exit(last=${fork.lastExit.toFixed(8)} max_buy=${fork.maxBuy.toFixed(8)} snap=${fork.snap.toFixed(8)} dip=${fork.dropPct}pct)`,
  );
}

function appendLegacyPostExitBuyCooldownReasons(cfg: PaperTraderConfig, mint: string, out: string[]): void {
  if (!isPostExitBuyCooldownActive(cfg, mint)) return;
  const snap = reentryExitSnapshotForGate(mint);
  const exitTs = snap?.exitTs ?? lastPostExitBuyCooldownTsByMintMap.get(mint) ?? 0;
  if (exitTs <= 0) return;
  const lossMin = cfg.dipLossExitCooldownMinutes;
  const lossH = cfg.dipLossExitCooldownHours;
  const label = Number(lossMin) > 0 ? `${lossMin}m` : `${lossH}h`;
  const resumeAt = postExitBuyCooldownResumeAtMs(cfg, exitTs);
  if (resumeAt > 0) {
    const leftMin = (resumeAt - Date.now()) / 60_000;
    out.push(`post_exit_buy_cooldown_${label}_left_${leftMin.toFixed(1)}m`);
  }
}

/** Post-exit re-entry gate: hybrid dip fork или legacy cooldown + price gap. */
export function appendPostExitReentryGateReasons(
  cfg: PaperTraderConfig,
  mint: string,
  snapshotPriceUsd: number,
  out: string[],
  observabilityOut?: string[],
): void {
  if (cfg.dipLossExitCooldownEnabled) {
    appendLegacyPostExitBuyCooldownReasons(cfg, mint, out);
  }
  if (isLiveReentryHybridGateEnabled(cfg)) {
    appendLiveReentryHybridGateReasons(cfg, mint, snapshotPriceUsd, out, Date.now(), observabilityOut);
    return;
  }
  appendLiveReentryPriceGapReasons(cfg, mint, snapshotPriceUsd, out);
}

let postExitReentryGatePaperCfg: PaperTraderConfig | null = null;

/** Live execution pipeline (buy_open / entry_split / dca) — same cfg as discovery gates. */
export function configurePostExitReentryGatePaperCfg(cfg: PaperTraderConfig): void {
  postExitReentryGatePaperCfg = cfg;
}

export function postExitReentryGateReasonsForLiveBuy(
  mint: string,
  candidatePriceUsd: number,
): string[] {
  if (!postExitReentryGatePaperCfg || !(candidatePriceUsd > 0)) return [];
  const reasons: string[] = [];
  appendPostExitReentryGateReasons(postExitReentryGatePaperCfg, mint, candidatePriceUsd, reasons);
  return reasons;
}

export function appendLiveReentryPriceGapReasons(
  cfg: PaperTraderConfig,
  mint: string,
  snapshotPriceUsd: number,
  out: string[],
  nowMs = Date.now(),
): void {
  if (isLiveReentryHybridGateEnabled(cfg)) return;
  const pct = cfg.liveReentryMinDropFromLastExitPct;
  if (!(Number(pct) > 0)) return;
  const snap = reentryExitSnapshotForGate(mint);
  if (!snap || !(snap.marketUsd > 0) || !(snapshotPriceUsd > 0)) return;
  if (!shouldApplyPostExitReentryPriceGate(cfg, mint, snap, nowMs)) return;
  const maxAllowed = snap.marketUsd * (1 - pct / 100);
  if (snapshotPriceUsd > maxAllowed * (1 + 1e-9)) {
    out.push(
      `reentry_price_above_last_exit_minus_${pct}pct(last=${snap.marketUsd.toFixed(8)} max_buy=${maxAllowed.toFixed(8)} snap=${snapshotPriceUsd.toFixed(8)})`,
    );
  }
}

export function recordPostExitBuyCooldownIfApplicable(
  cfg: PaperTraderConfig,
  mint: string,
  exitTsMs: number,
  _netPnlUsd?: number,
): void {
  const h = cfg.dipLossExitCooldownHours;
  const m = cfg.dipLossExitCooldownMinutes;
  if (!cfg.dipLossExitCooldownEnabled || (!(Number(m) > 0) && !(Number(h) > 0))) return;
  if (!(exitTsMs > 0)) return;
  const prev = lastPostExitBuyCooldownTsByMintMap.get(mint) ?? 0;
  if (exitTsMs >= prev) lastPostExitBuyCooldownTsByMintMap.set(mint, exitTsMs);
}

function resolveDiscoveryReevalSec(
  cfg: PaperTraderConfig,
  mint: string,
  priorityMintSet: ReadonlySet<string>,
  volumeLeaderMintSet: ReadonlySet<string>,
): number {
  if (cfg.volumeLeaderEnabled && volumeLeaderMintSet.has(mint)) {
    return cfg.volumeLeaderReevalSec;
  }
  if (cfg.priorityDiscoveryEnabled && priorityMintSet.has(mint)) {
    return cfg.priorityDiscoveryReevalSec;
  }
  return cfg.discoveryReevalSec;
}

function shouldEvaluate(
  mint: string,
  priorityMintSet: ReadonlySet<string>,
  volumeLeaderMintSet: ReadonlySet<string>,
  cfg: PaperTraderConfig,
): boolean {
  return shouldEvaluateMint(
    mint,
    resolveDiscoveryReevalSec(cfg, mint, priorityMintSet, volumeLeaderMintSet),
  );
}

function buildFeatures(
  row: SnapshotCandidateRow,
  dipPct: number | null,
  impulsePct: number | null,
  dipLookbackUsedMin: number | null,
  cfg: PaperTraderConfig,
  recoveryVeto: RecoveryVetoResult | undefined,
  localHighVeto: LocalHighVetoResult | undefined,
  trendStructureVeto: TrendStructureVetoResult | undefined,
  perWindowDipPct: Record<number, number> | undefined,
): SnapshotFeatures {
  const base: SnapshotFeatures = {
    price_usd: +Number(row.price_usd || 0).toFixed(8),
    snapshot_ts_ms: snapshotRowTsMs(row.ts),
    liq_usd: +Number(row.liquidity_usd || 0).toFixed(0),
    pair_address: row.pair_address != null && String(row.pair_address).trim() ? String(row.pair_address) : null,
    vol5m_usd: +Number(row.volume_5m || 0).toFixed(0),
    vol1h_usd: +Number(row.volume_1h ?? 0).toFixed(0),
    buys5m: row.buys_5m,
    sells5m: row.sells_5m,
    buy_sell_ratio_5m: row.sells_5m > 0 ? +(row.buys_5m / row.sells_5m).toFixed(2) : null,
    holders: row.holder_count,
    token_age_min: +Number(row.token_age_min ?? 0).toFixed(1),
    dip_pct: dipPct !== null ? +dipPct.toFixed(2) : null,
    impulse_pct: impulsePct !== null ? +impulsePct.toFixed(2) : null,
    dip_lookback_min: dipLookbackUsedMin,
    market_cap_usd:
      row.market_cap_usd != null && Number(row.market_cap_usd) > 0
        ? +Number(row.market_cap_usd).toFixed(2)
        : null,
  };
  if (perWindowDipPct && Object.keys(perWindowDipPct).length > 0) {
    base.dip_pct_by_window = perWindowDipPct;
  }
  if (cfg.dipRecoveryVetoEnabled && recoveryVeto) {
    base.recovery_veto = {
      threshold_pct: cfg.dipRecoveryVetoMaxBouncePct,
      veto_windows_min: cfg.dipRecoveryVetoWindowsMin,
      dip_window_used_min: dipLookbackUsedMin,
      bounces_pct: Object.fromEntries(
        Object.entries(recoveryVeto.bounces).map(([k, v]) => [String(k), v]),
      ),
      vetoed: recoveryVeto.reasons.length > 0,
      veto_reasons: recoveryVeto.reasons,
    };
  }
  if (cfg.dipLocalHighVetoEnabled && localHighVeto) {
    base.local_high_veto = {
      threshold_pct: cfg.dipLocalHighVetoMaxDistancePct,
      veto_windows_min: cfg.dipLocalHighVetoWindowsMin,
      distance_from_high_pct: Object.fromEntries(
        Object.entries(localHighVeto.distanceFromHighPct).map(([k, v]) => [String(k), v]),
      ),
      vetoed: localHighVeto.reasons.length > 0,
      veto_reasons: localHighVeto.reasons,
    };
  }
  if (cfg.trendStructureVetoEnabled && trendStructureVeto) {
    const f = trendStructureVeto.features;
    base.trend_structure_veto = {
      enabled: true,
      coverageOk: f.coverageOk,
      lookbackDays: f.lookbackDays,
      highLookbackUsd: f.highLookbackUsd,
      daysSinceHighBreak: f.daysSinceHighBreak,
      price7dAgoUsd: f.price7dAgoUsd,
      slope7dPct: f.slope7dPct,
      pxVsHighLookback: f.pxVsHighLookback,
      pgSnapsCount: f.pgSnapsCount,
      vetoed: trendStructureVeto.reasons.length > 0,
      veto_reasons: trendStructureVeto.reasons,
      thresholds: {
        minDaysSinceHighBreak: cfg.trendVetoMinDaysSinceHighBreak,
        maxPxVsHighLookback: cfg.trendVetoMaxPxVsHigh14d,
        maxSlope7dPct: cfg.trendVetoMaxSlope7dPct,
      },
    };
  }
  return base;
}

async function warmupSnapshotHolderCounts(
  cfg: PaperTraderConfig,
  snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }>,
): Promise<void> {
  if (!cfg.holdersLiveEnabled) return;
  const max = cfg.holdersSnapshotWarmupMax;
  if (!(max > 0)) return;

  const mints: string[] = [];
  const seen = new Set<string>();
  for (const { row } of snapshotTagged) {
    if ((row.holder_count ?? 0) > 0) continue;
    if (seen.has(row.mint)) continue;
    seen.add(row.mint);
    mints.push(row.mint);
    if (mints.length >= max) break;
  }
  if (mints.length === 0) return;

  const resolved = new Map<string, number>();
  for (const mint of mints) {
    const r = await resolveHolderCount(cfg, mint);
    if (r.ok) resolved.set(mint, r.count);
  }
  if (resolved.size === 0) return;

  for (const x of snapshotTagged) {
    const c = resolved.get(x.row.mint);
    if (c !== undefined) x.row.holder_count = c;
  }
}

export async function runDipDiscovery(cfg: PaperTraderConfig): Promise<DiscoveryTickResult> {
  const [migRows, postRows] = await Promise.all([
    cfg.enableMigrationLane ? fetchSnapshotLaneCandidates(cfg, 'migration_event') : Promise.resolve([]),
    cfg.enablePostLane ? fetchSnapshotLaneCandidates(cfg, 'post_migration') : Promise.resolve([]),
  ]);
  let snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }> = [
    ...migRows.map((row) => ({ row, lane: 'migration_event' as const })),
    ...postRows.map((row) => ({ row, lane: 'post_migration' as const })),
  ];
  snapshotTagged = filterSnapshotTaggedByMintBlacklist(cfg, snapshotTagged);
  const wlInjected = await injectWhitelistDiscoveryCandidates(cfg, snapshotTagged);
  if (wlInjected.length > 0) {
    snapshotTagged = [...snapshotTagged, ...wlInjected];
  }
  const { injected: priorityInjected, priorityMintSet } = await injectPriorityDiscoveryCandidates(
    cfg,
    snapshotTagged,
  );
  for (const { row } of snapshotTagged) priorityMintSet.add(row.mint);
  if (priorityInjected.length > 0) {
    snapshotTagged = [...snapshotTagged, ...priorityInjected];
  }
  const { injected: volumeInjected, volumeLeaderMintSet } = await injectVolumeLeaderCandidates(
    cfg,
    snapshotTagged,
  );
  if (volumeInjected.length > 0) {
    snapshotTagged = [...snapshotTagged, ...volumeInjected];
  }
  for (const m of volumeLeaderMintSet) priorityMintSet.add(m);
  snapshotTagged = dedupeSnapshotTaggedByMintCanonical(snapshotTagged, {
    volumeLeaderMints: volumeLeaderMintSet,
    sanityCfg: discoverySnapshotSanityCfg(cfg),
  });
  if ((cfg.discoveryMaxMarketCapUsd ?? 0) > 0) {
    const openMcapExempt = getPriorityOpenMints();
    snapshotTagged = snapshotTagged.filter(({ row }) =>
      passesDiscoveryMaxMarketCap(cfg, row, openMcapExempt),
    );
  }
  if (snapshotTagged.length === 0) {
    syncDiscoveryCollectorPin(cfg, priorityMintSet);
    return { discovered: 0, evaluated: 0, passed: 0, decisions: [], priorityMintSet };
  }

  /**
   * 1.11.231 — throttle ПЕРЕД PG fan-out.
   *
   * Раньше PG-контексты (`dipMap`, `policyAPlusMap`, `volumeSybilMap`,
   * `volumeEphemeralMap`, `mintPgCoverageMap`) фетчились для ВСЕХ кандидатов из snapshot,
   * включая те, по которым `shouldEvaluate` отказал бы из-за `discoveryReevalSec`-throttle.
   * Это рандомно увеличивало PG-нагрузку на discovery-tick'е в 2-4×.
   *
   * Теперь:
   *   1) считаем `allowedThisTick` для каждого mint'а ОДИН раз (фиксирует last-eval timestamp),
   *   2) fan-out PG-контексты только для allowed,
   *   3) loop пишет throttled-аудит для deepWl-mint'ов отдельной фазой.
   *
   * `evaluatedAtMap` мутируется при `shouldEvaluate==true` — поведение throttle сохранено.
   */
  const reevalAfterSec = cfg.discoveryReevalSec;
  const allowedFlag = new Map<string, boolean>();
  for (const { row } of snapshotTagged) {
    if (allowedFlag.has(row.mint)) continue;
    allowedFlag.set(
      row.mint,
      shouldEvaluate(row.mint, priorityMintSet, volumeLeaderMintSet, cfg),
    );
  }
  const allowedSnapshotTagged = snapshotTagged.filter(({ row }) => allowedFlag.get(row.mint) === true);

  if (allowedSnapshotTagged.length === 0) {
    /** Все mint'ы на throttle — пишем deep-аудит для whitelist + priority tier. */
    const auditRowsThrottle: Record<string, unknown>[] = [];
    const wl = cfg.discoveryDeepAuditWhitelistMintSet;
    const auditMintSet = new Set<string>([...priorityMintSet]);
    if (wl) for (const m of wl) auditMintSet.add(m);
    if (cfg.discoveryDeepAuditJsonl === true && auditMintSet.size > 0) {
      for (const { row, lane } of snapshotTagged) {
        if (!auditMintSet.has(row.mint)) continue;
        if (
          !allowDeepAuditLog(
            `${row.mint}:tick_skip`,
            cfg.discoveryDeepAuditUniverseMissMinMs,
          )
        ) continue;
        auditRowsThrottle.push({
          kind: 'live_discovery_tick_skip',
          mint: row.mint,
          symbol: row.symbol,
          lane,
          source: row.source,
          reason: 'reeval_throttle',
          discoveryReevalSec: reevalAfterSec,
        });
      }
    }
    syncDiscoveryCollectorPin(cfg, priorityMintSet);
    return {
      discovered: snapshotTagged.length,
      evaluated: 0,
      passed: 0,
      decisions: [],
      auditRows: auditRowsThrottle.length > 0 ? auditRowsThrottle : undefined,
      priorityMintSet,
    };
  }

  const evalRows = allowedSnapshotTagged.map((x) => x.row);
  const rowsForCtx = evalRows;
  /** PG runner context: enable when either parallel lane is on (mcap band picks lane at eval). */
  const runnerMapCfg = cfg.runnerModeEnabled
    ? cfg
    : isRunnerProbeLaneEnabled(cfg) && isRunnerLiteLaneEnabled(cfg)
      ? {
          ...cfg,
          runnerModeEnabled: true,
          runnerMinPgSamples24h: Math.min(
            cfg.runnerProbeMinPgSamples24h,
            cfg.runnerLiteMinPgSamples24h,
          ),
        }
      : isRunnerProbeLaneEnabled(cfg)
        ? runnerProbeRunnerFetchConfig(cfg)
        : isRunnerLiteLaneEnabled(cfg)
          ? runnerLiteRunnerFetchConfig(cfg)
          : { ...cfg, runnerModeEnabled: false };
  const [dipMap, policyAPlusMap, trendStructureMap, postCrashMap, volumeSybilMap, volumeEphemeralMap, globalPgCoverage, runnerMap] =
    await Promise.all([
      fetchDipContextMap(cfg, rowsForCtx),
      fetchPolicyAPlusContextMap(cfg, rowsForCtx),
      fetchTrendStructureContextMap(cfg, rowsForCtx),
      fetchPostCrashContextMap(cfg, rowsForCtx),
      fetchVolumeSybilContextMap(cfg, rowsForCtx),
      fetchVolumeEphemeralContextMap(cfg, rowsForCtx),
      fetchGlobalPgCoverageState(cfg),
      fetchRunnerContextMap(runnerMapCfg, rowsForCtx),
    ]);
  /** Jupiter spot refresh only after PG dip context — not on raw SQL pool (1.11.244 regression fix). */
  const jupiterPriorityMintSet = buildPriorityDiscoveryMintSet(cfg);
  const jupiterAlreadyRefreshed = new Set<string>();
  const { refreshedMints: volumeLeaderJupiterRefreshed } =
    await crossCheckVolumeLeaderSnapshotsFromJupiter(cfg, rowsForCtx, volumeLeaderMintSet);
  for (const m of volumeLeaderJupiterRefreshed) jupiterAlreadyRefreshed.add(m);
  const { refreshedMints: priorityJupiterRefreshed } = await refreshPriorityMintPricesFromJupiter(
    cfg,
    rowsForCtx,
    jupiterPriorityMintSet,
    jupiterAlreadyRefreshed,
  );
  for (const m of priorityJupiterRefreshed) jupiterAlreadyRefreshed.add(m);
  await refreshNearMissDipPricesFromJupiter(cfg, rowsForCtx, dipMap, jupiterAlreadyRefreshed);
  const mintPgCoverageMap: Map<string, MintPgCoverageFeatures> = await fetchMintPgCoverageMap(
    cfg,
    rowsForCtx,
    globalPgCoverage,
  );
  await warmupSnapshotHolderCounts(cfg, allowedSnapshotTagged);

  const decisions: EvalDecision[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const candidateMintKeys = new Set(snapshotTagged.map((x) => x.row.mint));
  let evaluated = 0;
  let passed = 0;
  let liveHoldersThisTick = 0;
  /**
   * 1.11.231 — два режима:
   *   - `liveHoldersForObservability`: запрашиваем точное число холдеров через QN add-on / GPA
   *     для всех passed-кандидатов (cheapPass=true), чтобы видеть real holders в journal даже
   *     когда minHolderCount=0 и гейт не блокирует.
   *   - `liveHoldersForGate`: применяем порог `globalMinHolderCount` только если он > 0.
   */
  const liveHoldersForObservability = cfg.holdersLiveEnabled;
  const liveHoldersForGate =
    cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0;

  const knownMintHistory = buildKnownMintTradeHistory({
    lastEntryTsByMint: lastEntryTsByMintMap,
    lastPostExitBuyCooldownTsByMint: lastPostExitBuyCooldownTsByMintMap,
    lastRealExitMarketSnapshotByMint: lastRealExitMarketSnapshotByMintMap,
    lastExitMarketSnapshotByMint: lastExitMarketSnapshotByMintMap,
  });
  /** Whitelist deep-audit set = repeat-traded mints for relaxed volume / PG gap rules. */
  const knownMintSupplement = cfg.discoveryDeepAuditWhitelistMintSet;

  /** Throttled deep-аудит для whitelist + priority tier. */
  const wlForThrottle = cfg.discoveryDeepAuditWhitelistMintSet;
  const throttleAuditMints = new Set<string>([...priorityMintSet]);
  if (wlForThrottle) for (const m of wlForThrottle) throttleAuditMints.add(m);
  if (cfg.discoveryDeepAuditJsonl === true && throttleAuditMints.size > 0) {
    for (const { row, lane } of snapshotTagged) {
      if (allowedFlag.get(row.mint) === true) continue;
      if (!throttleAuditMints.has(row.mint)) continue;
      if (
        !allowDeepAuditLog(
          `${row.mint}:tick_skip`,
          cfg.discoveryDeepAuditUniverseMissMinMs,
        )
      ) continue;
      auditRows.push({
        kind: 'live_discovery_tick_skip',
        mint: row.mint,
        symbol: row.symbol,
        lane,
        source: row.source,
        reason: 'reeval_throttle',
        discoveryReevalSec: resolveDiscoveryReevalSec(cfg, row.mint, priorityMintSet, volumeLeaderMintSet),
      });
    }
  }

  for (const { row, lane } of allowedSnapshotTagged) {
    evaluated++;

    /**
     * Stage 1.3 (1.11.469): Shyft DeFi mcap/liq for the candidate (TTL cache + PG fallback). Used to
     * override `refMcap` (tier) and the snapshot mcap/liq gate inputs (folded into `evalRow` below).
     * **Default OFF** (`shyftDefiMcapEnabled`): when OFF this is skipped and `refMcap` / gate inputs are
     * byte-for-byte the current PG path. On the ON path any DeFi failure falls back to PG.
     */
    let defiMcap: ShyftDefiMcapResult | null = null;
    if (cfg.shyftDefiMcapEnabled && isLiveOscarDiscoveryQuoteStrategyId(cfg.strategyId)) {
      const fetched = await resolveShyftDefiMcap(row.mint, { ttlMs: cfg.shyftDefiMcapTtlMs });
      if (fetched && (fetched.mcapUsd != null || fetched.liqUsd != null)) {
        defiMcap = fetched;
        auditRows.push({
          kind: 'live_shyft_defi_mcap',
          mint: row.mint,
          lane: String(lane),
          pgMcapUsd: row.market_cap_usd ?? null,
          pgLiqUsd: row.liquidity_usd ?? null,
          defiMcapUsd: fetched.mcapUsd,
          defiLiqUsd: fetched.liqUsd,
        });
      }
    }

    /**
     * Discovery market quote: Birdeye (when primary ON) → DexScreener → PG.
     * Shyft stream-primary (1.2) may still override price below.
     */
    let quoteMcapSource: DiscoveryQuoteSource | undefined;
    let birdeyeMarketQuote: Awaited<ReturnType<typeof resolveDiscoveryMarketQuote>> | null = null;
    if (isLiveOscarDiscoveryQuoteStrategyId(cfg.strategyId)) {
      birdeyeMarketQuote = await resolveDiscoveryMarketQuote({
        enabled: cfg.birdeyePrimaryEnabled,
        mint: row.mint,
        pgRow: row,
        birdeyeTtlMs: cfg.birdeyeMarketTtlMs,
        birdeyeMaxStaleMs: cfg.birdeyeMaxStaleMs,
        coverageGapMinMs: cfg.birdeyeCoverageGapMinMs,
      });
      quoteMcapSource = birdeyeMarketQuote.source;
      if (cfg.birdeyePrimaryEnabled && birdeyeMarketQuote.birdeyeTierInsufficient) {
        auditRows.push(
          buildBirdeyeTierInsufficientEvent({
            mint: row.mint,
            lane: String(lane),
            errorKind: birdeyeMarketQuote.birdeyeErrorKind,
          }),
        );
      }
      const gap = birdeyeMarketQuote;
      if (
        cfg.birdeyePrimaryEnabled &&
        gap.coverageGap &&
        birdeyeMarketQuote.pgSnapshotAgeMs != null &&
        birdeyeMarketQuote.pgSnapshotAgeMs > cfg.birdeyeCoverageGapMinMs
      ) {
        auditRows.push(
          buildBirdeyeCoverageGapEvent({
            mint: row.mint,
            lane: String(lane),
            pgSnapshotAgeMs: birdeyeMarketQuote.pgSnapshotAgeMs,
            coverageGapMinMs: cfg.birdeyeCoverageGapMinMs,
            source: birdeyeMarketQuote.source,
          }),
        );
      }
      if (birdeyeMarketQuote.source !== 'pg_snapshot') {
        auditRows.push({
          kind: 'live_birdeye_market_quote',
          mint: row.mint,
          lane: String(lane),
          source: birdeyeMarketQuote.source,
          pgPriceUsd: row.price_usd ?? null,
          pgMcapUsd: row.market_cap_usd ?? null,
          pgLiqUsd: row.liquidity_usd ?? null,
          pgVol5mUsd: row.volume_5m ?? null,
          pgSnapshotAgeMs: birdeyeMarketQuote.pgSnapshotAgeMs,
          quotePriceUsd: birdeyeMarketQuote.priceUsd,
          quoteMcapUsd: birdeyeMarketQuote.marketCapUsd,
          quoteLiqUsd: birdeyeMarketQuote.liquidityUsd,
          quoteVol5mUsd: birdeyeMarketQuote.volume5mUsd,
          quoteVol1hUsd: birdeyeMarketQuote.volume1hUsd,
        });
      }
    }

    /**
     * Stage 1.2 (1.11.468) + 1.3 (1.11.469): build `evalRow` — a clone of `row` with the freshest
     * Shyft stream `price_usd` (1.2) and/or DeFi `market_cap_usd` / `liquidity_usd` (1.3) overrides
     * folded in — used by the snapshot/dip gates + reported features.
     */
    const evalOverrides: Partial<SnapshotCandidateRow> = {};
    if (birdeyeMarketQuote && birdeyeMarketQuote.source !== 'pg_snapshot') {
      if (birdeyeMarketQuote.priceUsd != null && birdeyeMarketQuote.priceUsd > 0) {
        evalOverrides.price_usd = birdeyeMarketQuote.priceUsd;
      }
      if (birdeyeMarketQuote.marketCapUsd != null && birdeyeMarketQuote.marketCapUsd > 0) {
        evalOverrides.market_cap_usd = birdeyeMarketQuote.marketCapUsd;
      }
      if (birdeyeMarketQuote.liquidityUsd != null && birdeyeMarketQuote.liquidityUsd > 0) {
        evalOverrides.liquidity_usd = birdeyeMarketQuote.liquidityUsd;
      }
      if (birdeyeMarketQuote.volume5mUsd != null && birdeyeMarketQuote.volume5mUsd > 0) {
        evalOverrides.volume_5m = birdeyeMarketQuote.volume5mUsd;
      }
      if (birdeyeMarketQuote.volume1hUsd != null && birdeyeMarketQuote.volume1hUsd > 0) {
        evalOverrides.volume_1h = birdeyeMarketQuote.volume1hUsd;
      }
    }
    if (
      cfg.shyftPricePrimaryEnabled &&
      cfg.shyftPricePrimaryDiscoveryEnabled &&
      isLiveOscarDiscoveryQuoteStrategyId(cfg.strategyId) &&
      isShyftShadowEnabled()
    ) {
      const nowPrimary = Date.now();
      const streamPrimary = getShyftShadowStreamPrice(row.mint, nowPrimary);
      const picked = resolvePrimaryPriceUsd({
        enabled: true,
        pgPriceUsd: row.price_usd ?? null,
        streamPriceUsd: streamPrimary?.priceUsd ?? null,
        streamTsMs: streamPrimary?.streamTsMs ?? null,
        nowMs: nowPrimary,
        maxStaleMs: cfg.shyftMaxStaleMs,
      });
      if (picked.source === 'stream' && picked.priceUsd != null && picked.priceUsd > 0 && streamPrimary) {
        evalOverrides.price_usd = picked.priceUsd;
        auditRows.push(
          buildPricePrimaryEvent({
            mint: row.mint,
            lane: String(lane),
            surface: 'entry',
            baselinePriceUsd: row.price_usd ?? null,
            streamPriceUsd: streamPrimary.priceUsd,
            streamTsMs: streamPrimary.streamTsMs,
            streamAgeMs: picked.streamAgeMs,
            streamSlot: streamPrimary.slot,
            nowMs: nowPrimary,
          }),
        );
      }
    }
    if (defiMcap?.mcapUsd != null && defiMcap.mcapUsd > 0) evalOverrides.market_cap_usd = defiMcap.mcapUsd;
    if (defiMcap?.liqUsd != null && defiMcap.liqUsd > 0) evalOverrides.liquidity_usd = defiMcap.liqUsd;
    if (
      evalOverrides.price_usd != null &&
      evalOverrides.market_cap_usd == null &&
      row.price_usd > 0 &&
      row.market_cap_usd != null &&
      Number(row.market_cap_usd) > 0
    ) {
      const scaled = scaleMcapWithPrice(
        Number(row.price_usd),
        Number(evalOverrides.price_usd),
        Number(row.market_cap_usd),
      );
      if (scaled != null && scaled > 0) evalOverrides.market_cap_usd = scaled;
    }
    const evalRow = Object.keys(evalOverrides).length > 0 ? { ...row, ...evalOverrides } : row;
    const freshExternalQuote = isFreshExternalDiscoveryQuote(
      birdeyeMarketQuote,
      cfg.birdeyeMaxStaleMs,
    );

    const discoveryMcap = resolveDiscoveryRefMcap(row, {
      defiMcapUsd: defiMcap?.mcapUsd,
      evalRow,
      quoteMcapSource:
        quoteMcapSource === 'birdeye' || quoteMcapSource === 'dexscreener'
          ? quoteMcapSource
          : undefined,
    });
    const hardMcapReasons: string[] = [];
    const isVolumeLeader = volumeLeaderMintSet.has(row.mint);
    const hardMinMcap = resolveDiscoveryHardMcapMinUsd(cfg, { volumeLeader: isVolumeLeader });
    if (hardMinMcap > 0 && discoveryMcap.refMcapUsd + 1e-9 < hardMinMcap) {
      hardMcapReasons.push(
        `discovery_hard_mcap=${Math.round(discoveryMcap.refMcapUsd)}<${hardMinMcap}_src=${discoveryMcap.source}`,
      );
    }
    if (hardMcapReasons.length > 0) {
      decisions.push({
        lane,
        source: row.source,
        mint: row.mint,
        symbol: row.symbol,
        ageMin: +Number(row.age_min ?? 0).toFixed(1),
        pass: false,
        reasons: hardMcapReasons,
        features: buildFeatures(evalRow, null, null, null, cfg, undefined, undefined, undefined, undefined),
        whale: null,
      });
      continue;
    }

    const refMcap = discoveryMcap.refMcapUsd;
    const oscarTier: LiveOscarMcapTier = isLiveOscarMcapTieringEnabled(cfg)
      ? resolveLiveOscarMcapTier(cfg, refMcap)
      : 'prod';
    if (oscarTier === 'below') {
      const belowReasons = [`mcap<${liveOscarBelowMcapThresholdUsd(cfg)}`];
      decisions.push({
        lane,
        source: row.source,
        mint: row.mint,
        symbol: row.symbol,
        ageMin: +Number(row.age_min ?? 0).toFixed(1),
        pass: false,
        reasons: belowReasons,
        features: buildFeatures(evalRow, null, null, null, cfg, undefined, undefined, undefined, undefined),
        whale: null,
      });
      continue;
    }
    const tierCfg = liveOscarTierEntryConfig(cfg, oscarTier);
    const mcapGateCfg =
      isVolumeLeader && resolveDiscoverySqlMinMarketCapUsd(cfg) < (cfg.discoveryMinMarketCapUsd ?? 0)
        ? { ...tierCfg, discoveryMinMarketCapUsd: resolveDiscoverySqlMinMarketCapUsd(cfg) }
        : tierCfg;
    const journalTier: LiveOscarTradeTier =
      oscarTier === 'micro' ? 'micro' : oscarTier === 'low' ? 'low' : 'prod';

    const v = priorityMintSet.has(row.mint)
      ? evaluateSnapshotPriorityTier(mcapGateCfg, evalRow, lane)
      : evaluateSnapshot(mcapGateCfg, evalRow, lane);
    const globalReasons = globalGate(cfg, row.token_age_min, row.holder_count, {
      skipHolderCheck: liveHoldersForGate,
    });
    const snapshotGatePass = v.pass && globalReasons.length === 0;
    const lastExitSnap = reentryExitSnapshotForGate(row.mint);
    const stressReentryCtx = getStressKillReentryContext(cfg, lastExitSnap, evalRow.price_usd);
    const dipTierCfg =
      stressReentryCtx &&
      cfg.liveStressReentryDipMaxDropPct < tierCfg.dipMaxDropPct
        ? { ...tierCfg, dipMaxDropPct: cfg.liveStressReentryDipMaxDropPct }
        : tierCfg;
    const dipEval = evaluateDip(dipTierCfg, evalRow, dipMap.get(row.mint));
    let dipReasonsForGate = dipEval.reasons;
    let entryPath: EvalDecision['entryPath'];
    let recoveryVeto: RecoveryVetoResult | undefined;
    let localHighVeto: LocalHighVetoResult | undefined;
    let trendStructureVeto: TrendStructureVetoResult | undefined;
    let postCrashFastPath: PostCrashFastPathResult | undefined;
    if (snapshotGatePass && dipEval.reasons.length === 0) {
      entryPath = 'dip_windows';
    } else if (snapshotGatePass) {
      const stressPath = evaluateStressKillReentryPath(
        cfg,
        lastExitSnap,
        row,
        dipMap.get(row.mint),
      );
      if (stressPath.pass) {
        dipReasonsForGate = [];
        entryPath = 'stress_kill_reentry';
      } else if (stressPath.reasons.length > 0) {
        dipReasonsForGate = [...dipReasonsForGate, ...stressPath.reasons];
      }
    }
    if (entryPath == null && snapshotGatePass && cfg.postCrashFastPathEnabled) {
      postCrashFastPath = evaluatePostCrashFastPath(tierCfg, row, postCrashMap.get(row.mint));
      if (postCrashFastPath.pass) {
        dipReasonsForGate = [];
        entryPath = 'post_crash_fast';
      } else if (postCrashFastPath.reasons.length > 0) {
        dipReasonsForGate = [...dipReasonsForGate, ...postCrashFastPath.reasons];
      }
    } else if (snapshotGatePass && cfg.entryImpulsePgBypassesDip) {
      const bypass = await impulsePgSnapTriggerOk(cfg, row.mint, row.source, row.pair_address ?? null);
      if (bypass) {
        dipReasonsForGate = [];
        entryPath = 'impulse_pg_snap';
      }
    }

    /**
     * 1.11.232 — Runner Mode параллельный путь.
     *
     * Если ни dip_windows, ни impulse_pg_snap не дали entryPath (классические гейты
     * заблокировали), мы пробуем оценить кандидата по 1h/12h/24h velocity / buy-flow /
     * liq стабильности. Этот путь не зависит от dip-окон, snapshot-floor (`vol5m<10k`,
     * `bs<0.98`, `liq<140k`) и не требует свежести pool.
     *
     * 1.11.233: важное уточнение — runner НЕ освобождает от protector-фильтров
     * (recovery-veto / local-high-veto / policyA+ / sybil / ephemeral / pg-coverage),
     * которые применяются ниже единым блоком. Иначе можно купить «магнит интереса»
     * прямо на отскоке после пролива (как было с VIRL 20 мая — купили в +1% от signal
     * без recovery-veto проверки).
     */
    let runnerFeatures: RunnerWindowFeatures | undefined;
    let runnerReasons: string[] = [];
    if (cfg.runnerModeEnabled && entryPath == null) {
      const runnerEval = evaluateRunner(cfg, row, runnerMap.get(row.mint));
      runnerFeatures = runnerEval.features;
      if (runnerEval.pass) {
        entryPath = 'runner';
      } else {
        runnerReasons = runnerEval.reasons;
      }
    }

    /**
     * 1.11.233 — единый блок protector-фильтров для ВСЕХ путей (dip / impulse_pg_snap / runner).
     *
     * Раньше recovery-veto / local-high-veto / policyA+ / sybil / ephemeral / pg-coverage
     * применялись только внутри dip-блока, и runner полностью обходил эти проверки.
     * Это привело к покупке VIRL (Biyw…) 20 мая на +1% от signal без recovery-veto.
     *
     * Теперь protectors прогоняются ОДИН РАЗ после определения entryPath любым путём.
     * Если хотя бы один заблокировал — `entryPath=undefined`, причины уходят в
     * `dipReasonsForGate` для journal/Telegram (название поля историческое; reasons
     * могут быть и от runner-пути).
     */
    let policyAPlusFeatures: PolicyAPlusFeatures | undefined;
    let volumeSybilFeatures: VolumeSybilFeatures | undefined;
    let pgDataCoverageFeatures: MintPgCoverageFeatures | undefined;
    let volumeEphemeralFeatures: VolumeEphemeralFeatures | undefined;
    if (entryPath != null) {
      const dipLookbackForRecovery =
        entryPath === 'post_crash_fast'
          ? (postCrashFastPath?.dipLookbackUsedMin ?? dipEval.dipLookbackUsedMin)
          : dipEval.dipLookbackUsedMin;
      if (entryPath === 'stress_kill_reentry') {
        recoveryVeto = { reasons: [], bounces: {} };
      } else {
        const recoveryOpts = stressReentryCtx
          ? {
              maxBouncePct: stressReentryCtx.maxBouncePct,
              windowsMin: cfg.dipRecoveryVetoWindowsMin.filter(
                (w) => w <= stressReentryCtx.maxWindowMin,
              ),
            }
          : undefined;
        recoveryVeto = evaluateRecoveryVeto(
          cfg,
          row,
          dipMap.get(row.mint),
          dipLookbackForRecovery,
          recoveryOpts,
        );
      }
      if (recoveryVeto.reasons.length > 0) {
        dipReasonsForGate = [...dipReasonsForGate, ...recoveryVeto.reasons];
        entryPath = undefined;
      } else {
        localHighVeto = evaluateLocalHighVeto(cfg, row, dipMap.get(row.mint));
        const skipLocalHigh = shouldBypassLocalHighVetoForPostCrash(cfg, postCrashFastPath, entryPath);
        if (!skipLocalHigh && localHighVeto.reasons.length > 0) {
          dipReasonsForGate = [...dipReasonsForGate, ...localHighVeto.reasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.trendStructureVetoEnabled) {
        trendStructureVeto = evaluateTrendStructureVeto(
          cfg,
          row,
          trendStructureMap.get(row.mint),
        );
        if (trendStructureVeto.reasons.length > 0) {
          dipReasonsForGate = [...dipReasonsForGate, ...trendStructureVeto.reasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.policyAPlusEnabled) {
        const ctx = policyAPlusMap.get(row.mint);
        const evalRes = evaluatePolicyAPlus(cfg, row, ctx);
        policyAPlusFeatures = evalRes.features;
        if (evalRes.blocked) {
          dipReasonsForGate = [...dipReasonsForGate, ...evalRes.blockedReasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.pgDataCoverageGuardEnabled) {
        const familiarMint = isFamiliarMint(
          cfg,
          row.mint,
          knownMintHistory,
          Date.now(),
          knownMintSupplement,
        );
        const knownMint = isPgCoverageKnownMint(cfg, row.mint, knownMintHistory);
        const evalRes = evaluatePgDataCoverageGuard(
          cfg,
          evalRow,
          mintPgCoverageMap.get(row.mint),
          globalPgCoverage,
          true,
          {
            knownMint,
            familiarMint,
            freshExternalMarketQuote: freshExternalQuote,
          },
        );
        pgDataCoverageFeatures = evalRes.features;
        if (evalRes.blocked) {
          dipReasonsForGate = [...dipReasonsForGate, ...evalRes.blockedReasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.volumeSybilGuardEnabled) {
        const knownMint = isKnownMint(cfg, row.mint, knownMintHistory, Date.now(), knownMintSupplement);
        const evalRes = evaluateVolumeSybilGuard(cfg, evalRow, volumeSybilMap.get(row.mint), {
          knownMint,
        });
        volumeSybilFeatures = evalRes.features;
        if (evalRes.blocked) {
          dipReasonsForGate = [...dipReasonsForGate, ...evalRes.blockedReasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.volumeEphemeralGuardEnabled) {
        const familiarMint = isFamiliarMint(
          cfg,
          row.mint,
          knownMintHistory,
          Date.now(),
          knownMintSupplement,
        );
        const knownMint = isKnownMint(cfg, row.mint, knownMintHistory, Date.now(), knownMintSupplement);
        const evalRes = evaluateVolumeEphemeralGuard(cfg, evalRow, volumeEphemeralMap.get(row.mint), {
          knownMint,
          familiarMint,
          freshExternalMarketQuote: freshExternalQuote,
        });
        volumeEphemeralFeatures = evalRes.features;
        if (evalRes.blocked) {
          dipReasonsForGate = [...dipReasonsForGate, ...evalRes.blockedReasons];
          entryPath = undefined;
        }
      }
    }

    /**
     * baseReasons:
     *  - dip_windows / impulse_pg_snap: стандартный набор (snapshot + global + dipReasonsForGate).
     *  - runner: snapshot/global floor НЕ применяются (мы пришли мимо них), но
     *    protector-reasons (recovery-veto и т.п.) идут в reasons как и для dip.
     *  - не прошли: всё пусто (нечего блокировать).
     */
    let baseReasons: string[];
    if (entryPath === 'runner') {
      baseReasons = [...dipReasonsForGate]; // protector-reasons после runner-passed (если есть)
    } else if (entryPath != null) {
      baseReasons = [...v.reasons, ...globalReasons, ...dipReasonsForGate];
    } else {
      baseReasons = [...v.reasons, ...globalReasons, ...dipReasonsForGate];
    }
    const baseDipPass = baseReasons.length === 0;

    let whale: WhaleAnalysis | null = null;
    const whaleReasons: string[] = [];
    if (baseDipPass && cfg.whaleEnabled) {
      whale = await fetchWhaleAnalysis(cfg, row.mint);
      if (whale.creator_dump_block) {
        whaleReasons.push(`creator_dumping_${(whale.creator_dumped_pct * 100).toFixed(0)}%`);
      }
      if (whale.dca_aggressive_present) whaleReasons.push('dca_aggressive_seller');
      if (cfg.whaleRequireTrigger && !whale.trigger_fired && !whaleReasons.length) {
        whaleReasons.push('no_whale_trigger');
      }
    }

    const cooldownMin =
      whale?.trigger_fired === 'dca_predictable' ? cfg.dipCooldownMinScalp : cfg.dipCooldownMinDefault;
    const lastEntry = lastEntryTsByMintMap.get(row.mint) || 0;
    const minutesSinceLast = (Date.now() - lastEntry) / 60_000;
    const cooldownReasons: string[] = [];
    if (lastEntry > 0 && minutesSinceLast < cooldownMin) {
      cooldownReasons.push(
        `cooldown_active_${cooldownMin}m_left_${(cooldownMin - minutesSinceLast).toFixed(0)}m`,
      );
    }

    if (!isLiveReentryHybridGateEnabled(cfg) && cfg.dipLossExitCooldownEnabled) {
      const lossMin = cfg.dipLossExitCooldownMinutes;
      const lossH = cfg.dipLossExitCooldownHours;
      const lastExit = lastPostExitBuyCooldownTsByMintMap.get(row.mint) ?? 0;
      if (lastExit > 0) {
        let resumeAt = 0;
        let label = '';
        if (Number(lossMin) > 0) {
          resumeAt = lastExit + lossMin * 60_000;
          label = `${lossMin}m`;
        } else if (Number(lossH) > 0) {
          resumeAt = lastExit + lossH * 3_600_000;
          label = `${lossH}h`;
        }
        if (resumeAt > 0 && Date.now() < resumeAt) {
          const leftMin = (resumeAt - Date.now()) / 60_000;
          cooldownReasons.push(`post_exit_buy_cooldown_${label}_left_${leftMin.toFixed(1)}m`);
        }
      }
    }

    const reentryObservability: string[] = [];
    appendPostExitReentryGateReasons(cfg, row.mint, row.price_usd, cooldownReasons, reentryObservability);

    const preHoldersReasons = [...baseReasons, ...whaleReasons, ...cooldownReasons];
    const cheapPass = preHoldersReasons.length === 0;

    let holdersMeta: HoldersDecisionMeta | undefined;
    const holderReasons: string[] = [];

    if (liveHoldersForObservability && cheapPass) {
      const dbHolders = Number(row.holder_count ?? 0);
      if (liveHoldersThisTick >= cfg.holdersMaxPerTick) {
        holdersMeta = {
          holders_db: dbHolders,
          holders_live: null,
          holders_source: 'none',
          holders_age_ms: null,
          holders_fail_reason: 'budget_per_tick',
          holders_used_for_gate: dbHolders,
        };
        if (liveHoldersForGate) {
          if (cfg.holdersOnFail === 'block') {
            holderReasons.push('holders_unknown:budget_per_tick');
          } else if (cfg.holdersOnFail === 'db_fallback') {
            if (dbHolders < cfg.globalMinHolderCount) {
              holderReasons.push(`holders<${cfg.globalMinHolderCount}:db_fallback`);
            }
          }
        }
      } else {
        liveHoldersThisTick += 1;
        const r = await resolveHolderCount(cfg, row.mint);
        if (r.ok) {
          holdersMeta = {
            holders_db: dbHolders,
            holders_live: r.count,
            holders_source: r.source,
            holders_age_ms: r.ageMs,
            holders_used_for_gate: r.count,
          };
          if (liveHoldersForGate && r.count < cfg.globalMinHolderCount) {
            holderReasons.push(`holders<${cfg.globalMinHolderCount}`);
          }
        } else {
          holdersMeta = {
            holders_db: dbHolders,
            holders_live: null,
            holders_source: 'none',
            holders_age_ms: null,
            holders_fail_reason: r.reason,
            holders_used_for_gate: dbHolders,
          };
          if (liveHoldersForGate) {
            if (cfg.holdersOnFail === 'block') {
              holderReasons.push(`holders_unknown:${r.reason}`);
            } else if (cfg.holdersOnFail === 'db_fallback') {
              holdersMeta.holders_source = 'db';
              if (dbHolders < cfg.globalMinHolderCount) {
                holderReasons.push(`holders<${cfg.globalMinHolderCount}:db_fallback`);
              }
            }
          }
        }
      }
    }

    /**
     * 1.11.232: если runner не прошёл и dip не прошёл — добавляем runnerReasons в
     * eval reasons для диагностики (видно почему runner-путь не сработал, например
     * `runner_vol1h<80000` или `runner_stale_vol1h<0.5x_of_avg(0.32x)`). Если хотя бы
     * один из путей дал pass — reasons остаются пусты.
     */
    const reasonsWithRunner =
      entryPath == null && runnerReasons.length > 0
        ? [...preHoldersReasons, ...holderReasons, ...runnerReasons]
        : [...preHoldersReasons, ...holderReasons];
    let mergedReasons = reasonsWithRunner;
    let pass = preHoldersReasons.length === 0 && holderReasons.length === 0;
    let oscarIntelProd: OscarIntelGateSnapshot | undefined;
    if (pass) {
      const ig = await evaluateOscarIntelGateForProd(row.mint, cfg);
      if (ig.required) {
        oscarIntelProd = oscarIntelGateSnapshotFromResult(ig, true);
        if (ig.blocked) {
          pass = false;
          mergedReasons = [...mergedReasons, ...ig.reasons.map((r) => `prod_intel_${r}`)];
        } else if (ig.wouldBlock) {
          mergedReasons = [
            ...mergedReasons,
            'prod_intel_shadow_would_block',
            ...ig.reasons.map((r) => `prod_intel_${r}`),
          ];
        }
      }
    }
    if (pass) passed++;

    const reportDipPct =
      entryPath === 'post_crash_fast'
        ? (postCrashFastPath?.features.dropFromPeakPct ?? dipEval.dipPct)
        : dipEval.dipPct;
    const reportDipLookback =
      entryPath === 'post_crash_fast'
        ? (postCrashFastPath?.dipLookbackUsedMin ?? dipEval.dipLookbackUsedMin)
        : dipEval.dipLookbackUsedMin;

    const decisionFeatures = buildFeatures(
      evalRow,
      reportDipPct,
      dipEval.impulsePct,
      reportDipLookback,
      cfg,
      recoveryVeto,
      localHighVeto,
      trendStructureVeto,
      dipEval.perWindowDipPct,
    );
    /**
     * 1.11.167: даже если Policy A+ выключен или вход прошёл — всё равно прикрепляем
     * вычисленные фичи к decision (если есть). Это даёт возможность задним числом
     * прокрутить альтернативные пороги по journal без необходимости пере-парсить
     * `*_pair_snapshots`.
     */
    if (postCrashFastPath != null) {
      const f = postCrashFastPath.features;
      decisionFeatures.post_crash_fast = {
        enabled: cfg.postCrashFastPathEnabled,
        pass: postCrashFastPath.pass,
        coverageOk: f.coverageOk,
        lookbackMin: f.lookbackMin,
        peakPx: f.peakPx,
        minutesSincePeak: f.minutesSincePeak,
        dropFromPeakPct: f.dropFromPeakPct,
        maxVol5mSpikeRatio: f.maxVol5mSpikeRatio,
        priceChange15mPct: f.priceChange15mPct,
        pgSnapsCount: f.pgSnapsCount,
        reasons: postCrashFastPath.reasons,
        thresholds: {
          minDropPct: cfg.postCrashFastPathMinDropPct,
          maxDropPct: cfg.postCrashFastPathMaxDropPct,
          minVolSpikeMult: cfg.postCrashFastPathMinVolSpikeMult,
          stabilizeMin: cfg.postCrashFastPathStabilizeMin,
          maxAgeMin: cfg.postCrashFastPathMaxAgeMin,
          maxKnife15mPct: cfg.postCrashFastPathMaxKnife15mPct,
        },
      };
    }
    if (policyAPlusFeatures != null) {
      decisionFeatures.policy_a_plus = {
        enabled: cfg.policyAPlusEnabled,
        coverageOk: policyAPlusFeatures.coverageOk,
        bounceFromMin30mPct: policyAPlusFeatures.bounceFromMin30mPct,
        priceChange30mPct: policyAPlusFeatures.priceChange30mPct,
        priceChange1hPct: policyAPlusFeatures.priceChange1hPct,
        vol1hUsd: policyAPlusFeatures.vol1hUsd,
        min30m: policyAPlusFeatures.min30m,
        price30mAgo: policyAPlusFeatures.price30mAgo,
        price1hAgo: policyAPlusFeatures.price1hAgo,
        pgSnapsCount: policyAPlusFeatures.pgSnapsCount,
        thresholds: {
          bounceFromMin30mMaxPct: cfg.policyAPlusBounceFromMin30mMaxPct,
          priceChange1hMinPct: cfg.policyAPlusPriceChange1hMinPct,
          priceChangeWindowMin: cfg.policyAPlusPriceChangeWindowMin,
          priceChange30mMinPct: cfg.policyAPlusPriceChange30mMinPct,
          vol1hMaxUsd: cfg.policyAPlusVol1hMaxUsd,
        },
      };
    }
    if (volumeSybilFeatures != null) {
      decisionFeatures.volume_sybil = {
        enabled: cfg.volumeSybilGuardEnabled,
        coverageOk: volumeSybilFeatures.coverageOk,
        lookbackHours: volumeSybilFeatures.lookbackHours,
        recentMinutes: volumeSybilFeatures.recentMinutes,
        baselineSampleCount: volumeSybilFeatures.baselineSampleCount,
        baselineDeadCount: volumeSybilFeatures.baselineDeadCount,
        baselineDeadFraction: volumeSybilFeatures.baselineDeadFraction,
        baselineP10Vol5mUsd: volumeSybilFeatures.baselineP10Vol5mUsd,
        baselineP50Vol5mUsd: volumeSybilFeatures.baselineP50Vol5mUsd,
        recentMaxVol5mUsd: volumeSybilFeatures.recentMaxVol5mUsd,
        currentVol5mUsd: volumeSybilFeatures.currentVol5mUsd,
        effectiveRecentVol5mUsd: volumeSybilFeatures.effectiveRecentVol5mUsd,
        spikeRatio: volumeSybilFeatures.spikeRatio,
        thresholds: {
          baselineP10MaxUsd: cfg.volumeSybilBaselineP10MaxUsd,
          minBaselineSamples: cfg.volumeSybilMinBaselineSamples,
          minRecentVol5mUsd: cfg.volumeSybilMinRecentVol5mUsd,
          spikeRatioMin: cfg.volumeSybilSpikeRatioMin,
          deadVol5mUsd: cfg.volumeSybilDeadVol5mUsd,
          minDeadFraction: cfg.volumeSybilMinDeadFraction,
          vol1hAliveExemptUsd: cfg.volumeSybilVol1hAliveExemptUsd,
        },
      };
    }
    if (volumeEphemeralFeatures != null) {
      const volumeEphemeralKnownMint = isKnownMint(
        cfg,
        row.mint,
        knownMintHistory,
        Date.now(),
        knownMintSupplement,
      );
      const volumeEphemeralFamiliarMint = isFamiliarMint(
        cfg,
        row.mint,
        knownMintHistory,
        Date.now(),
        knownMintSupplement,
      );
      decisionFeatures.volume_ephemeral = {
        enabled: cfg.volumeEphemeralGuardEnabled,
        knownMint: volumeEphemeralKnownMint,
        familiarMint: volumeEphemeralFamiliarMint,
        familiarMintBypass: volumeEphemeralFeatures.familiarMintBypass === true,
        birdeyeFreshBypass: volumeEphemeralFeatures.birdeyeFreshBypass === true,
        coverageOk: volumeEphemeralFeatures.coverageOk,
        lookbackHours: volumeEphemeralFeatures.lookbackHours,
        hoursWithData: volumeEphemeralFeatures.hoursWithData,
        activeHours: volumeEphemeralFeatures.activeHours,
        peakHourVol5mUsd: volumeEphemeralFeatures.peakHourVol5mUsd,
        currentVol5mUsd: volumeEphemeralFeatures.currentVol5mUsd,
        peakToCurrentRatio: volumeEphemeralFeatures.peakToCurrentRatio,
        vol5mPrev1hUsd: volumeEphemeralFeatures.vol5mPrev1hUsd ?? null,
        vol5mPrev2hUsd: volumeEphemeralFeatures.vol5mPrev2hUsd ?? null,
        medianVol5m12hUsd: volumeEphemeralFeatures.medianVol5m12hUsd ?? null,
        neighborHealthy: volumeEphemeralFeatures.neighborHealthy,
        singleTickStaleIgnored: volumeEphemeralFeatures.singleTickStaleIgnored,
        staleIgnoreFlag: volumeEphemeralFeatures.staleIgnoreFlag,
        thresholds: {
          minActiveHourVol5mUsd: cfg.volumeEphemeralMinActiveHourVol5mUsd,
          maxActiveHours: cfg.volumeEphemeralMaxActiveHours,
          minPeakVol5mUsd: cfg.volumeEphemeralMinPeakVol5mUsd,
          minHoursWithData: cfg.volumeEphemeralMinHoursWithData,
          sparseHoursBuffer: cfg.volumeEphemeralSparseHoursBuffer,
          tailBlockEnabled: cfg.volumeEphemeralTailBlockEnabled,
          tailMaxPeakRatio: cfg.volumeEphemeralTailMaxPeakRatio,
          newMintMinActiveHours: cfg.volumeEphemeralNewMintMinActiveHours,
        },
      };
    }
    const knownMintForProfile = isKnownMint(
      cfg,
      row.mint,
      knownMintHistory,
      Date.now(),
      knownMintSupplement,
    );
    if (knownMintForProfile) {
      decisionFeatures.known_mint_vol_profile = {
        vol5mUsd: Number(row.volume_5m ?? 0),
        vol1hUsd: Number(evalRow.volume_1h ?? 0),
        vol5mPrev1hUsd: volumeEphemeralFeatures?.vol5mPrev1hUsd ?? null,
        vol5mPrev2hUsd: volumeEphemeralFeatures?.vol5mPrev2hUsd ?? null,
        activeHours24h: volumeEphemeralFeatures?.activeHours ?? null,
        holderCount:
          row.holder_count != null && Number.isFinite(Number(row.holder_count))
            ? Number(row.holder_count)
            : null,
        medianVol5m12hUsd: volumeEphemeralFeatures?.medianVol5m12hUsd ?? null,
        singleTickStaleIgnored: volumeEphemeralFeatures?.singleTickStaleIgnored === true,
      };
    }
    if (pgDataCoverageFeatures != null) {
      decisionFeatures.pg_data_coverage = {
        enabled: cfg.pgDataCoverageGuardEnabled,
        nearEntry: pgDataCoverageFeatures.nearEntry,
        lookbackHours: pgDataCoverageFeatures.lookbackHours,
        recentHours: pgDataCoverageFeatures.recentHours,
        minuteSamples: pgDataCoverageFeatures.minuteSamples,
        hoursWithData: pgDataCoverageFeatures.hoursWithData,
        recentHoursWithData: pgDataCoverageFeatures.recentHoursWithData,
        hourCoverageRatio: pgDataCoverageFeatures.hourCoverageRatio,
        recentHourCoverageRatio: pgDataCoverageFeatures.recentHourCoverageRatio,
        maxGapMinutes: pgDataCoverageFeatures.recentMaxGapMinutes,
        sybilBaselineSamples: pgDataCoverageFeatures.sybilBaselineSamples,
        sybilCoverageOk: pgDataCoverageFeatures.sybilCoverageOk,
        ephemeralCoverageOk: pgDataCoverageFeatures.ephemeralCoverageOk,
        knownMintGapBypass: pgDataCoverageFeatures.knownMintGapBypass ?? false,
        familiarMintStaleBypass: pgDataCoverageFeatures.familiarMintStaleBypass ?? false,
        birdeyeFreshBypass: pgDataCoverageFeatures.birdeyeFreshBypass ?? false,
        global: {
          pgStaleNow: globalPgCoverage.pgStaleNow,
          systemHourRatio: globalPgCoverage.systemHourRatio,
          strictRecoveryActive: globalPgCoverage.strictRecoveryActive,
          hoursSinceLastRecovery: globalPgCoverage.hoursSinceLastRecovery,
          coverageMode: globalPgCoverage.coverageMode,
        },
        thresholds: {
          minHourRatio: cfg.pgDataCoverageMinHourRatio,
          strictMinHourRatio: cfg.pgDataCoverageStrictMinHourRatio,
          minSystemHourRatio: cfg.pgDataCoverageMinSystemHourRatio,
          minRecentHoursWithData: cfg.pgDataCoverageMinRecentHoursWithData,
          maxGapMinutes: cfg.pgDataCoverageMaxGapMinutes,
        },
      };
    }
    if (runnerFeatures != null) {
      // 1.11.232: Runner Mode features (всегда прикрепляем, если посчитаны).
      decisionFeatures.runner = {
        enabled: cfg.runnerModeEnabled,
        coverageOk: runnerFeatures.coverageOk,
        pgSamples24h: runnerFeatures.pgSamples24h,
        vol1hUsd: runnerFeatures.vol1hUsd,
        vol12hUsd: runnerFeatures.vol12hUsd,
        vol24hUsd: runnerFeatures.vol24hUsd,
        vol1hAvg24hUsd: runnerFeatures.vol1hAvg24hUsd,
        vol1hVelocity: runnerFeatures.vol1hVelocity,
        bs1h: Number.isFinite(runnerFeatures.bs1h ?? NaN) ? runnerFeatures.bs1h : null,
        bs12h: Number.isFinite(runnerFeatures.bs12h ?? NaN) ? runnerFeatures.bs12h : null,
        vol5mPeak1hUsd: runnerFeatures.vol5mPeak1hUsd,
        liqNowUsd: runnerFeatures.liqNowUsd,
        liqP25_24hUsd: runnerFeatures.liqP25_24hUsd,
        liqP50_24hUsd: runnerFeatures.liqP50_24hUsd,
        mcapNowUsd: runnerFeatures.mcapNowUsd,
        mcapMax24hUsd: runnerFeatures.mcapMax24hUsd,
        priceNowUsd: runnerFeatures.priceNowUsd,
        priceMax24hUsd: runnerFeatures.priceMax24hUsd,
        thresholds: {
          minVol1hUsd: cfg.runnerMinVol1hUsd,
          minVol12hUsd: cfg.runnerMinVol12hUsd,
          velocityMinX: cfg.runnerVelocityMinX,
          minVol5mPeak1hUsd: cfg.runnerMinVol5mPeak1hUsd,
          bs1hMin: cfg.runnerBs1hMin,
          bs12hMin: cfg.runnerBs12hMin,
          liqVsP25Min: cfg.runnerLiqVsP25Min,
          priceHoldMin: cfg.runnerPriceHoldMin,
          minMcapUsd: cfg.runnerMinMcapUsd,
          maxMcapUsd: cfg.runnerMaxMcapUsd,
          minLiqUsd: cfg.runnerMinLiqUsd,
          staleVolRatioMax: cfg.runnerStaleVolRatioMax,
          minPgSamples24h: cfg.runnerMinPgSamples24h,
        },
      };
    }
    if (isLiveOscarMcapTieringEnabled(cfg)) {
      decisionFeatures.live_oscar_mcap_tier = journalTier;
    }
    if (reentryObservability.length > 0) {
      decisionFeatures.reentry_fork = { observability: reentryObservability };
    }
    decisions.push({
      lane,
      source: row.source,
      mint: row.mint,
      symbol: row.symbol,
      ageMin: +Number(row.age_min ?? 0).toFixed(1),
      pass,
      reasons: mergedReasons,
      features: decisionFeatures,
      whale,
      holdersMeta,
      entryPath,
      liveOscarTradeLane: 'prod',
      ...(oscarIntelProd ? { oscarIntel: oscarIntelProd } : {}),
      ...(isLiveOscarMcapTieringEnabled(cfg) ? { liveOscarMcapTier: journalTier } : {}),
    });
  }

  const wl = cfg.discoveryDeepAuditWhitelistMintSet;
  const universeMissMints = new Set<string>([...priorityMintSet]);
  if (wl) for (const m of wl) universeMissMints.add(m);
  if (cfg.discoveryDeepAuditJsonl === true && universeMissMints.size > 0) {
    const missEveryMs = cfg.discoveryDeepAuditUniverseMissMinMs;
    for (const mint of universeMissMints) {
      if (
        cfg.mintBlacklistEnabled &&
        cfg.mintBlacklistPath?.trim() &&
        isMintBlacklisted(cfg.mintBlacklistPath.trim(), mint)
      ) {
        continue;
      }
      if (candidateMintKeys.has(mint)) continue;
      if (!allowDeepAuditLog(`${mint}:universe_miss`, missEveryMs)) continue;
      const probe = await fetchLatestCrossVenueSnapshotRowForMint(mint);
      if (probe && !passesDiscoveryMinMarketCap(cfg, probe)) continue;
      const { reasons: sqlReasons, symbol } = explainPostLaneUniverseMiss(cfg, probe);
      const crowded =
        probe != null && sqlReasons.length === 0
          ? explainCrowdedOutOnly(cfg, true)
          : null;
      const reasons = crowded ? [...sqlReasons, crowded] : sqlReasons;
      let snapshotHint: string | undefined;
      if (probe) {
        try {
          snapshotHint = JSON.stringify({
            source: probe.source,
            ts: probe.ts instanceof Date ? probe.ts.toISOString() : String(probe.ts),
            price_usd: probe.price_usd,
            liquidity_usd: probe.liquidity_usd,
            volume_5m: probe.volume_5m,
            volume_1h: probe.volume_1h,
            buys_5m: probe.buys_5m,
            sells_5m: probe.sells_5m,
            age_min: probe.age_min,
            holder_count: probe.holder_count,
          }).slice(0, 1600);
        } catch {
          snapshotHint = undefined;
        }
      }
      auditRows.push({
        kind: 'live_discovery_universe_miss',
        mint,
        symbol,
        lane: 'post_migration',
        source: probe?.source ?? 'none',
        reasons,
        snapshotHint,
      });
    }
  }

  syncDiscoveryCollectorPin(cfg, priorityMintSet);

  if (isLiveOscarScalpWaveLaneEnabled(cfg)) {
    for (const { row, lane } of allowedSnapshotTagged) {
      const discoveryMcap = resolveDiscoveryRefMcap(row);
      const hardMcapReasons: string[] = [];
      const hardMinMcap = resolveDiscoveryHardMcapMinUsd(cfg, {
        volumeLeader: volumeLeaderMintSet.has(row.mint),
      });
      if (hardMinMcap > 0 && discoveryMcap.refMcapUsd + 1e-9 < hardMinMcap) {
        hardMcapReasons.push(
          `discovery_hard_mcap=${Math.round(discoveryMcap.refMcapUsd)}<${hardMinMcap}_src=${discoveryMcap.source}`,
        );
      }
      const ageMin = +Number(row.age_min ?? row.token_age_min ?? 0).toFixed(1);
      if (hardMcapReasons.length > 0) {
        evaluated++;
        decisions.push({
          lane,
          source: row.source,
          mint: row.mint,
          symbol: row.symbol,
          ageMin,
          pass: false,
          reasons: hardMcapReasons,
          features: buildFeatures(row, null, null, null, cfg, undefined, undefined, undefined, undefined),
          whale: null,
          liveOscarMcapTier: 'scalp_wave',
          liveOscarTradeLane: 'scalp_wave',
        });
        continue;
      }
      const scalpEval = evaluateLiveOscarScalpWaveDiscovery({
        cfg,
        row,
        lane,
        refMcap: discoveryMcap.refMcapUsd,
        ageMin,
        dipCtx: dipMap.get(row.mint),
      });
      let scalpPass = scalpEval.pass;
      const scalpReasons = [...scalpEval.reasons];
      if (scalpPass) {
        const familiarMint = isFamiliarMint(
          cfg,
          row.mint,
          knownMintHistory,
          Date.now(),
          knownMintSupplement,
        );
        const knownMint = isKnownMint(cfg, row.mint, knownMintHistory, Date.now(), knownMintSupplement);
        if (cfg.volumeSybilGuardEnabled) {
          const sybilRes = evaluateVolumeSybilGuard(cfg, row, volumeSybilMap.get(row.mint), {
            knownMint,
          });
          if (sybilRes.blocked) {
            scalpPass = false;
            scalpReasons.push(...sybilRes.blockedReasons);
          }
        }
        if (scalpPass && cfg.volumeEphemeralGuardEnabled) {
          const ephemeralRes = evaluateVolumeEphemeralGuard(
            cfg,
            row,
            volumeEphemeralMap.get(row.mint),
            { knownMint, familiarMint },
          );
          if (ephemeralRes.blocked) {
            scalpPass = false;
            scalpReasons.push(...ephemeralRes.blockedReasons);
          }
        }
      }
      evaluated++;
      if (scalpPass) passed++;
      decisions.push({
        lane,
        source: row.source,
        mint: row.mint,
        symbol: row.symbol,
        ageMin,
        pass: scalpPass,
        reasons: scalpReasons,
        features: buildFeatures(row, null, null, null, cfg, undefined, undefined, undefined, undefined),
        whale: null,
        entryPath: scalpEval.entryPath,
        liveOscarMcapTier: 'scalp_wave',
        liveOscarTradeLane: 'scalp_wave',
      });
    }
  }

  // Runner lanes: probe ($500 full pass) → else runner_lite fallback (2×$100).
  const probeGuardPassedMints = new Set<string>();
  const probeOutcomeByMint = new Map<string, { inBand: boolean; fullyPassed: boolean }>();

  if (isRunnerProbeLaneEnabled(cfg)) {
    type ProbeRow = {
      row: SnapshotCandidateRow;
      lane: Lane;
      ageMin: number;
      eval: RunnerProbeDiscoveryEval;
      guardPass: boolean;
      reasons: string[];
      oscarIntel?: OscarIntelGateSnapshot;
    };
    const probeRows: ProbeRow[] = [];

    for (const { row, lane } of allowedSnapshotTagged) {
      const discoveryMcap = resolveDiscoveryRefMcap(row);
      const ageMin = +Number(row.age_min ?? row.token_age_min ?? 0).toFixed(1);
      // Skip runner_probe entirely for out-of-band mints — avoids misleading deep-audit noise on prod lane.
      if (!runnerProbeCandidateInBand(cfg, discoveryMcap.refMcapUsd, ageMin)) {
        continue;
      }
      const probeEval = evaluateLiveOscarRunnerProbeDiscovery({
        cfg,
        row,
        lane,
        refMcap: discoveryMcap.refMcapUsd,
        ageMin,
        dipCtx: dipMap.get(row.mint),
        runnerCtx: runnerMap.get(row.mint),
      });
      let guardPass = probeEval.pass;
      const reasons = [...probeEval.reasons];

      if (guardPass) {
        const familiarMint = isFamiliarMint(
          cfg,
          row.mint,
          knownMintHistory,
          Date.now(),
          knownMintSupplement,
        );
        const knownMint = isKnownMint(cfg, row.mint, knownMintHistory, Date.now(), knownMintSupplement);
        if (cfg.volumeSybilGuardEnabled) {
          const sybilRes = evaluateVolumeSybilGuard(cfg, row, volumeSybilMap.get(row.mint), {
            knownMint,
          });
          if (sybilRes.blocked) {
            guardPass = false;
            reasons.push(...sybilRes.blockedReasons);
          }
        }
        if (guardPass && cfg.volumeEphemeralGuardEnabled) {
          const ephemeralRes = evaluateVolumeEphemeralGuard(
            cfg,
            row,
            volumeEphemeralMap.get(row.mint),
            { knownMint, familiarMint },
          );
          if (ephemeralRes.blocked) {
            guardPass = false;
            reasons.push(...ephemeralRes.blockedReasons);
          }
        }
        if (guardPass) {
          const ig = await evaluateOscarIntelGateForRunnerProbe(row.mint, cfg, ageMin);
          const intelSnap = oscarIntelGateSnapshotFromResult(ig, probeEval.pass);
          if (ig.required) {
            if (ig.blocked) {
              guardPass = false;
              reasons.push(...ig.reasons.map((r) => `runner_probe_intel_${r}`));
            } else if (ig.wouldBlock) {
              reasons.push('runner_probe_intel_shadow_would_block');
              reasons.push(...ig.reasons.map((r) => `runner_probe_intel_${r}`));
            }
          }
          probeRows.push({
            row,
            lane,
            ageMin,
            eval: probeEval,
            guardPass,
            reasons,
            oscarIntel: ig.required ? intelSnap : undefined,
          });
          continue;
        }
      }

      probeRows.push({ row, lane, ageMin, eval: probeEval, guardPass, reasons });
    }

    for (const pr of probeRows) {
      probeOutcomeByMint.set(pr.row.mint, { inBand: true, fullyPassed: pr.guardPass });
      if (pr.guardPass) probeGuardPassedMints.add(pr.row.mint);
    }

    probeRows.sort((a, b) => (b.eval.rankScore ?? 0) - (a.eval.rankScore ?? 0));
    let rankSlots = cfg.runnerProbeMaxConcurrent;

    for (const pr of probeRows) {
      evaluated++;
      let pass = pr.guardPass;
      const outReasons = [...pr.reasons];
      if (pass) {
        if (rankSlots <= 0) {
          pass = false;
          outReasons.push('runner_probe_rank_crowded_out');
        } else {
          rankSlots -= 1;
        }
      }
      if (pass) passed++;
      const baseFeatures = buildFeatures(
        pr.row,
        null,
        null,
        null,
        cfg,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      if (pr.eval.runnerFeatures) {
        Object.assign(baseFeatures, {
          runner_probe: {
            rankScore: pr.eval.rankScore,
            summary: summariseRunnerPass(pr.eval.runnerFeatures),
          },
        });
      }
      decisions.push({
        lane: pr.lane,
        source: pr.row.source,
        mint: pr.row.mint,
        symbol: pr.row.symbol,
        ageMin: pr.ageMin,
        pass,
        reasons: outReasons,
        features: baseFeatures,
        whale: null,
        entryPath: pr.eval.entryPath,
        liveOscarTradeLane: 'runner_probe',
        positionSource: 'runner_probe',
        oscarIntel: pr.oscarIntel,
      });
    }
  }

  if (isRunnerLiteLaneEnabled(cfg)) {
    type LiteRow = {
      row: SnapshotCandidateRow;
      lane: Lane;
      ageMin: number;
      eval: RunnerLiteDiscoveryEval;
      guardPass: boolean;
      reasons: string[];
      oscarIntel?: OscarIntelGateSnapshot;
    };
    const liteRows: LiteRow[] = [];

    for (const { row, lane } of allowedSnapshotTagged) {
      const discoveryMcap = resolveDiscoveryRefMcap(row);
      const ageMin = +Number(row.age_min ?? row.token_age_min ?? 0).toFixed(1);
      if (!runnerLiteDiscoveryPrefilter(cfg, discoveryMcap.refMcapUsd, ageMin)) {
        continue;
      }
      if (probeGuardPassedMints.has(row.mint)) {
        continue;
      }
      const probeOutcome = probeOutcomeByMint.get(row.mint) ?? {
        inBand: false,
        fullyPassed: false,
      };
      const liteEval = evaluateLiveOscarRunnerLiteDiscovery({
        cfg,
        row,
        lane,
        refMcap: discoveryMcap.refMcapUsd,
        ageMin,
        dipCtx: dipMap.get(row.mint),
        runnerCtx: runnerMap.get(row.mint),
        probeOutcome,
      });
      let guardPass = liteEval.pass;
      const reasons = [...liteEval.reasons];

      if (guardPass) {
        const familiarMint = isFamiliarMint(
          cfg,
          row.mint,
          knownMintHistory,
          Date.now(),
          knownMintSupplement,
        );
        const knownMint = isKnownMint(cfg, row.mint, knownMintHistory, Date.now(), knownMintSupplement);
        if (cfg.volumeSybilGuardEnabled) {
          const sybilRes = evaluateVolumeSybilGuard(cfg, row, volumeSybilMap.get(row.mint), {
            knownMint,
          });
          if (sybilRes.blocked) {
            guardPass = false;
            reasons.push(...sybilRes.blockedReasons);
          }
        }
        if (guardPass && cfg.volumeEphemeralGuardEnabled) {
          const ephemeralRes = evaluateVolumeEphemeralGuard(
            cfg,
            row,
            volumeEphemeralMap.get(row.mint),
            { knownMint, familiarMint },
          );
          if (ephemeralRes.blocked) {
            guardPass = false;
            reasons.push(...ephemeralRes.blockedReasons);
          }
        }
        if (guardPass) {
          const ig = await evaluateOscarIntelGateForRunnerLite(row.mint, cfg, ageMin);
          const intelSnap = oscarIntelGateSnapshotFromResult(ig, liteEval.pass);
          if (ig.required) {
            if (ig.blocked) {
              guardPass = false;
              reasons.push(...ig.reasons.map((r) => `runner_lite_intel_${r}`));
            } else if (ig.wouldBlock) {
              reasons.push('runner_lite_intel_shadow_would_block');
              reasons.push(...ig.reasons.map((r) => `runner_lite_intel_${r}`));
            }
          }
          liteRows.push({
            row,
            lane,
            ageMin,
            eval: liteEval,
            guardPass,
            reasons,
            oscarIntel: ig.required ? intelSnap : undefined,
          });
          continue;
        }
      }

      liteRows.push({ row, lane, ageMin, eval: liteEval, guardPass, reasons });
    }

    liteRows.sort((a, b) => (b.eval.rankScore ?? 0) - (a.eval.rankScore ?? 0));
    let liteRankSlots = cfg.runnerLiteMaxConcurrent;

    for (const lr of liteRows) {
      evaluated++;
      let pass = lr.guardPass;
      const outReasons = [...lr.reasons];
      if (pass) {
        if (liteRankSlots <= 0) {
          pass = false;
          outReasons.push('runner_lite_rank_crowded_out');
        } else {
          liteRankSlots -= 1;
        }
      }
      if (pass) passed++;
      const baseFeatures = buildFeatures(
        lr.row,
        null,
        null,
        null,
        cfg,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      if (lr.eval.runnerFeatures) {
        Object.assign(baseFeatures, {
          runner_lite: {
            rankScore: lr.eval.rankScore,
            summary: summariseRunnerPass(lr.eval.runnerFeatures),
          },
        });
      }
      decisions.push({
        lane: lr.lane,
        source: lr.row.source,
        mint: lr.row.mint,
        symbol: lr.row.symbol,
        ageMin: lr.ageMin,
        pass,
        reasons: outReasons,
        features: baseFeatures,
        whale: null,
        entryPath: lr.eval.entryPath,
        liveOscarTradeLane: 'runner_lite',
        positionSource: 'runner_lite',
        oscarIntel: lr.oscarIntel,
      });
    }
  }

  if (isPervyyVystrelObservabilityActive(cfg)) {
    for (const { row, lane } of allowedSnapshotTagged) {
      const discoveryMcap = resolveDiscoveryRefMcap(row);
      const ageMin = +Number(row.age_min ?? row.token_age_min ?? 0).toFixed(1);
      if (!pervyyVystrelDiscoveryPrefilter(cfg, discoveryMcap.refMcapUsd, ageMin)) {
        continue;
      }
      const pvEval = evaluateLiveOscarPervyyVystrelDiscovery({
        cfg,
        row,
        lane,
        refMcap: discoveryMcap.refMcapUsd,
        ageMin,
        discoveryMcap,
      });
      evaluated++;
      const baseFeatures = buildFeatures(
        row,
        null,
        null,
        null,
        cfg,
        undefined,
        undefined,
        undefined,
        undefined,
      );
      Object.assign(baseFeatures, {
        pervyy_vystrel: {
          phase: pvEval.phase,
          wouldOnboard: pvEval.wouldOnboard,
          vol1hUsd: Number(row.volume_1h ?? 0),
          refMcapUsd: discoveryMcap.refMcapUsd,
          volAuth: pvEval.shadowAnalyzers?.volAuth ?? undefined,
          organicFlow: pvEval.shadowAnalyzers?.organicFlow ?? undefined,
          clusterDump: pvEval.shadowAnalyzers?.clusterDump ?? undefined,
        },
      });
      if (pvEval.wouldOnboard) {
        auditRows.push({
          kind: 'pervyy_vystrel_watch_onboard',
          mint: row.mint,
          symbol: row.symbol,
          lane,
          source: row.source,
          mcap: discoveryMcap.refMcapUsd,
          vol1h: Number(row.volume_1h ?? 0),
          anchor_band: `${cfg.pervyyVystrel.anchorMinMcapUsd}-${cfg.pervyyVystrel.anchorMaxMcapUsd}`,
          shadowMode: pvEval.shadowMode,
        });
      }
      if (pvEval.watchlistActive || pvEval.wouldOnboard) {
        for (const ev of pvEval.shadowAnalyzers?.journalEvents ?? []) {
          auditRows.push(ev);
        }
      } else if (pvEval.phase === 'phase0' || pvEval.reasons.some((r) => r.startsWith('pervyy_vystrel_'))) {
        auditRows.push({
          kind: 'pervyy_vystrel_shadow_skip',
          mint: row.mint,
          symbol: row.symbol,
          lane,
          source: row.source,
          reasons: pvEval.reasons.slice(0, 12),
          phase: pvEval.phase,
        });
        for (const ev of pvEval.shadowAnalyzers?.journalEvents ?? []) {
          auditRows.push(ev);
        }
      }
      decisions.push({
        lane,
        source: row.source,
        mint: row.mint,
        symbol: row.symbol,
        ageMin,
        pass: pvEval.pass,
        reasons: pvEval.reasons,
        features: baseFeatures,
        whale: null,
        liveOscarTradeLane: 'pervyy_vystrel',
        positionSource: 'pervyy_vystrel',
        pervyyVystrel: {
          phase: pvEval.phase,
          wouldOnboard: pvEval.wouldOnboard,
          shadowMode: pvEval.shadowMode,
          watchlistActive: pvEval.watchlistActive,
          phantomGatesPass: pvEval.phantomGatesPass,
          volAuth: pvEval.shadowAnalyzers?.volAuth ?? undefined,
          organicFlow: pvEval.shadowAnalyzers?.organicFlow ?? undefined,
          clusterDump: pvEval.shadowAnalyzers?.clusterDump ?? undefined,
        },
      });
    }
  }

  return {
    discovered: snapshotTagged.length,
    evaluated,
    passed,
    decisions,
    auditRows,
    pgCoverageModeChanged: globalPgCoverage.coverageModeChanged,
    priorityMintSet,
  };
}

export function recordEntryTs(mint: string, ts: number): void {
  lastEntryTsByMintMap.set(mint, ts);
}

/** Prior bot open/close within lookback — qualifies for PG gap bypass on repeat mints. */
export function isPgCoverageKnownMint(
  cfg: PaperTraderConfig,
  mint: string,
  history = buildKnownMintTradeHistory({
    lastEntryTsByMint: lastEntryTsByMintMap,
    lastPostExitBuyCooldownTsByMint: lastPostExitBuyCooldownTsByMintMap,
    lastRealExitMarketSnapshotByMint: lastRealExitMarketSnapshotByMintMap,
    lastExitMarketSnapshotByMint: lastExitMarketSnapshotByMintMap,
  }),
  nowMs = Date.now(),
): boolean {
  return isPgCoverageKnownMintFromHistory(cfg, mint, history, nowMs);
}

export { isFamiliarMint, isKnownMint } from './known-mint.js';
