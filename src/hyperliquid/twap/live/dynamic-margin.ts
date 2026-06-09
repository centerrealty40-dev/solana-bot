import type { HlAccountMargin } from '../hyperliquid-meta.js';
import { freeMarginUsd, HL_TWAP_MARGIN_RESERVE_USD } from './account-margin.js';
import type { HlTwapLiveConfig } from './config.js';
import type { HlTwapLiveOpen } from './types.js';

export type DynamicMarginInput = Pick<
  HlTwapLiveConfig,
  | 'notionalUsd'
  | 'dynamicMargin'
  | 'marginMaxUsd'
  | 'marginMinUsd'
  | 'dynamicMarginMaxAtOpenCount'
  | 'dynamicMarginMinAtOpenCount'
  | 'dynamicMarginDcaLevelsReserve'
  | 'ladderSlicePct'
  | 'marginReserveUsd'
>;

/** Target entry margin from open count (before free-margin cap). */
export function targetMarginByOpenCount(openCount: number, cfg: DynamicMarginInput): number {
  const maxAt = Math.max(0, cfg.dynamicMarginMaxAtOpenCount);
  const minAt = Math.max(maxAt + 1, cfg.dynamicMarginMinAtOpenCount);
  const maxUsd = Math.max(cfg.notionalUsd, cfg.marginMaxUsd);
  const minUsd = Math.min(cfg.marginMinUsd, maxUsd);

  if (openCount <= maxAt) return maxUsd;
  if (openCount >= minAt) return minUsd;

  const t = (openCount - maxAt) / (minAt - maxAt);
  return maxUsd + t * (minUsd - maxUsd);
}

/** Margin reserved for DCA adds on a new position (USD collateral). */
export function dcaHeadroomUsd(marginUsd: number, cfg: DynamicMarginInput): number {
  const levels = Math.max(0, cfg.dynamicMarginDcaLevelsReserve);
  if (levels <= 0) return 0;
  return levels * marginUsd * (cfg.ladderSlicePct / 100);
}

/** Entry margin for the next live open (USD collateral). */
export function computeOpenMarginUsd(
  account: HlAccountMargin,
  opens: Map<string, HlTwapLiveOpen>,
  cfg: DynamicMarginInput,
): number {
  if (!cfg.dynamicMargin) return cfg.notionalUsd;

  const openCount = opens.size;
  let target = targetMarginByOpenCount(openCount, cfg);
  const free = freeMarginUsd(account, opens);
  const reserve = cfg.marginReserveUsd;

  // Shrink to fit free collateral while keeping DCA headroom.
  const affordable = free - reserve - dcaHeadroomUsd(target, cfg);
  if (affordable < target) {
    target = Math.max(cfg.marginMinUsd, affordable);
  }

  target = Math.min(cfg.marginMaxUsd, Math.max(cfg.marginMinUsd, target));
  return Math.round(target);
}

export function formatDynamicMarginStartup(cfg: DynamicMarginInput): string {
  if (!cfg.dynamicMargin) return 'dynamic_margin=0';
  return (
    `dynamic_margin=1 base=$${cfg.notionalUsd} range=$${cfg.marginMinUsd}-$${cfg.marginMaxUsd}` +
    ` max_at=${cfg.dynamicMarginMaxAtOpenCount} min_at=${cfg.dynamicMarginMinAtOpenCount}` +
    ` dca_reserve_levels=${cfg.dynamicMarginDcaLevelsReserve}`
  );
}

export { HL_TWAP_MARGIN_RESERVE_USD };
