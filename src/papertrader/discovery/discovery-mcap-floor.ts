import type { PaperTraderConfig } from '../config.js';
import { isPervyyVystrelObservabilityActive } from '../live-oscar-pervyy-vystrel-config.js';
import { isRunnerLiteLaneEnabled } from '../live-oscar-runner-lite.js';
import { isRunnerProbeLaneEnabled } from '../live-oscar-runner-probe.js';

/**
 * Widest SQL / micro-lane discovery mcap floor when parallel runner / pervyy lanes are active.
 * Prod `PAPER_DISCOVERY_MIN_MARKET_CAP_USD` ($2M) must not hide $100k–$800k mints from the pool.
 */
export function resolveDiscoverySqlMinMarketCapUsd(cfg: PaperTraderConfig): number {
  const prodMin = cfg.discoveryMinMarketCapUsd ?? 0;
  const microFloors: number[] = [];
  if (isPervyyVystrelObservabilityActive(cfg.strategyId, cfg.pervyyVystrel)) {
    microFloors.push(cfg.pervyyVystrel.anchorMinMcapUsd);
  }
  if (isRunnerLiteLaneEnabled(cfg)) {
    microFloors.push(cfg.runnerLiteMinMcapUsd);
  }
  if (isRunnerProbeLaneEnabled(cfg)) {
    microFloors.push(cfg.runnerProbeMinMcapUsd);
  }
  if (microFloors.length === 0) return prodMin;
  const widened = Math.min(...microFloors);
  if (prodMin <= 0) return widened;
  return Math.min(prodMin, widened);
}

/** Hard eval floor for volume-leader / micro-lane candidates (not prod $2M). */
export function resolveDiscoveryHardMcapMinUsd(
  cfg: PaperTraderConfig,
  opts?: { volumeLeader?: boolean; microLaneCandidate?: boolean },
): number {
  if (opts?.volumeLeader || opts?.microLaneCandidate) {
    return resolveDiscoverySqlMinMarketCapUsd(cfg);
  }
  return cfg.discoveryMinMarketCapUsd ?? 0;
}
