/**
 * LIVE_POLICY_ONLY_EXITS — allow Jupiter sells only for kill / trail / TP / breakeven.
 * Hygiene paths (PERIODIC_HEAL force-close, tail sweeps, flash, timeout, capital rotate) are journal-only or blocked.
 */
import type { ExitReason, PartialSell } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';

const POLICY_ALLOWED_FULL_EXITS = new Set<ExitReason>([
  'KILLSTOP',
  'SL',
  'TRAIL',
  'TP',
  'BREAKEVEN_EXIT',
  /** Hard time-stop is a real defensive full exit (must sell on-chain, not journal-only). */
  'TIME_STOP',
  /** Volume-collapse kill-stop is a real defensive full exit (on-chain sell, not journal-only). */
  'VOL_COLLAPSE',
]);

const POLICY_ALLOWED_PARTIAL_SELLS = new Set<PartialSell['reason']>([
  'KILLSTOP',
  'SL',
  'TRAIL',
  'TRAIL_STEP',
  'TP_LADDER',
  'BREAKEVEN_TRIM',
  'WAVE_B_BREAKEVEN_INSURANCE',
  'WAVE_B_PRE_ARM_NO_HALF8_PARTIAL',
  'WAVE_B_DIP10_FIRST_TP5_PARTIAL',
  'WAVE_B_POST_TP1_DERISK',
]);

export function livePolicyOnlyExitsEnabled(liveCfg?: LiveOscarConfig | null): boolean {
  return liveCfg?.livePolicyOnlyExitsEnabled === true;
}

export function isPolicyAllowedFullExitReason(
  reason: ExitReason,
  liveCfg?: LiveOscarConfig | null,
): boolean {
  if (!livePolicyOnlyExitsEnabled(liveCfg)) return true;
  return POLICY_ALLOWED_FULL_EXITS.has(reason);
}

export function isPolicyAllowedPartialSell(
  reason: PartialSell['reason'],
  liveCfg?: LiveOscarConfig | null,
): boolean {
  if (!livePolicyOnlyExitsEnabled(liveCfg)) return true;
  return POLICY_ALLOWED_PARTIAL_SELLS.has(reason);
}

/** Block on-chain heal / sync / tail Jupiter sells (PERIODIC_HEAL force-close, periodic tail sweep, post-close tail). */
export function livePolicyBlocksHealSyncSells(liveCfg?: LiveOscarConfig | null): boolean {
  return livePolicyOnlyExitsEnabled(liveCfg);
}

const postHealChurnUntilByMint = new Map<string, number>();

export function recordPostHealChurnBlock(mint: string, liveCfg: LiveOscarConfig): void {
  const ms = liveCfg.livePolicyPostHealChurnBlockMs;
  if (!(ms > 0)) return;
  postHealChurnUntilByMint.set(mint, Date.now() + ms);
}

export function postHealChurnGateReason(mint: string, liveCfg?: LiveOscarConfig | null): string | null {
  if (!liveCfg || !(liveCfg.livePolicyPostHealChurnBlockMs > 0)) return null;
  const until = postHealChurnUntilByMint.get(mint);
  if (until == null) return null;
  const now = Date.now();
  if (now >= until) {
    postHealChurnUntilByMint.delete(mint);
    return null;
  }
  return `post_heal_churn_block:${Math.ceil((until - now) / 1000)}s`;
}

/** @internal test helper */
export function clearPostHealChurnBlocksForTests(): void {
  postHealChurnUntilByMint.clear();
}
