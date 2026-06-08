import type { CopyTraderConfig } from './config.js';
import { usesDipOnlyEntry, usesSplitEntryProbe } from './entry-probe.js';

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

/** Leader exit before full staged entry — abandon remaining dip leg (e.g. 75%). */
export function shouldAbandonEntryDipOnLeaderSell(cfg: CopyTraderConfig, deployedUsd: number): boolean {
  return entryRequiresStagedDeploy(cfg) && deployedUsd > 0 && !isEntryFullyDeployed(cfg, deployedUsd);
}
