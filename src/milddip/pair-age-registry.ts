export type MildDipPairAgeEntry = {
  pairCreatedAtMs: number;
  lastSeenAtMs: number;
};

export type MildDipPairAgeRegistryState = Record<string, MildDipPairAgeEntry>;
export type MildDipPairAgeAttemptState = Record<string, number>;

const HOURS_MS = 3_600_000;

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class MildDipPairAgeRegistry {
  private readonly entries = new Map<string, MildDipPairAgeEntry>();
  private readonly attempts = new Map<string, number>();

  notePairCreatedAt(
    mint: string,
    pairCreatedAtMs: number,
    seenAtMs = Date.now(),
  ): boolean {
    if (
      !mint ||
      !validTimestamp(pairCreatedAtMs) ||
      !validTimestamp(seenAtMs) ||
      pairCreatedAtMs > seenAtMs
    ) {
      return false;
    }
    const previous = this.entries.get(mint);
    if (previous) {
      previous.lastSeenAtMs = Math.max(previous.lastSeenAtMs, seenAtMs);
      return false;
    }
    this.entries.set(mint, { pairCreatedAtMs, lastSeenAtMs: seenAtMs });
    return true;
  }

  notePairAgeHours(
    mint: string,
    ageHours: number,
    seenAtMs = Date.now(),
  ): boolean {
    if (
      typeof ageHours !== 'number' ||
      !Number.isFinite(ageHours) ||
      ageHours < 0 ||
      !validTimestamp(seenAtMs)
    ) {
      return false;
    }
    return this.notePairCreatedAt(
      mint,
      seenAtMs - ageHours * HOURS_MS,
      seenAtMs,
    );
  }

  pairAgeHours(mint: string, nowMs = Date.now()): number | null {
    const entry = this.entries.get(mint);
    if (!entry || !validTimestamp(nowMs) || entry.pairCreatedAtMs > nowMs)
      return null;
    const ageHours = (nowMs - entry.pairCreatedAtMs) / HOURS_MS;
    return Number.isFinite(ageHours) && ageHours >= 0 ? ageHours : null;
  }

  evict(nowMs: number, maxStaleMs: number, maxEntries: number): void {
    for (const [mint, entry] of this.entries) {
      if (nowMs - entry.lastSeenAtMs > maxStaleMs) this.entries.delete(mint);
    }
    for (const [mint, attemptedAtMs] of this.attempts) {
      if (nowMs - attemptedAtMs > maxStaleMs) this.attempts.delete(mint);
    }
    const limit = Math.max(0, Math.floor(maxEntries));
    if (this.entries.size > limit) {
      const keep = [...this.entries.entries()]
        .sort((a, b) => b[1].lastSeenAtMs - a[1].lastSeenAtMs)
        .slice(0, limit);
      this.entries.clear();
      for (const [mint, entry] of keep) this.entries.set(mint, entry);
    }
    if (this.attempts.size > limit) {
      const keep = [...this.attempts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);
      this.attempts.clear();
      for (const [mint, attemptedAtMs] of keep) this.attempts.set(mint, attemptedAtMs);
    }
  }

  toJSON(
    nowMs = Date.now(),
    maxStaleMs = 7 * 24 * 3_600_000,
    maxEntries = 5_000,
  ): MildDipPairAgeRegistryState {
    this.evict(nowMs, maxStaleMs, maxEntries);
    return Object.fromEntries(this.entries);
  }

  loadJSON(
    data: unknown,
    nowMs = Date.now(),
    maxStaleMs = 7 * 24 * 3_600_000,
    maxEntries = 5_000,
  ): number {
    this.entries.clear();
    this.attempts.clear();
    if (!data || typeof data !== 'object') return 0;
    for (const [mint, raw] of Object.entries(data as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const entry = raw as Partial<MildDipPairAgeEntry>;
      if (
        !mint ||
        !validTimestamp(entry.pairCreatedAtMs) ||
        !validTimestamp(entry.lastSeenAtMs) ||
        entry.lastSeenAtMs > nowMs ||
        entry.pairCreatedAtMs > nowMs ||
        entry.pairCreatedAtMs > entry.lastSeenAtMs
      ) {
        continue;
      }
      this.entries.set(mint, {
        pairCreatedAtMs: entry.pairCreatedAtMs,
        lastSeenAtMs: entry.lastSeenAtMs,
      });
    }
    this.evict(nowMs, maxStaleMs, maxEntries);
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.attempts.clear();
  }

  size(): number {
    return this.entries.size;
  }

  notePairAgeAttempt(mint: string, attemptedAtMs = Date.now()): boolean {
    if (!mint || !validTimestamp(attemptedAtMs)) return false;
    this.attempts.set(mint, attemptedAtMs);
    return true;
  }

  canAttemptPairAge(mint: string, nowMs: number, retryMs: number): boolean {
    const lastAttemptMs = this.attempts.get(mint);
    if (!mint || !validTimestamp(nowMs)) return false;
    return !lastAttemptMs || nowMs - lastAttemptMs >= Math.max(0, retryMs);
  }

  attemptsToJSON(
    nowMs = Date.now(),
    maxStaleMs = 7 * 24 * 3_600_000,
    maxEntries = 5_000,
  ): MildDipPairAgeAttemptState {
    this.evict(nowMs, maxStaleMs, maxEntries);
    return Object.fromEntries(this.attempts);
  }

  loadAttemptsJSON(
    data: unknown,
    nowMs = Date.now(),
    maxStaleMs = 7 * 24 * 3_600_000,
    maxEntries = 5_000,
  ): number {
    if (!data || typeof data !== 'object') return 0;
    for (const [mint, raw] of Object.entries(data as Record<string, unknown>)) {
      if (mint && validTimestamp(raw) && raw <= nowMs) this.attempts.set(mint, raw);
    }
    this.evict(nowMs, maxStaleMs, maxEntries);
    return this.attempts.size;
  }
}

export const mildDipPairAgeRegistry = new MildDipPairAgeRegistry();
