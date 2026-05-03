/**
 * After `confirm_timeout` with an on-chain signature, the bot may not have written
 * `live_position_open` — block duplicate buy_open / dca_add on the same mint for a short TTL.
 */
const cooldownUntilMs = new Map<string, number>();

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function registerAmbiguousLiveBuyCooldown(mint: string, ttlMs: number = DEFAULT_TTL_MS): void {
  cooldownUntilMs.set(mint, Date.now() + ttlMs);
}

export function clearLiveBuyCooldown(mint: string): void {
  cooldownUntilMs.delete(mint);
}

export function isMintBlockedForAmbiguousLiveBuy(mint: string): boolean {
  const until = cooldownUntilMs.get(mint);
  if (until == null) return false;
  if (Date.now() >= until) {
    cooldownUntilMs.delete(mint);
    return false;
  }
  return true;
}
