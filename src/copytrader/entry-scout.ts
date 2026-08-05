/**
 * Scout entry tier: when selective copy gates (vol/mcap/liq/flow) reject a
 * leader buy, still follow at a small fixed clip so we observe the full flow.
 *
 * Hard gates (pair age, leader-prior, max-open, shadow live filter, premium)
 * still block. **0** `entryScoutUsd` = off.
 */
import type { CopyTraderConfig } from './config.js';
import { clampEntryUsd, roundUsd } from './entry-probe.js';

/** Reasons that may be bypassed by the scout tier (everything else stays hard). */
export function isScoutBypassableGateReason(reason: string): boolean {
  if (!reason) return false;
  if (reason === 'no_entry_context') return true;
  if (reason === 'volume_5m_unknown') return true;
  if (reason.startsWith('volume_5m_usd=')) return true;
  if (reason === 'buy_sell_ratio_unknown') return true;
  if (reason.startsWith('buy_sell_5m=')) return true;
  if (reason === 'price_change_5m_unknown') return true;
  if (reason.startsWith('chase_5m_pct=')) return true;
  if (reason === 'turnover_5m_unknown') return true;
  if (reason.startsWith('turnover_5m=')) return true;
  if (reason === 'vol_to_mcap_1h_unknown') return true;
  if (reason.startsWith('vol_to_mcap_1h=')) return true;
  if (reason.startsWith('mcap_missing')) return true;
  if (reason.startsWith('mcap=') && reason.includes('<min=')) return true;
  if (reason.startsWith('liq_missing')) return true;
  if (reason.startsWith('liq=') && reason.includes('<min=')) return true;
  if (reason.startsWith('liquidity=') && reason.includes('<min=')) return true;
  return false;
}

export function scoutEntryEnabled(cfg: Pick<CopyTraderConfig, 'entryScoutUsd'>): boolean {
  return cfg.entryScoutUsd > 0;
}

export function scoutEntrySizeUsd(cfg: Pick<CopyTraderConfig, 'entryScoutUsd' | 'maxPositionUsd'>): number {
  if (!(cfg.entryScoutUsd > 0)) return 0;
  return clampEntryUsd(cfg, roundUsd(cfg.entryScoutUsd));
}

/**
 * True when every failing reason is scout-bypassable (and scout is enabled).
 * Empty reasons → not a fallback case (caller should use the normal tier).
 */
export function canUseScoutEntryFallback(
  cfg: Pick<CopyTraderConfig, 'entryScoutUsd' | 'maxPositionUsd'>,
  reasons: string[],
): boolean {
  if (!scoutEntryEnabled(cfg)) return false;
  if (!(scoutEntrySizeUsd(cfg) > 0)) return false;
  if (!reasons.length) return false;
  return reasons.every(isScoutBypassableGateReason);
}
