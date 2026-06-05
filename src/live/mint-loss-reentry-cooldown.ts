/**
 * Block re-entry on same mint after loss / flash-crash exits (falling-knife protection).
 */
import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import type { ExitReason } from '../papertrader/types.js';

const log = child('mint-loss-reentry');

type LossRecord = { untilMs: number; reason: string; netPnlUsd: number };

const cooldownUntilByMint = new Map<string, LossRecord>();
const lossTimestampsByMint = new Map<string, number[]>();

let cfgRef: LiveOscarConfig | null = null;

const STRESS_EXIT_REASONS: ReadonlySet<ExitReason> = new Set([
  'FLASH_CRASH_KILL',
  'SL',
  'KILLSTOP',
  'LIQ_DRAIN',
]);

export function configureMintLossReentryCooldown(liveCfg: LiveOscarConfig): void {
  cfgRef = liveCfg;
}

function cfg(): LiveOscarConfig | null {
  return cfgRef;
}

export function isStressExitReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return STRESS_EXIT_REASONS.has(reason as ExitReason);
}

export function recordMintLossReentryCooldown(args: {
  mint: string;
  exitReason?: string;
  netPnlUsd: number;
  exitTsMs: number;
}): void {
  const liveCfg = cfg();
  if (!liveCfg?.liveMintLossReentryCooldownEnabled) return;
  const key = args.mint.trim();
  if (!key || !(args.exitTsMs > 0)) return;

  const isLoss = args.netPnlUsd < 0;
  const isStress = isStressExitReason(args.exitReason);
  if (!isLoss && !isStress) return;

  const baseMs = liveCfg.liveMintLossReentryCooldownMs;
  if (!(baseMs > 0)) return;

  let untilMs = args.exitTsMs + baseMs;
  let tag = isLoss ? 'loss_exit' : 'stress_exit';

  const windowMs = liveCfg.liveMintLossReentryStreakWindowMs;
  const maxStreak = liveCfg.liveMintLossReentryStreakMax;
  if (isLoss && windowMs > 0 && maxStreak >= 2) {
    const prev = (lossTimestampsByMint.get(key) ?? []).filter((t) => args.exitTsMs - t <= windowMs);
    prev.push(args.exitTsMs);
    lossTimestampsByMint.set(key, prev);
    if (prev.length >= maxStreak) {
      const streakMs = liveCfg.liveMintLossReentryStreakCooldownMs;
      if (streakMs > 0) {
        untilMs = Math.max(untilMs, args.exitTsMs + streakMs);
        tag = `loss_streak_${prev.length}`;
      }
    }
  }

  const existing = cooldownUntilByMint.get(key);
  if (existing && existing.untilMs >= untilMs) return;

  cooldownUntilByMint.set(key, { untilMs, reason: tag, netPnlUsd: args.netPnlUsd });
  appendLiveJsonlEvent({
    kind: 'risk_note',
    reason: 'live_mint_loss_reentry_cooldown',
    detail: {
      mint: key,
      tag,
      exitReason: args.exitReason,
      netPnlUsd: args.netPnlUsd,
      cooldownUntilMs: untilMs,
      cooldownMs: untilMs - args.exitTsMs,
    },
  });
  log.info(
    {
      mint: key.slice(0, 12),
      tag,
      exitReason: args.exitReason,
      netPnlUsd: args.netPnlUsd,
      until: new Date(untilMs).toISOString(),
    },
    'mint loss re-entry cooldown armed',
  );
}

export function isMintLossReentryCooldownActive(liveCfg: LiveOscarConfig, mint: string): boolean {
  if (!liveCfg.liveMintLossReentryCooldownEnabled) return false;
  const key = mint.trim();
  if (!key) return false;
  const rec = cooldownUntilByMint.get(key);
  if (!rec) return false;
  if (rec.untilMs <= Date.now()) {
    cooldownUntilByMint.delete(key);
    return false;
  }
  return true;
}

export function mintLossReentryCooldownRemainingMs(mint: string): number {
  const rec = cooldownUntilByMint.get(mint.trim());
  if (!rec || rec.untilMs <= Date.now()) return 0;
  return rec.untilMs - Date.now();
}

export function appendMintLossReentryCooldownReason(mint: string, out: string[]): void {
  const liveCfg = cfg();
  if (!liveCfg || !isMintLossReentryCooldownActive(liveCfg, mint)) return;
  const leftH = mintLossReentryCooldownRemainingMs(mint) / 3_600_000;
  const rec = cooldownUntilByMint.get(mint.trim());
  out.push(`loss_reentry_cooldown_${rec?.reason ?? 'active'}_left_${leftH.toFixed(1)}h`);
}

export function resetMintLossReentryCooldownForTests(): void {
  cooldownUntilByMint.clear();
  lossTimestampsByMint.clear();
}
