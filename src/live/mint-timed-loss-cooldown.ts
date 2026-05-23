/**
 * Live Oscar — 24h mint block after timed loss exit (Variant A salvage24 / h48_loss).
 * One rule: no re-entry on the same mint until cooldown expires (not permanent denylist).
 */
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { VariantAExitTag } from '../papertrader/executor/exit-policy-variant-a.js';
import { isVariantATimedLossExitTag } from '../papertrader/executor/exit-policy-variant-a.js';

const log = child('mint-timed-loss-cooldown');

const cooldownUntilMsByMint = new Map<string, number>();

let cfgRef: LiveOscarConfig | null = null;

export function configureMintTimedLossCooldown(liveCfg: LiveOscarConfig): void {
  cfgRef = liveCfg;
}

export function recordMintTimedLossCooldown(mint: string, tag: VariantAExitTag | undefined): void {
  const cfg = cfgRef;
  if (!cfg?.liveMintTimedLossCooldownEnabled) return;
  if (!isVariantATimedLossExitTag(tag)) return;
  const ms = cfg.liveMintTimedLossCooldownMs;
  if (!(ms > 0)) return;
  const key = mint.trim();
  if (!key) return;
  const until = Date.now() + ms;
  cooldownUntilMsByMint.set(key, until);
  appendLiveJsonlEvent({
    kind: 'risk_note',
    reason: 'live_mint_timed_loss_cooldown',
    detail: { mint: key, exitTag: tag, cooldownMs: ms, cooldownUntilMs: until },
  });
  log.info(
    { mint: key.slice(0, 12), tag, cooldownMs: ms, until: new Date(until).toISOString() },
    'mint timed-loss cooldown armed',
  );
}

export function isMintTimedLossCooldownActive(liveCfg: LiveOscarConfig, mint: string): boolean {
  if (!liveCfg.liveMintTimedLossCooldownEnabled) return false;
  const key = mint.trim();
  if (!key) return false;
  const until = cooldownUntilMsByMint.get(key);
  if (until == null) return false;
  if (until <= Date.now()) {
    cooldownUntilMsByMint.delete(key);
    return false;
  }
  return true;
}

export function mintTimedLossCooldownRemainingMs(mint: string): number {
  const until = cooldownUntilMsByMint.get(mint.trim());
  if (until == null || until <= Date.now()) return 0;
  return until - Date.now();
}

/** Test helper — reset in-memory map. */
export function resetMintTimedLossCooldownForTests(): void {
  cooldownUntilMsByMint.clear();
}
