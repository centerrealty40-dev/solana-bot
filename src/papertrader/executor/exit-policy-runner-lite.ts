import type { PaperTraderConfig } from '../config.js';
import { parseDcaLevels } from '../config.js';
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

export function runnerLiteDcaLevelsSpec(cfg: PaperTraderConfig): string {
  return cfg.runnerLiteDcaLevelsSpec;
}

/** Max notional per runner_lite open including DCA legs ($200 + ⅓ DCA ≈ $266.67). */
export function runnerLiteMaxPositionUsd(cfg: PaperTraderConfig): number {
  const levels = parseDcaLevels(cfg.runnerLiteDcaLevelsSpec);
  const dcaMult = levels.reduce((sum, l) => sum + l.addFraction, 0);
  return cfg.runnerLitePositionUsd * (1 + dcaMult);
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
 * runner_lite exit: wave_b_v1 + half8_runner (+8% sell 50%, kill −50%, optional −25% DCA +⅓).
 */
export function stampRunnerLiteExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarTradingStrategyId(cfg.strategyId) || !isRunnerLiteTrade(ot)) return false;
  stampRunnerLiteOnOpen(ot);
  ot.liveExitPolicyId = 'runner_lite_v1';
  ot.liveWaveFlatTpMode = 'half8_runner';
  applyWaveBGridOverrides(ot);
  return true;
}
