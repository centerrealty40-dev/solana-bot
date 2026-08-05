/**
 * Leader-stream watchdog: degrade to fast poll + force reconnect when the
 * Helius WS is dead or repeatedly misses sigs that poll finds.
 *
 * Quiet markets alone must NOT force reconnect (notifyCount can stay 0 for hours).
 *
 * IMPORTANT: do not permanently abandon `transactionSubscribe` (paid LaserStream).
 * A short post-subscribe race with poll must not lock the process onto logsSubscribe.
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
  /** True while a temporary logsSubscribe preference window is active. */
  forcingLogsSubscribe?: boolean;
};

export type StreamWatchdogDecision = {
  healthy: boolean;
  reason:
    | 'ok'
    | 'stream_disabled'
    | 'not_started'
    | 'disconnected'
    | 'not_subscribed'
    | 'poll_miss_streak'
    /** Subscribed but zero notifies while poll found a leader swap — dead/racy WS. */
    | 'silent_stream'
    /** Stuck on logsSubscribe fallback — nudge back to transactionSubscribe. */
    | 'retry_transaction_subscribe';
  /** Close WS so the reconnect loop starts a fresh subscription. */
  forceReconnect: boolean;
  /**
   * Prefer logsSubscribe on the next reconnect only briefly.
   * Default false — keep retrying paid transactionSubscribe.
   */
  preferLogsSubscribe?: boolean;
  /** Use fast poll while unhealthy. */
  useFastPoll: boolean;
  nextMissStreak: number;
  nextSilentStreak: number;
};

export function evaluateStreamWatchdog(input: {
  nowMs: number;
  enabled: boolean;
  health: LeaderStreamHealthSnapshot | null;
  /** New leader sigs this poll that were never seen by the stream queue. */
  pollMissesThisCycle: number;
  missStreak: number;
  /** Consecutive poll cycles with ≥1 stream miss before marking unhealthy. */
  missThreshold: number;
  /** Consecutive silent_stream hits (survives across calls). */
  silentStreak?: number;
  /**
   * Only after this many consecutive silent_stream decisions may we briefly
   * prefer logsSubscribe. Default **3**.
   */
  silentPreferLogsAfter?: number;
  /** After WS open, how long we tolerate missing `subscribed` before reconnect. */
  subscribeGraceMs?: number;
  /**
   * Min age after subscribe before a poll miss + zero notifies counts as silent.
   * Default **60s** — short grace caused false silent_stream vs fast poll.
   */
  silentStreamGraceMs?: number;
  /**
   * If stuck on logsSubscribe this long, reconnect and retry transactionSubscribe.
   * Default **120s**. **0** = never auto-retry.
   */
  logsSubscribeRetryMs?: number;
  /**
   * When false (mid-tick link check), keep missStreak unchanged.
   * Default true — call after each poll.
   */
  updateMissStreak?: boolean;
}): StreamWatchdogDecision {
  const silentStreak = input.silentStreak ?? 0;
  if (!input.enabled) {
    return {
      healthy: true,
      reason: 'stream_disabled',
      forceReconnect: false,
      useFastPoll: false,
      nextMissStreak: 0,
      nextSilentStreak: 0,
    };
  }
  if (!input.health) {
    return {
      healthy: false,
      reason: 'not_started',
      forceReconnect: false,
      useFastPoll: true,
      nextMissStreak: input.missStreak,
      nextSilentStreak: silentStreak,
    };
  }

  const h = input.health;
  const subscribeGraceMs = input.subscribeGraceMs ?? 15_000;
  const silentGraceMs = input.silentStreamGraceMs ?? 60_000;
  const silentPreferLogsAfter = Math.max(1, input.silentPreferLogsAfter ?? 3);
  const logsRetryMs = input.logsSubscribeRetryMs ?? 120_000;

  if (!h.connected) {
    // Never connected yet (boot) — wait for open; do not kill the handshake.
    const everOpened = h.lastOpenAtMs > 0;
    return {
      healthy: false,
      reason: 'disconnected',
      forceReconnect: everOpened,
      useFastPoll: true,
      nextMissStreak: input.missStreak,
      nextSilentStreak: silentStreak,
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
      nextSilentStreak: silentStreak,
    };
  }

  let missStreak = input.missStreak;
  if (input.updateMissStreak !== false) {
    if (input.pollMissesThisCycle > 0) missStreak += 1;
    else missStreak = 0;
  }

  /**
   * Am8i RCA: WS reported subscribed with notifyCount=0; poll found the buy.
   * Reconnect and retry transactionSubscribe. Only after repeated silent hits
   * briefly prefer logsSubscribe (timed — not permanent).
   */
  const subscribeAgeMs =
    h.lastSubscribedAtMs > 0 ? input.nowMs - h.lastSubscribedAtMs : 0;
  const neverNotified = h.notifyCount === 0 || h.lastNotifyAtMs === 0;
  if (
    input.pollMissesThisCycle > 0 &&
    neverNotified &&
    subscribeAgeMs >= silentGraceMs
  ) {
    const nextSilent = silentStreak + 1;
    return {
      healthy: false,
      reason: 'silent_stream',
      forceReconnect: true,
      preferLogsSubscribe: nextSilent >= silentPreferLogsAfter,
      useFastPoll: true,
      nextMissStreak: Math.max(missStreak, 1),
      nextSilentStreak: nextSilent,
    };
  }

  /** Clear silent streak once we have real notifies or a clean poll cycle. */
  const nextSilentStreak =
    h.notifyCount > 0 || input.pollMissesThisCycle === 0 ? 0 : silentStreak;

  /**
   * Do not live forever on logsSubscribe fallback — paid LaserStream is
   * transactionSubscribe. Nudge back after the temporary logs window.
   */
  if (
    logsRetryMs > 0 &&
    h.mode === 'logsSubscribe' &&
    !h.forcingLogsSubscribe &&
    h.lastSubscribedAtMs > 0 &&
    input.nowMs - h.lastSubscribedAtMs >= logsRetryMs
  ) {
    return {
      healthy: false,
      reason: 'retry_transaction_subscribe',
      forceReconnect: true,
      preferLogsSubscribe: false,
      useFastPoll: true,
      nextMissStreak: missStreak,
      nextSilentStreak: 0,
    };
  }

  if (missStreak >= Math.max(1, input.missThreshold)) {
    return {
      healthy: false,
      reason: 'poll_miss_streak',
      // Do NOT forceReconnect here — poll also sees non-swap leader txs that
      // tokenAccounts stream correctly ignores; reconnect was self-killing the WS.
      forceReconnect: false,
      useFastPoll: true,
      nextMissStreak: missStreak,
      nextSilentStreak,
    };
  }

  return {
    healthy: true,
    reason: 'ok',
    forceReconnect: false,
    useFastPoll: false,
    nextMissStreak: missStreak,
    nextSilentStreak,
  };
}
