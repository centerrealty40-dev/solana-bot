import type { PaperTraderConfig } from '../config.js';

export function globalGate(
  cfg: PaperTraderConfig,
  tokenAgeMin?: number | null,
  holderCount?: number | null,
): string[] {
  const reasons: string[] = [];
  const age = Number(tokenAgeMin ?? 0);
  const holders = Number(holderCount ?? 0);
  if (cfg.globalMinTokenAgeMin > 0 && age < cfg.globalMinTokenAgeMin) {
    reasons.push(`token_age<${cfg.globalMinTokenAgeMin}m`);
  }
  if (cfg.globalMinHolderCount > 0 && holders < cfg.globalMinHolderCount) {
    reasons.push(`holders<${cfg.globalMinHolderCount}`);
  }
  return reasons;
}
