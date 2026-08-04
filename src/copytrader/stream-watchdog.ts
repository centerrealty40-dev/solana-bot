/**
 * Leader-stream watchdog: degrade to fast poll + force reconnect when the
 * Helius WS is dead or repeatedly misses sigs that poll finds.
 *
 * Quiet markets alone must NOT force reconnect (notifyCount can stay 0 for hours).
 */

export type LeaderStreamHealthSnapshot = {
  connected: boolean;
  subscribed: boolean;
  mode: string | null;
  lastOpenAtMs: number;
  lastSubscribedAtMs: number;
  lastNotifyAtMs: number;
  lastSignatureAtMs: number;
  notifyCount: number;
  reconnectCount: number;
};

export type StreamWatchdogDecision = {
  healthy: boolean;
  reason:
    | 'ok'
    | 'stream_disabled'
    | 'not_started'
    | 'disconnected'
    | 'not_subscribed'
    | 'poll_miss_streak';
  /** Close WS so the reconnect loop starts a fresh subscription. */
  forceReconnect: boolean;
  /** Use fast poll while unhealthy. */
  useFastPoll: boolean;
  nextMissStreak: number;
};

export function evaluateStreamWatchdog(input: {
  nowMs: number;
  enabled: boolean;
  health: LeaderStreamHealthSnapshot | null;
  /** New leader sigs this poll that were never seen by the stream queue. */
  pollMissesThisCycle: number;
  missStreak: number;
  /** Consecutive poll cycles with ≥1 stream miss before force reconnect. */
  missThreshold: number;
  /** After WS open, how long we tolerate missing `subscribed` before reconnect. */
  subscribeGraceMs?: number;
  /**
   * When false (mid-tick link check), keep missStreak unchanged.
   * Default true — call after each poll.
   */
  updateMissStreak?: boolean;
}): StreamWatchdogDecision {
  if (!input.enabled) {
    return {
      healthy: true,
      reason: 'stream_disabled',
      forceReconnect: false,
      useFastPoll: false,
      nextMissStreak: 0,
    };
  }
  if (!input.health) {
    return {
      healthy: false,
      reason: 'not_started',
      forceReconnect: false,
      useFastPoll: true,
      nextMissStreak: input.missStreak,
    };
  }

  const h = input.health;
  const subscribeGraceMs = input.subscribeGraceMs ?? 15_000;

  if (!h.connected) {
    // Never connected yet (boot) — wait for open; do not kill the handshake.
    const everOpened = h.lastOpenAtMs > 0;
    return {
      healthy: false,
      reason: 'disconnected',
      forceReconnect: everOpened,
      useFastPoll: true,
      nextMissStreak: input.missStreak,
    };
  }
  if (!h.subscribed) {
    const openAge = h.lastOpenAtMs > 0 ? input.nowMs - h.lastOpenAtMs : 0;
    return {
      healthy: false,
      reason: 'not_subscribed',
      forceReconnect: openAge >= subscribeGraceMs,
      useFastPoll: true,
      nextMissStreak: input.missStreak,
    };
  }

  let missStreak = input.missStreak;
  if (input.updateMissStreak !== false) {
    if (input.pollMissesThisCycle > 0) missStreak += 1;
    else missStreak = 0;
  }

  if (missStreak >= Math.max(1, input.missThreshold)) {
    return {
      healthy: false,
      reason: 'poll_miss_streak',
      forceReconnect: true,
      useFastPoll: true,
      nextMissStreak: 0, // reset after we act
    };
  }

  return {
    healthy: true,
    reason: 'ok',
    forceReconnect: false,
    useFastPoll: false,
    nextMissStreak: missStreak,
  };
}
