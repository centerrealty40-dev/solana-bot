/** Symmetric diff between two mint lists (order-independent). */
export function mintSetSymmetricDelta(
  prev: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((m) => !prevSet.has(m)),
    removed: prev.filter((m) => !nextSet.has(m)),
  };
}

/** True when exactly one mint was added or removed (in-place filter update candidate). */
export function isSingleMintSetChange(prev: readonly string[], next: readonly string[]): boolean {
  const { added, removed } = mintSetSymmetricDelta(prev, next);
  return added.length + removed.length === 1;
}

/** Sliding-window circuit breaker for rapid reconnect failures. */
export class ShyftStreamCircuitBreaker {
  private readonly failTimestamps: number[] = [];
  openUntilMs = 0;

  constructor(
    private readonly maxFastFails: number,
    private readonly windowMs: number,
    private readonly cooldownMs: number,
  ) {}

  recordFastFail(now = Date.now()): boolean {
    this.prune(now);
    this.failTimestamps.push(now);
    if (this.failTimestamps.length >= this.maxFastFails) {
      this.openUntilMs = now + this.cooldownMs;
      this.failTimestamps.length = 0;
      return true;
    }
    return false;
  }

  isOpen(now = Date.now()): boolean {
    if (now >= this.openUntilMs) return false;
    return true;
  }

  remainingMs(now = Date.now()): number {
    return Math.max(0, this.openUntilMs - now);
  }

  reset(): void {
    this.failTimestamps.length = 0;
    this.openUntilMs = 0;
  }

  private prune(now: number): void {
    const cut = now - this.windowMs;
    while (this.failTimestamps.length > 0 && this.failTimestamps[0]! < cut) {
      this.failTimestamps.shift();
    }
  }
}

export const DEFAULT_STABLE_BEFORE_BACKOFF_RESET_MS = 30_000;
export const DEFAULT_CIRCUIT_FAST_FAILS = 5;
export const DEFAULT_CIRCUIT_FAST_FAIL_WINDOW_MS = 120_000;
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 15 * 60_000;
export const FAST_FAIL_MAX_SESSION_MS = 60_000;
