import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow, SnapshotFeatures, WhaleAnalysis } from '../types.js';
import { fetchLatestCrossVenueSnapshotRowForMint, fetchSnapshotLaneCandidates } from './snapshot.js';
import { explainCrowdedOutOnly, explainPostLaneUniverseMiss } from './universe-miss-explain.js';
import { evaluateSnapshot, passesDiscoveryMinMarketCap, evaluateSnapshotPriorityTier } from '../filters/snapshot-filter.js';
import { globalGate } from '../filters/global-gate.js';
import {
  fetchDipContextMap,
  evaluateDip,
  evaluateLocalHighVeto,
  evaluateRecoveryVeto,
  type LocalHighVetoResult,
  type RecoveryVetoResult,
} from '../dip-detector.js';
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
import { injectPriorityDiscoveryCandidates } from './priority-discovery-inject.js';
import { refreshPriorityMintPricesFromJupiter } from './priority-dip-price-refresh.js';
import { shouldEvaluateMint } from './discovery-eval-throttle.js';
import {
  fetchRunnerContextMap,
  evaluateRunner,
  type RunnerWindowFeatures,
} from './runner-mode.js';

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
  entryPath?: 'dip_windows' | 'impulse_pg_snap' | 'runner';
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

/** Рыночная цена последнего полного выхода (USD/token) — гейт повторного входа vs снимок. */
export const lastExitMarketSnapshotByMintMap = new Map<string, { exitTs: number; marketUsd: number }>();

export function recordLastExitMarketSnapshotAfterClose(mint: string, exitTsMs: number, marketUsd: number): void {
  if (!(exitTsMs > 0)) return;
  const px = Number(marketUsd);
  if (!(px > 0)) return;
  const prev = lastExitMarketSnapshotByMintMap.get(mint);
  if (!prev || exitTsMs >= prev.exitTs) {
    lastExitMarketSnapshotByMintMap.set(mint, { exitTs: exitTsMs, marketUsd: px });
  }
}

/** После полного закрытия: cooldown по времени + снимок цены выхода для гейта re-entry. */
export function recordAfterFullCloseForMintRepeatGate(
  cfg: PaperTraderConfig,
  mint: string,
  exitTsMs: number,
  theoreticalExitUsd: number,
  effectiveExitUsd: number,
): void {
  recordPostExitBuyCooldownIfApplicable(cfg, mint, exitTsMs);
  const px = theoreticalExitUsd > 0 ? theoreticalExitUsd : effectiveExitUsd;
  recordLastExitMarketSnapshotAfterClose(mint, exitTsMs, px);
}

export function appendLiveReentryPriceGapReasons(
  cfg: PaperTraderConfig,
  mint: string,
  snapshotPriceUsd: number,
  out: string[],
): void {
  const pct = cfg.liveReentryMinDropFromLastExitPct;
  if (!(Number(pct) > 0)) return;
  const snap = lastExitMarketSnapshotByMintMap.get(mint);
  if (!snap || !(snap.marketUsd > 0) || !(snapshotPriceUsd > 0)) return;
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
): number {
  if (cfg.priorityDiscoveryEnabled && priorityMintSet.has(mint)) {
    return cfg.priorityDiscoveryReevalSec;
  }
  return cfg.discoveryReevalSec;
}

function shouldEvaluate(
  mint: string,
  priorityMintSet: ReadonlySet<string>,
  cfg: PaperTraderConfig,
): boolean {
  return shouldEvaluateMint(mint, resolveDiscoveryReevalSec(cfg, mint, priorityMintSet));
}

