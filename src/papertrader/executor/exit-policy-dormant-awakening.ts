/**
 * Volume Awakening live exit (`dormant_awakening_v1`) — isolated lane on live-lera / catcher.
 *
 * Single-shot entry (no DCA):
 *   - hard kill −15% from avg entry,
 *   - every +30% PnL → sell 30% of remainder (repeating grid step),
 *   - remainder: instant peak trail (arm ~+0.5%, drop 6% from peak on reversal).
 */
import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { resolveLiveOscarTradeLaneFromOpen } from '../live-oscar-scalp-wave.js';
import { isLiveOscarFamilyTradingStrategyId } from '../../preset-c/live-oscar-family.js';
import {
  isDormantAwakeningTrade,
  normalizeDormantAwakeningOpenMapKeys,
  stampDormantAwakeningOnOpen,
} from '../live-oscar-dormant-awakening.js';

export const DORMANT_AWAKENING_TP_GAIN = 0.3;
export const DORMANT_AWAKENING_TP_SELL_FRAC = 0.3;
export const DORMANT_AWAKENING_KILL_PCT = 0.15;
export const DORMANT_AWAKENING_TRAIL_ARM_GAIN = 0.005;
export const DORMANT_AWAKENING_TRAIL_DROP = 0.06;

export function isDormantAwakeningExitPolicy(ot: OpenTrade): boolean {
  return (
    ot.liveExitPolicyId === 'dormant_awakening_v1' ||
    resolveLiveOscarTradeLaneFromOpen(ot) === 'dormant_awakening'
  );
}

export function stampDormantAwakeningExitPolicyOnOpen(ot: OpenTrade, cfg: PaperTraderConfig): boolean {
  if (!isLiveOscarFamilyTradingStrategyId(cfg.strategyId)) return false;
  if (!isDormantAwakeningTrade(ot)) return false;
  stampDormantAwakeningOnOpen(ot);
  ot.liveExitPolicyId = 'dormant_awakening_v1';
  ot.tpGridOverrides = {
    ...ot.tpGridOverrides,
    gridStepPnl: DORMANT_AWAKENING_TP_GAIN,
    gridSellFractionByStep: [DORMANT_AWAKENING_TP_SELL_FRAC],
    dcaKillstop: -Math.abs(DORMANT_AWAKENING_KILL_PCT),
  };
  return true;
}

export function dormantAwakeningEffectiveExitParams(_cfg: PaperTraderConfig): Pick<
  PaperTraderConfig,
  | 'tpX'
  | 'dcaKillstop'
  | 'timeoutHours'
  | 'tpGridStepPnl'
  | 'tpGridSellFractionByStep'
  | 'trailMode'
  | 'trailTriggerX'
  | 'trailDrop'
  | 'slX'
> {
  return {
    tpX: 1 + DORMANT_AWAKENING_TP_GAIN,
    dcaKillstop: -Math.abs(DORMANT_AWAKENING_KILL_PCT),
    timeoutHours: 0,
    tpGridStepPnl: DORMANT_AWAKENING_TP_GAIN,
    tpGridSellFractionByStep: [DORMANT_AWAKENING_TP_SELL_FRAC],
    trailMode: 'peak',
    trailTriggerX: 1 + DORMANT_AWAKENING_TRAIL_ARM_GAIN,
    trailDrop: DORMANT_AWAKENING_TRAIL_DROP,
    slX: 0,
  };
}

export function finalizeDormantAwakeningOpenOnBoot(
  open: Map<string, OpenTrade>,
  cfg: PaperTraderConfig,
): number {
  const migrated = normalizeDormantAwakeningOpenMapKeys(open);
  for (const ot of open.values()) {
    stampDormantAwakeningExitPolicyOnOpen(ot, cfg);
  }
  return migrated;
}
