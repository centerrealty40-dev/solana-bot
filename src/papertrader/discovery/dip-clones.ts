import type { PaperTraderConfig } from '../config.js';
import type { Lane, SnapshotCandidateRow, SnapshotFeatures, WhaleAnalysis } from '../types.js';
import { fetchSnapshotLaneCandidates } from './snapshot.js';
import { evaluateSnapshot } from '../filters/snapshot-filter.js';
import { globalGate } from '../filters/global-gate.js';
import { fetchDipContextMap, evaluateDip } from '../dip-detector.js';
import { fetchWhaleAnalysis } from '../whale-analysis.js';

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
): SnapshotFeatures {
  return {
    price_usd: +Number(row.price_usd || 0).toFixed(8),
    liq_usd: +Number(row.liquidity_usd || 0).toFixed(0),
    vol5m_usd: +Number(row.volume_5m || 0).toFixed(0),
    buys5m: row.buys_5m,
    sells5m: row.sells_5m,
    buy_sell_ratio_5m: row.sells_5m > 0 ? +(row.buys_5m / row.sells_5m).toFixed(2) : null,
    holders: row.holder_count,
    token_age_min: +Number(row.token_age_min ?? 0).toFixed(1),
    dip_pct: dipPct !== null ? +dipPct.toFixed(2) : null,
    impulse_pct: impulsePct !== null ? +impulsePct.toFixed(2) : null,
    market_cap_usd:
      row.market_cap_usd != null && Number(row.market_cap_usd) > 0
        ? +Number(row.market_cap_usd).toFixed(2)
        : null,
  };
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
  const reevalAfterSec = 60;

  const decisions: EvalDecision[] = [];
  let evaluated = 0;
  let passed = 0;

  for (const { row, lane } of snapshotTagged) {
    if (!shouldEvaluate(row.mint, reevalAfterSec)) continue;
    evaluated++;

    const v = evaluateSnapshot(cfg, row, lane);
    const globalReasons = globalGate(cfg, row.token_age_min, row.holder_count);
    const dipEval = evaluateDip(cfg, row, dipMap.get(row.mint));
    const baseReasons = [...v.reasons, ...globalReasons, ...dipEval.reasons];
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

    const mergedReasons = [...baseReasons, ...whaleReasons, ...cooldownReasons];
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
      features: buildFeatures(row, dipEval.dipPct, dipEval.impulsePct),
      whale,
    });
  }

  return { discovered: snapshotTagged.length, evaluated, passed, decisions };
}

export function recordEntryTs(mint: string, ts: number): void {
  lastEntryTsByMintMap.set(mint, ts);
}
