import type { PaperTraderConfig } from '../config.js';

/**
 * @param skipHolderCheck — set to true when holders threshold is enforced by a separate
 * live-resolver step (W7.6). In that case globalGate must not block on stale DB value.
 */
export function globalGate(
  cfg: PaperTraderConfig,
  tokenAgeMin?: number | null,
  holderCount?: number | null,
  opts: { skipHolderCheck?: boolean } = {},
): string[] {
  const reasons: string[] = [];
  const age = Number(tokenAgeMin ?? 0);
  const holders = Number(holderCount ?? 0);
  if (cfg.globalMinTokenAgeMin > 0 && age < cfg.globalMinTokenAgeMin) {
    reasons.push(`token_age<${cfg.globalMinTokenAgeMin}m`);
  }
  if (!opts.skipHolderCheck && cfg.globalMinHolderCount > 0 && holders < cfg.globalMinHolderCount) {
    reasons.push(`holders<${cfg.globalMinHolderCount}`);
  }
  return reasons;
}
