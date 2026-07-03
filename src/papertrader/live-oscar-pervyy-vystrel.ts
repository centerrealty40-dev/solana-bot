import type { PaperTraderConfig } from './config.js';
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

export type PervyyVystrelDiscoveryPhase = 'phase0' | 'out_of_band';

export interface PervyyVystrelDiscoveryEval {
  pass: boolean;
  wouldOnboard: boolean;
  phase: PervyyVystrelDiscoveryPhase;
  reasons: string[];
  shadowMode: boolean;
}

function anchorBandLabel(pv: PervyyVystrelConfig): string {
  return `${Math.round(pv.anchorMinMcapUsd / 1000)}k-${Math.round(pv.anchorMaxMcapUsd / 1000)}k`;
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

  const inAnchorBand =
    refMcap + 1e-9 >= pv.anchorMinMcapUsd && refMcap <= pv.anchorMaxMcapUsd + 1e-9;
  if (!inAnchorBand) {
    reasons.push(`pervyy_vystrel_mcap_outside_anchor_${anchorBandLabel(pv)}`);
    return {
      pass: false,
      wouldOnboard: false,
      phase: 'phase0',
      reasons,
      shadowMode,
    };
  }

  reasons.push('pervyy_vystrel_phase0_would_onboard');
  if (shadowMode) reasons.push('pervyy_vystrel_shadow_no_entry_pr3');

  return {
    pass: false,
    wouldOnboard: true,
    phase: 'phase0',
    reasons,
    shadowMode,
  };
}
