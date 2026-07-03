import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import {
  isRunnerLiteTrade,
  normalizeRunnerLiteOpenMapKeys,
  stampRunnerLiteOnOpen,
} from '../live-oscar-runner-lite.js';
import { isLiveOscarTradingStrategyId } from '../../preset-c/live-oscar-family.js';
import { applyWaveBGridOverrides } from './exit-policy-wave-b.js';

export function isRunnerLiteExitPolicy(ot: OpenTrade): boolean {
  return ot.liveExitPolicyId === 'runner_lite_v1' || isRunnerLiteTrade(ot);
}

/** Max notional per runner_lite open — 2×$100, no DCA. */
export function runnerLiteMaxPositionUsd(cfg: PaperTraderConfig): number {
  return cfg.runnerLitePositionUsd;
}

export function finalizeRunnerLiteOpenOnBoot(
  open: Map<string, OpenTrade>,
  cfg: PaperTraderConfig,
): number {
  const migrated = normalizeRunnerLiteOpenMapKeys(open);
  for (const ot of open.values()) {
    stampRunnerLiteExitPolicyOnOpen(ot, cfg);
  }
  return migrated;
}

/**
 * runner_lite exit: wave_b_v1 + half8_runner (+8% sell 50%, kill −50%, prod trail machinery).
 */
export function stampRunnerLiteExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !isRunnerLiteTrade(ot)) return false;
  stampRunnerLiteOnOpen(ot);
  ot.liveExitPolicyId = 'runner_lite_v1';
  ot.liveWaveFlatTpMode = 'half8_runner';
  applyWaveBGridOverrides(ot);
  return true;
}