function buildFeatures(
  row: SnapshotCandidateRow,
  dipPct: number | null,
  impulsePct: number | null,
  dipLookbackUsedMin: number | null,
  cfg: PaperTraderConfig,
  recoveryVeto: RecoveryVetoResult | undefined,
  localHighVeto: LocalHighVetoResult | undefined,
  perWindowDipPct: Record<number, number> | undefined,
): SnapshotFeatures {
  const base: SnapshotFeatures = {
    price_usd: +Number(row.price_usd || 0).toFixed(8),
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
  if (snapshotTagged.length === 0) {
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
    allowedFlag.set(row.mint, shouldEvaluate(row.mint, priorityMintSet, cfg));
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
    return {
      discovered: snapshotTagged.length,
      evaluated: 0,
      passed: 0,
      decisions: [],
      auditRows: auditRowsThrottle.length > 0 ? auditRowsThrottle : undefined,
      priorityMintSet,
    };
  }

  await refreshPriorityMintPricesFromJupiter(
    cfg,
    allowedSnapshotTagged.map((x) => x.row),
    priorityMintSet,
  );

  const rowsForCtx = allowedSnapshotTagged.map((x) => x.row);
  const [dipMap, policyAPlusMap, volumeSybilMap, volumeEphemeralMap, globalPgCoverage, runnerMap] =
    await Promise.all([
      fetchDipContextMap(cfg, rowsForCtx),
      fetchPolicyAPlusContextMap(cfg, rowsForCtx),
      fetchVolumeSybilContextMap(cfg, rowsForCtx),
      fetchVolumeEphemeralContextMap(cfg, rowsForCtx),
      fetchGlobalPgCoverageState(cfg),
      fetchRunnerContextMap(cfg, rowsForCtx),
    ]);
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
        discoveryReevalSec: resolveDiscoveryReevalSec(cfg, row.mint, priorityMintSet),
      });
    }
  }

  for (const { row, lane } of allowedSnapshotTagged) {
    evaluated++;

    const v = priorityMintSet.has(row.mint)
      ? evaluateSnapshotPriorityTier(cfg, row, lane)
      : evaluateSnapshot(cfg, row, lane);
    const globalReasons = globalGate(cfg, row.token_age_min, row.holder_count, {
      skipHolderCheck: liveHoldersForGate,
    });
    const snapshotGatePass = v.pass && globalReasons.length === 0;
    const dipEval = evaluateDip(cfg, row, dipMap.get(row.mint));
    let dipReasonsForGate = dipEval.reasons;
    let entryPath: EvalDecision['entryPath'];
    let recoveryVeto: RecoveryVetoResult | undefined;
    let localHighVeto: LocalHighVetoResult | undefined;
    if (snapshotGatePass && dipEval.reasons.length === 0) {
      entryPath = 'dip_windows';
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
      // Recovery veto + Local-high veto (раньше были только для dip_windows).
      recoveryVeto = evaluateRecoveryVeto(cfg, row, dipMap.get(row.mint), dipEval.dipLookbackUsedMin);
      if (recoveryVeto.reasons.length > 0) {
        dipReasonsForGate = [...dipReasonsForGate, ...recoveryVeto.reasons];
        entryPath = undefined;
      } else {
        localHighVeto = evaluateLocalHighVeto(cfg, row, dipMap.get(row.mint));
        if (localHighVeto.reasons.length > 0) {
          dipReasonsForGate = [...dipReasonsForGate, ...localHighVeto.reasons];
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
        const evalRes = evaluatePgDataCoverageGuard(
          cfg,
          row,
          mintPgCoverageMap.get(row.mint),
          globalPgCoverage,
          true,
        );
        pgDataCoverageFeatures = evalRes.features;
        if (evalRes.blocked) {
          dipReasonsForGate = [...dipReasonsForGate, ...evalRes.blockedReasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.volumeSybilGuardEnabled) {
        const evalRes = evaluateVolumeSybilGuard(cfg, row, volumeSybilMap.get(row.mint));
        volumeSybilFeatures = evalRes.features;
        if (evalRes.blocked) {
          dipReasonsForGate = [...dipReasonsForGate, ...evalRes.blockedReasons];
          entryPath = undefined;
        }
      }
      if (entryPath != null && cfg.volumeEphemeralGuardEnabled) {
        const evalRes = evaluateVolumeEphemeralGuard(cfg, row, volumeEphemeralMap.get(row.mint));
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

    if (cfg.dipLossExitCooldownEnabled) {
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

    appendLiveReentryPriceGapReasons(cfg, row.mint, row.price_usd, cooldownReasons);

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
    const mergedReasons = reasonsWithRunner;
    const pass = preHoldersReasons.length === 0 && holderReasons.length === 0;
    if (pass) passed++;

    const decisionFeatures = buildFeatures(
      row,
      dipEval.dipPct,
      dipEval.impulsePct,
      dipEval.dipLookbackUsedMin,
      cfg,
      recoveryVeto,
      localHighVeto,
      dipEval.perWindowDipPct,
    );
    /**
     * 1.11.167: даже если Policy A+ выключен или вход прошёл — всё равно прикрепляем
     * вычисленные фичи к decision (если есть). Это даёт возможность задним числом
     * прокрутить альтернативные пороги по journal без необходимости пере-парсить
     * `*_pair_snapshots`.
     */
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
        },
      };
    }
    if (volumeEphemeralFeatures != null) {
      decisionFeatures.volume_ephemeral = {
        enabled: cfg.volumeEphemeralGuardEnabled,
        coverageOk: volumeEphemeralFeatures.coverageOk,
        lookbackHours: volumeEphemeralFeatures.lookbackHours,
        hoursWithData: volumeEphemeralFeatures.hoursWithData,
        activeHours: volumeEphemeralFeatures.activeHours,
        peakHourVol5mUsd: volumeEphemeralFeatures.peakHourVol5mUsd,
        currentVol5mUsd: volumeEphemeralFeatures.currentVol5mUsd,
        peakToCurrentRatio: volumeEphemeralFeatures.peakToCurrentRatio,
        thresholds: {
          minActiveHourVol5mUsd: cfg.volumeEphemeralMinActiveHourVol5mUsd,
          maxActiveHours: cfg.volumeEphemeralMaxActiveHours,
          minPeakVol5mUsd: cfg.volumeEphemeralMinPeakVol5mUsd,
          minHoursWithData: cfg.volumeEphemeralMinHoursWithData,
          sparseHoursBuffer: cfg.volumeEphemeralSparseHoursBuffer,
          tailBlockEnabled: cfg.volumeEphemeralTailBlockEnabled,
          tailMaxPeakRatio: cfg.volumeEphemeralTailMaxPeakRatio,
        },
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
