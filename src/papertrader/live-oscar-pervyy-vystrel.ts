import type { PaperTraderConfig } from './config.js';
import type { ClusterDumpShadowEval } from './discovery/mint-early-cluster-map.js';
import type { OrganicFlowSnapshot } from './discovery/mint-organic-flow-gate.js';
import type { VolumeAuthenticitySnapshot } from './discovery/mint-volume-authenticity.js';
import {
  readPervyyVystrelMintSnapshot,
  type PervyyVystrelMintMaterialized,
} from './discovery/pervyy-vystrel-snapshot-cache.js';
import {
  isPervyyVystrelLaneEnabled,
  isPervyyVystrelObservabilityActive as isPervyyVystrelObservabilityActiveCfg,
  PERVYY_VYSTREL_POSITION_SOURCE,
  type PervyyVystrelConfig,
} from './live-oscar-pervyy-vystrel-config.js';
import type { Lane, SnapshotCandidateRow } from './types.js';
import { appendDiscoveryHardMcapReasons, type DiscoveryRefMcap } from './filters/snapshot-filter.js';

export { PERVYY_VYSTREL_POSITION_SOURCE };

export function isPervyyVystrelObservabilityActive(cfg: PaperTraderConfig): boolean {
  return isPervyyVystrelObservabilityActiveCfg(cfg.strategyId, cfg.pervyyVystrel);
}

export function isPervyyVystrelTradingActive(cfg: PaperTraderConfig): boolean {
  return isPervyyVystrelLaneEnabled(cfg.strategyId, cfg.pervyyVystrel);
}

export function pervyyVystrelDiscoveryPrefilter(
  cfg: PaperTraderConfig,
  refMcapUsd: number,
  ageMin: number,
): boolean {
  if (!isPervyyVystrelObservabilityActive(cfg)) return false;
  const pv = cfg.pervyyVystrel;
  const mcap = Number(refMcapUsd);
  const age = Number(ageMin);
  if (!Number.isFinite(mcap) || mcap <= 0) return false;
  if (!Number.isFinite(age)) return false;
  if (age + 1e-9 < pv.minAgeMin || age - 1e-9 > pv.maxAgeMin) return false;
  if (mcap + 1e-9 < pv.anchorMinMcapUsd) return false;
  if (mcap > pv.entryMaxMcapUsd + 1e-9) return false;
  return true;
}

/** Eval cfg slice: lane anchor floor, not prod $2M (runner_lite pattern). */
export function pervyyVystrelEntryConfig(cfg: PaperTraderConfig): PaperTraderConfig {
  const pv = cfg.pervyyVystrel;
  return {
    ...cfg,
    discoveryMinMarketCapUsd: pv.anchorMinMcapUsd,
    globalMinTokenAgeMin: pv.minAgeMin,
    vol1hMinUsd: pv.minVol1hUsd,
  };
}

export type PervyyVystrelDiscoveryPhase =
  | 'phase0'
  | 'phase_a'
  | 'phase_b'
  | 'phase_c'
  | 'phase_d'
  | 'out_of_band';

export interface PervyyVystrelVolAuthShadow {
  washScore: number | null;
  organicScore: number | null;
  pass: boolean;
  insufficientData: boolean;
}

export interface PervyyVystrelOrganicFlowShadow {
  uniqueBuyers1h: number | null;
  clusterBuyerRatio: number | null;
  unclusteredBuyers: number | null;
  pass: boolean;
}

export interface PervyyVystrelClusterDumpShadow {
  clusterSellRatio: number | null;
  clusterUniqueSellers: number | null;
  pass: boolean;
}

export interface PervyyVystrelShadowAnalyzers {
  phase: PervyyVystrelDiscoveryPhase;
  volAuth: PervyyVystrelVolAuthShadow | null;
  organicFlow: PervyyVystrelOrganicFlowShadow | null;
  clusterDump: PervyyVystrelClusterDumpShadow | null;
  journalEvents: PervyyVystrelShadowJournalEvent[];
}

