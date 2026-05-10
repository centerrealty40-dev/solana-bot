import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow, SnapshotFeatures, WhaleAnalysis } from '../types.js';
import { fetchLatestCrossVenueSnapshotRowForMint, fetchSnapshotLaneCandidates } from './snapshot.js';
import { explainCrowdedOutOnly, explainPostLaneUniverseMiss } from './universe-miss-explain.js';
import { evaluateSnapshot } from '../filters/snapshot-filter.js';
import { globalGate } from '../filters/global-gate.js';
import {
  fetchDipContextMap,
  evaluateDip,
  evaluateRecoveryVeto,
  type RecoveryVetoResult,
} from '../dip-detector.js';
import { fetchWhaleAnalysis } from '../whale-analysis.js';
import { resolveHolderCount } from '../holders/holders-resolve.js';
import { impulsePgSnapTriggerOk } from '../pricing/impulse-confirm.js';
import { filterSnapshotTaggedByMintBlacklist, isMintBlacklisted } from './mint-blacklist-file.js';

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
  /** Как пройден входной гейт цены (если применимо); см. `PAPER_ENTRY_IMPULSE_PG_BYPASS_DIP`. */
  entryPath?: 'dip_windows' | 'impulse_pg_snap';
}

export interface DiscoveryTickResult {
  discovered: number;
  evaluated: number;
  passed: number;
  decisions: EvalDecision[];
  /** Live deep audit rows (flushed via `journalAppend` in `papertrader/main`). */
  auditRows?: Record<string, unknown>[];
}

const deepAuditLastLogMs = new Map<string, number>();

function allowDeepAuditLog(key: string, minMs: number): boolean {
  const now = Date.now();
  const prev = deepAuditLastLogMs.get(key) ?? 0;
  if (now - prev < minMs) return false;
  deepAuditLastLogMs.set(key, now);
  return true;
}

export const evaluatedAtMap = new Map<string, number>();
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

function shouldEvaluate(mint: string, reevalAfterSec: number): boolean {
  const last = evaluatedAtMap.get(mint) || 0;
  if (Date.now() - last < reevalAfterSec * 1000) return false;
  evaluatedAtMap.set(mint, Date.now());
  return true;
}

function buildFeatures(
  row: SnapshotCandidateRow,
  dipPct: number | null,
  impulsePct: number | null,
  dipLookbackUsedMin: number | null,
  cfg: PaperTraderConfig,
  recoveryVeto: RecoveryVetoResult | undefined,
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
  if (snapshotTagged.length === 0) {
    return { discovered: 0, evaluated: 0, passed: 0, decisions: [] };
  }
  const dipMap = await fetchDipContextMap(
    cfg,
    snapshotTagged.map((x) => x.row),
  );
  await warmupSnapshotHolderCounts(cfg, snapshotTagged);
  const reevalAfterSec = cfg.discoveryReevalSec;

  const decisions: EvalDecision[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const candidateMintKeys = new Set(snapshotTagged.map((x) => x.row.mint));
  let evaluated = 0;
  let passed = 0;
  let liveHoldersThisTick = 0;
  const liveHoldersEnabled =
    cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0;

  for (const { row, lane } of snapshotTagged) {
    const deepWl =
      cfg.discoveryDeepAuditJsonl === true &&
      cfg.discoveryDeepAuditWhitelistMintSet &&
      cfg.discoveryDeepAuditWhitelistMintSet.has(row.mint);
    if (!shouldEvaluate(row.mint, reevalAfterSec)) {
      if (
        deepWl &&
        allowDeepAuditLog(
          `${row.mint}:tick_skip`,
          cfg.discoveryDeepAuditUniverseMissMinMs,
        )
      ) {
        auditRows.push({
          kind: 'live_discovery_tick_skip',
          mint: row.mint,
          symbol: row.symbol,
          lane,
          source: row.source,
          reason: 'reeval_throttle',
          discoveryReevalSec: reevalAfterSec,
        });
      }
      continue;
    }
    evaluated++;

    const v = evaluateSnapshot(cfg, row, lane);
    const globalReasons = globalGate(cfg, row.token_age_min, row.holder_count, {
      skipHolderCheck: liveHoldersEnabled,
    });
    const dipEval = evaluateDip(cfg, row, dipMap.get(row.mint));
    let dipReasonsForGate = dipEval.reasons;
    let entryPath: EvalDecision['entryPath'];
    let recoveryVeto: RecoveryVetoResult | undefined;
    if (dipEval.reasons.length === 0) {
      entryPath = 'dip_windows';
      recoveryVeto = evaluateRecoveryVeto(cfg, row, dipMap.get(row.mint), dipEval.dipLookbackUsedMin);
      if (recoveryVeto.reasons.length > 0) {
        dipReasonsForGate = recoveryVeto.reasons;
        entryPath = undefined;
      }
    } else if (cfg.entryImpulsePgBypassesDip) {
      const bypass = await impulsePgSnapTriggerOk(cfg, row.mint, row.source, row.pair_address ?? null);
      if (bypass) {
        dipReasonsForGate = [];
        entryPath = 'impulse_pg_snap';
      }
    }
    const baseReasons = [...v.reasons, ...globalReasons, ...dipReasonsForGate];
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

    if (liveHoldersEnabled && cheapPass) {
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
        if (cfg.holdersOnFail === 'block') {
          holderReasons.push('holders_unknown:budget_per_tick');
        } else if (cfg.holdersOnFail === 'db_fallback') {
          if (dbHolders < cfg.globalMinHolderCount) {
            holderReasons.push(`holders<${cfg.globalMinHolderCount}:db_fallback`);
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
          if (r.count < cfg.globalMinHolderCount) {
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

    const mergedReasons = [...preHoldersReasons, ...holderReasons];
    const pass = mergedReasons.length === 0;
    if (pass) passed++;

    decisions.push({
      lane,
      source: row.source,
      mint: row.mint,
      symbol: row.symbol,
      ageMin: +Number(row.age_min ?? 0).toFixed(1),
      pass,
      reasons: mergedReasons,
      features: buildFeatures(
        row,
        dipEval.dipPct,
        dipEval.impulsePct,
        dipEval.dipLookbackUsedMin,
        cfg,
        recoveryVeto,
      ),
      whale,
      holdersMeta,
      entryPath,
    });
  }

  const wl = cfg.discoveryDeepAuditWhitelistMintSet;
  if (cfg.discoveryDeepAuditJsonl === true && wl && wl.size > 0) {
    const missEveryMs = cfg.discoveryDeepAuditUniverseMissMinMs;
    for (const mint of wl) {
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

  return { discovered: snapshotTagged.length, evaluated, passed, decisions, auditRows };
}

export function recordEntryTs(mint: string, ts: number): void {
  lastEntryTsByMintMap.set(mint, ts);
}
