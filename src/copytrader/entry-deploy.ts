import type { CopyTraderConfig } from './config.js';
import {
  entryDipSizeUsd,
  entryProbeSizeUsd,
  usesDipOnlyEntry,
  usesSplitEntryProbe,
} from './entry-probe.js';
import type { CopyPosition, CopyTraderState } from './state.js';

/** Split or dip-only entry must reach target size before proportional adds. */
export function entryRequiresStagedDeploy(cfg: CopyTraderConfig): boolean {
  return usesSplitEntryProbe(cfg) || usesDipOnlyEntry(cfg);
}

export function entryTargetDeployUsd(cfg: CopyTraderConfig): number {
  return cfg.positionUsd;
}

export function entryMinDeployUsd(cfg: CopyTraderConfig): number {
  return cfg.positionUsd * cfg.entryMinDeployFraction;
}

/** True when staged entry is complete (probe+dip or full dip) or single-shot entry is open. */
export function isEntryFullyDeployed(cfg: CopyTraderConfig, deployedUsd: number): boolean {
  if (!(deployedUsd > 0)) return false;
  if (!entryRequiresStagedDeploy(cfg)) return true;
  return deployedUsd >= entryMinDeployUsd(cfg);
}

/** Planned USD for a complete staged entry (probe+dip or dip-only). */
export function stagedEntryTargetCostUsd(cfg: CopyTraderConfig): number {
  if (usesDipOnlyEntry(cfg)) return entryDipSizeUsd(cfg);
  if (usesSplitEntryProbe(cfg)) return entryProbeSizeUsd(cfg) + entryDipSizeUsd(cfg);
  return cfg.positionUsd;
}

function hasPendingEntryDip(state: CopyTraderState, mint: string): boolean {
  return state.pendingBuys.some((p) => p.mint === mint && p.kind === 'entry' && p.entryLeg === 'dip');
}

/**
 * Entry deploy progress in USD — cost basis of filled entry legs, not mark-to-market.
 * Legacy positions without entryDeployedCostUsd are inferred from pending dip + config sizing.
 */
export function resolveEntryDeployedCostUsd(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  pos: CopyPosition,
): number {
  if ((pos.entryDeployedCostUsd ?? 0) > 0) return pos.entryDeployedCostUsd!;

  if (!entryRequiresStagedDeploy(cfg)) {
    return pos.sizeUsd > 0 ? pos.sizeUsd : 0;
  }

  if (pos.entryDipAbandoned) {
    return entryProbeSizeUsd(cfg);
  }

  if (hasPendingEntryDip(state, pos.mint)) {
    return entryProbeSizeUsd(cfg);
  }

  if (usesDipOnlyEntry(cfg)) {
    return entryDipSizeUsd(cfg);
  }

  return stagedEntryTargetCostUsd(cfg);
}

/** Leader exit before full staged entry — abandon remaining dip leg (e.g. 75%). */
export function shouldAbandonEntryDipOnLeaderSell(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  pos: CopyPosition,
): boolean {
  const deployed = resolveEntryDeployedCostUsd(cfg, state, pos);
  return entryRequiresStagedDeploy(cfg) && deployed > 0 && !isEntryFullyDeployed(cfg, deployed);
}