export type PervyyVystrelShadowJournalEvent =
  | {
      kind: 'pervyy_vystrel_vol_auth_snapshot';
      mint: string;
      wash_score: number;
      organic_score: number;
      round_trip_share?: number | null;
      cycle_share?: number | null;
      net_new_share?: number | null;
      pass: boolean;
    }
  | {
      kind: 'pervyy_vystrel_organic_flow_shadow';
      mint: string;
      unique_buyers_1h: number;
      cluster_buyer_ratio: number | null;
      unclustered_buyers: number;
      pass: boolean;
    }
  | {
      kind: 'pervyy_vystrel_cluster_dump_shadow';
      mint: string;
      cluster_sell_ratio: number | null;
      cluster_unique_sellers: number;
      pass: boolean;
    }
  | {
      kind: 'pervyy_vystrel_phase_c_candidate';
      mint: string;
      cluster_dump_completed: boolean;
      cluster_sell_ratio: number | null;
      cluster_unique_sellers: number;
      retail_panic_score?: number | null;
      pass: false;
      reasons: string[];
    }
  | {
      kind: 'pervyy_vystrel_phase_d_candidate';
      mint: string;
      cluster_dump_completed: boolean;
      fresh_retail_absorption: boolean;
      reramp_confirmation: boolean;
      organic_score?: number | null;
      unique_buyers_1h?: number | null;
      unclustered_buyers?: number | null;
      wash_score?: number | null;
      pass: false;
      would_enter: false;
      reasons: string[];
    }
  | {
      kind: 'pervyy_vystrel_vol_auth_insufficient_data';
      mint: string;
      swap_count: number;
    }
  | {
      kind: 'pervyy_vystrel_phase_d_missing_materialized_snapshot';
      mint: string;
      materialize_enabled: boolean;
      pass: false;
      reasons: string[];
    };

export interface PervyyVystrelDiscoveryEval {
  pass: boolean;
  wouldOnboard: boolean;
  phase: PervyyVystrelDiscoveryPhase;
  reasons: string[];
  shadowMode: boolean;
  shadowAnalyzers?: PervyyVystrelShadowAnalyzers;
}

function anchorBandLabel(pv: PervyyVystrelConfig): string {
  return `${Math.round(pv.anchorMinMcapUsd / 1000)}k-${Math.round(pv.anchorMaxMcapUsd / 1000)}k`;
}

function inferShadowPhase(refMcap: number, pv: PervyyVystrelConfig): PervyyVystrelDiscoveryPhase {
  if (refMcap >= pv.anchorMaxMcapUsd * 1.6) return 'phase_c';
  if (refMcap >= pv.anchorMaxMcapUsd * 1.2) return 'phase_b';
  if (refMcap >= pv.anchorMinMcapUsd) return 'phase_a';
  return 'phase0';
}

function hasMaterializedSnapshot(snap: PervyyVystrelMintMaterialized | null | undefined): boolean {
  return Boolean(snap?.volAuth || snap?.organicFlow || snap?.clusterMap || snap?.clusterDumpShadow);
}

function volAuthShadowFromSnapshot(
  volAuth: VolumeAuthenticitySnapshot | null | undefined,
): PervyyVystrelVolAuthShadow | null {
  if (!volAuth) return null;
  return {
    washScore: volAuth.washScore,
    organicScore: volAuth.organicScore,
    pass: volAuth.authenticPass,
    insufficientData: volAuth.insufficientData,
  };
}

function organicShadowFromSnapshot(
  organic: OrganicFlowSnapshot | null | undefined,
): PervyyVystrelOrganicFlowShadow | null {
  if (!organic) return null;
  return {
    uniqueBuyers1h: organic.uniqueBuyers1h,
    clusterBuyerRatio: organic.clusterBuyerRatio,
    unclusteredBuyers: organic.unclusteredBuyers,
    pass: organic.pass,
  };
}

function clusterDumpShadowFromSnapshot(
  dump: ClusterDumpShadowEval | null | undefined,
): PervyyVystrelClusterDumpShadow | null {
  if (!dump) return null;
  return {
    clusterSellRatio: dump.clusterSellRatio,
    clusterUniqueSellers: dump.clusterUniqueSellers,
    pass: false,
  };
}

