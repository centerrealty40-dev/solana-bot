export type MildDipPairAgeEntry = {
  pairCreatedAtMs: number;
  lastSeenAtMs: number;
};

export type MildDipPairAgeRegistryState = Record<string, MildDipPairAgeEntry>;

const HOURS_MS = 3_600_000;

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class MildDipPairAgeRegistry {
  private readonly entries = new Map<string, MildDipPairAgeEntry>();

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
    const limit = Math.max(0, Math.floor(maxEntries));
    if (this.entries.size <= limit) return;
    const keep = [...this.entries.entries()]
      .sort((a, b) => b[1].lastSeenAtMs - a[1].lastSeenAtMs)
      .slice(0, limit);
    this.entries.clear();
    for (const [mint, entry] of keep) this.entries.set(mint, entry);
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
  }

  size(): number {
    return this.entries.size;
  }
}

export const mildDipPairAgeRegistry = new MildDipPairAgeRegistry();
