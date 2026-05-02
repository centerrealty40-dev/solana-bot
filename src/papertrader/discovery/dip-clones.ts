import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow, SnapshotFeatures, WhaleAnalysis } from '../types.js';
import { fetchSnapshotLaneCandidates } from './snapshot.js';
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
}

export const evaluatedAtMap = new Map<string, number>();
export const lastEntryTsByMintMap = new Map<string, number>();

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

export async function runDipDiscovery(cfg: PaperTraderConfig): Promise<DiscoveryTickResult> {
  const [migRows, postRows] = await Promise.all([
    cfg.enableMigrationLane ? fetchSnapshotLaneCandidates(cfg, 'migration_event') : Promise.resolve([]),
    cfg.enablePostLane ? fetchSnapshotLaneCandidates(cfg, 'post_migration') : Promise.resolve([]),
  ]);
  const snapshotTagged: Array<{ row: SnapshotCandidateRow; lane: Lane }> = [
    ...migRows.map((row) => ({ row, lane: 'migration_event' as const })),
    ...postRows.map((row) => ({ row, lane: 'post_migration' as const })),
  ];
  if (snapshotTagged.length === 0) {
    return { discovered: 0, evaluated: 0, passed: 0, decisions: [] };
  }
  const dipMap = await fetchDipContextMap(
    cfg,
    snapshotTagged.map((x) => x.row),
  );
  const reevalAfterSec = cfg.discoveryReevalSec;

  const decisions: EvalDecision[] = [];
  let evaluated = 0;
  let passed = 0;
  let liveHoldersThisTick = 0;
  const liveHoldersEnabled =
    cfg.holdersLiveEnabled && cfg.globalMinHolderCount > 0;

  for (const { row, lane } of snapshotTagged) {
    if (!shouldEvaluate(row.mint, reevalAfterSec)) continue;
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

  return { discovered: snapshotTagged.length, evaluated, passed, decisions };
}

export function recordEntryTs(mint: string, ts: number): void {
  lastEntryTsByMintMap.set(mint, ts);
}