/** PR2 — read materialized cache; shadow eval for Phase A/B/C (pass:false for entry until PR3). */
export function evaluatePervyyVystrelShadowAnalyzers(args: {
  cfg: PaperTraderConfig;
  mint: string;
  refMcap: number;
  materialized?: PervyyVystrelMintMaterialized | null;
}): PervyyVystrelShadowAnalyzers {
  const { cfg, mint, refMcap } = args;
  const pv = cfg.pervyyVystrel;
  const materializeEnabled = pv.materializeEnabled || args.materialized !== undefined;
  const snap = materializeEnabled ? (args.materialized ?? readPervyyVystrelMintSnapshot(mint)) : null;
  const journalEvents: PervyyVystrelShadowJournalEvent[] = [];

  const volAuth = volAuthShadowFromSnapshot(snap?.volAuth ?? null);
  const organicFlow = organicShadowFromSnapshot(snap?.organicFlow ?? null);
  const clusterDump = clusterDumpShadowFromSnapshot(snap?.clusterDumpShadow ?? null);
  const hasSnap = hasMaterializedSnapshot(snap);
  const phase: PervyyVystrelDiscoveryPhase = !hasSnap
    ? 'phase0'
    : snap?.clusterDumpShadow?.pass === true && organicFlow?.pass === true && volAuth?.pass === true
      ? 'phase_d'
      : snap?.clusterDumpShadow
        ? 'phase_c'
        : inferShadowPhase(refMcap, pv);

  if (!hasSnap) {
    journalEvents.push({
      kind: 'pervyy_vystrel_phase_d_missing_materialized_snapshot',
      mint,
      materialize_enabled: materializeEnabled,
      pass: false,
      reasons: ['pervyy_vystrel_phase_d_missing_materialized_snapshot'],
    });
  }

  if (pv.volAuthEnabled && snap?.volAuth) {
    const v = snap.volAuth;
    if (v.insufficientData) {
      journalEvents.push({
        kind: 'pervyy_vystrel_vol_auth_insufficient_data',
        mint,
        swap_count: v.signals.swapCount,
      });
    } else {
      journalEvents.push({
        kind: 'pervyy_vystrel_vol_auth_snapshot',
        mint,
        wash_score: v.washScore,
        organic_score: v.organicScore,
        round_trip_share: v.signals.roundTripShare,
        cycle_share: v.signals.cycleShare,
        net_new_share: v.signals.netNewWalletShare,
        pass: false,
      });
    }
  }

  if (pv.organicGateEnabled && snap?.organicFlow) {
    const o = snap.organicFlow;
    journalEvents.push({
      kind: 'pervyy_vystrel_organic_flow_shadow',
      mint,
      unique_buyers_1h: o.uniqueBuyers1h,
      cluster_buyer_ratio: o.clusterBuyerRatio,
      unclustered_buyers: o.unclusteredBuyers,
      pass: false,
    });
  }

  if (pv.clusterDumpMode !== 'off' && phase === 'phase_c' && snap?.clusterDumpShadow) {
    const c = snap.clusterDumpShadow;
    journalEvents.push({
      kind: 'pervyy_vystrel_cluster_dump_shadow',
      mint,
      cluster_sell_ratio: c.clusterSellRatio,
      cluster_unique_sellers: c.clusterUniqueSellers,
      pass: false,
    });
  }

  if (pv.clusterDumpMode !== 'off' && snap?.clusterDumpShadow) {
    const c = snap.clusterDumpShadow;
    journalEvents.push({
      kind: 'pervyy_vystrel_phase_c_candidate',
      mint,
      cluster_dump_completed: c.pass,
      cluster_sell_ratio: c.clusterSellRatio,
      cluster_unique_sellers: c.clusterUniqueSellers,
      retail_panic_score: c.retailPanicScore,
      pass: false,
      reasons: c.pass ? ['pervyy_vystrel_phase_c_cluster_dump_shadow_pass'] : c.reasons,
    });
  }

  if (snap?.clusterDumpShadow?.pass) {
    const freshRetailAbsorption =
      organicFlow?.pass === true && (organicFlow.unclusteredBuyers ?? 0) >= pv.minUnclusteredBuyers1h;
    const volumeAuthentic = volAuth?.pass === true;
    const rerampConfirmation = freshRetailAbsorption && volumeAuthentic;
    const reasons = ['pervyy_vystrel_phase_d_phantom_replay_only'];
    if (!freshRetailAbsorption) reasons.push('pervyy_vystrel_phase_d_missing_fresh_retail_absorption');
    if (!volumeAuthentic) reasons.push('pervyy_vystrel_phase_d_missing_volume_authenticity');
    if (!rerampConfirmation) reasons.push('pervyy_vystrel_phase_d_reramp_unconfirmed');

    journalEvents.push({
      kind: 'pervyy_vystrel_phase_d_candidate',
      mint,
      cluster_dump_completed: true,
      fresh_retail_absorption: freshRetailAbsorption,
      reramp_confirmation: rerampConfirmation,
      organic_score: volAuth?.organicScore ?? null,
      unique_buyers_1h: organicFlow?.uniqueBuyers1h ?? null,
      unclustered_buyers: organicFlow?.unclusteredBuyers ?? null,
      wash_score: volAuth?.washScore ?? null,
      pass: false,
      would_enter: false,
      reasons,
    });
  }

  return { phase, volAuth, organicFlow, clusterDump, journalEvents };
}

