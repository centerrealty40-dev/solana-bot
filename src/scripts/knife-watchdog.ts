/**
 * Pure self-watchdog decision for the knife-catcher (no stream / native deps → unit-testable).
 *
 * The knife worker has previously leaked to multi-GB RSS and was killed by the *kernel* OOM-killer
 * (pm2 `max_memory_restart` telemetry lags a stalled/thrashing event loop), which endangers every
 * co-tenant on the shared VPS. This forces a clean, early `exit(1)` so pm2 restarts a fresh process
 * long before the box is threatened.
 */

export type KnifeWatchdogReason = 'rss' | 'stall';

export interface KnifeWatchdogInput {
  rssMb: number;
  lastActivityAgeMs: number;
  watchedCount: number;
  rssHardMb: number;
  stallMs: number;
}

export function knifeWatchdogVerdict(
  args: KnifeWatchdogInput,
): { exit: boolean; reason?: KnifeWatchdogReason } {
  if (args.rssHardMb > 0 && args.rssMb >= args.rssHardMb) return { exit: true, reason: 'rss' };
  if (args.stallMs > 0 && args.watchedCount > 0 && args.lastActivityAgeMs >= args.stallMs) {
    return { exit: true, reason: 'stall' };
  }
  return { exit: false };
}