/**
 * PR1 shadow eval — Phase 0 watchlist onboard gates only (no phase machine / entry).
 * `pass` stays false until PR3 gate mode; `wouldOnboard` drives journal observability.
 */
export function evaluateLiveOscarPervyyVystrelDiscovery(args: {
  cfg: PaperTraderConfig;
  row: SnapshotCandidateRow;
  lane: Lane;
  refMcap: number;
  ageMin: number;
  discoveryMcap: DiscoveryRefMcap;
  materialized?: PervyyVystrelMintMaterialized | null;
}): PervyyVystrelDiscoveryEval {
  const { cfg, row, refMcap, ageMin, discoveryMcap } = args;
  const pv = cfg.pervyyVystrel;
  const reasons: string[] = [];
  const shadowMode = !isPervyyVystrelTradingActive(cfg);

  if (!isPervyyVystrelObservabilityActive(cfg)) {
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'out_of_band',
      reasons: ['pervyy_vystrel_lane_off'],
      shadowMode: true,
    };
  }

  const hardReasons: string[] = [];
  const hardCfg = pervyyVystrelEntryConfig(cfg);
  appendDiscoveryHardMcapReasons(hardCfg, discoveryMcap, hardReasons);
  if (hardReasons.length > 0) {
    reasons.push(...hardReasons.map((r) => `pervyy_vystrel_${r}`));
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'out_of_band',
      reasons,
      shadowMode,
    };
  }

  if (ageMin + 1e-9 < pv.minAgeMin || ageMin - 1e-9 > pv.maxAgeMin) {
    reasons.push(`pervyy_vystrel_age_outside_${pv.minAgeMin}_${pv.maxAgeMin}`);
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'out_of_band',
      reasons,
      shadowMode,
    };
  }

  if (refMcap + 1e-9 < pv.anchorMinMcapUsd) {
    reasons.push(`pervyy_vystrel_mcap_below_anchor_${pv.anchorMinMcapUsd}`);
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'out_of_band',
      reasons,
      shadowMode,
    };
  }

  if (refMcap > pv.anchorMaxMcapUsd + 1e-9 && refMcap > pv.entryMaxMcapUsd + 1e-9) {
    reasons.push(`pervyy_vystrel_mcap_above_entry_max_${pv.entryMaxMcapUsd}`);
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'out_of_band',
      reasons,
      shadowMode,
    };
  }

  const vol1h = Number(row.volume_1h ?? 0);
  if (!Number.isFinite(vol1h) || vol1h + 1e-9 < pv.minVol1hUsd) {
    reasons.push(`pervyy_vystrel_vol1h<${pv.minVol1hUsd}`);
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'phase0',
      reasons,
      shadowMode,
    };
  }

  const shadowAnalyzers = evaluatePervyyVystrelShadowAnalyzers({
    cfg,
    mint: row.mint,
    refMcap,
    materialized: args.materialized,
  });

  const inAnchorBand =
    refMcap + 1e-9 >= pv.anchorMinMcapUsd && refMcap <= pv.anchorMaxMcapUsd + 1e-9;
  const hasPhaseShadowEvents = shadowAnalyzers.journalEvents.some(
    (ev) => ev.kind === 'pervyy_vystrel_phase_c_candidate' || ev.kind === 'pervyy_vystrel_phase_d_candidate',
  );
  if (!inAnchorBand && !hasPhaseShadowEvents) {
    reasons.push(`pervyy_vystrel_mcap_outside_anchor_${anchorBandLabel(pv)}`);
    return {
      pass: false,
      wouldOnboard: false,
      phase: shadowAnalyzers.phase,
      reasons,
      shadowMode,
      shadowAnalyzers,
    };
  }

  if (inAnchorBand) reasons.push('pervyy_vystrel_phase0_would_onboard');
  if (!inAnchorBand && hasPhaseShadowEvents) reasons.push('pervyy_vystrel_phase_d_phantom_replay_only');
  if (shadowMode) reasons.push('pervyy_vystrel_shadow_no_entry_pr3');

  if (shadowAnalyzers.volAuth && !shadowAnalyzers.volAuth.pass && pv.volAuthEnabled) {
    reasons.push('pervyy_vystrel_vol_auth_shadow_fail');
  }
  if (shadowAnalyzers.organicFlow && !shadowAnalyzers.organicFlow.pass && pv.organicGateEnabled) {
    reasons.push('pervyy_vystrel_organic_flow_shadow_fail');
  }

  return {
    pass: false,
    wouldOnboard: inAnchorBand,
    phase: shadowAnalyzers.phase,
    reasons,
    shadowMode,
    shadowAnalyzers,
  };
}
