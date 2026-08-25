import fs from 'node:fs';

export type LeaderSellEvent = {
  mint: string;
  leader: string;
  signature: string | null;
  blockTimeMs: number;
  fillPriceUsd: number | null;
  markPnlPct: number | null;
};

export type LeaderSellFeedOptions = {
  leaders: readonly string[];
  maxAgeMs: number;
  stats?: LeaderSellFeedStats;
};

export type LeaderSellFeedStats = {
  staleDropped: number;
};

export type LeaderSellReconciliationOptions = {
  path: string;
  leaders: readonly string[];
  openMints: ReadonlySet<string>;
  nowMs: number;
  windowMs?: number;
  tailBytes?: number;
};

export const LEADER_SELL_RECONCILIATION_TAIL_BYTES = 32 * 1024 * 1024;

export type LeaderBuyReconciliationEvent = {
  mint: string;
  leader: string;
  signature: string | null;
  blockTimeMs: number;
  fillPriceUsd: number | null;
  sizeUsd: number | null;
  lastSeenAtMs: number;
  isAdd: boolean;
};

export type LeaderBuyReconciliationOptions = {
  path: string;
  leaders: readonly string[];
  openMints: ReadonlySet<string>;
  nowMs: number;
  windowMs?: number;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function eventTimestampMs(row: Record<string, unknown>): number | null {
  const blockTime = finiteNumber(row.blockTime);
  if (blockTime != null && blockTime > 0) return blockTime * 1000;
  const ts = finiteNumber(row.ts);
  return ts != null && ts > 0 ? ts : null;
}

export function readTailLines(
  file: string,
  tailBytes = LEADER_SELL_RECONCILIATION_TAIL_BYTES,
): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const rows = buffer.toString('utf8').split('\n');
    if (size > length) rows.shift();
    return rows.filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

export type CrossLeaderBuyEvent = {
  mint: string;
  leader: string;
  signature: string | null;
  blockTimeMs: number;
  fillPriceUsd: number | null;
  sizeUsd: number;
};

export type CrossLeaderAverageSkipReason =
  | 'first_clip_incomplete'
  | 'leader_not_held'
  | 'discount_not_reached'
  | 'limit_reached'
  | 'duplicate_signal'
  | 'cooldown'
  | 'buy_in_flight'
  | 'sell_in_flight'
  | 'size_stop';

const crossLeaderAverageSkipLastJournaled = new Map<
  string,
  { reason: CrossLeaderAverageSkipReason; atMs: number }
>();

export function shouldJournalCrossLeaderAverageSkip(
  mint: string,
  reason: CrossLeaderAverageSkipReason,
  nowMs: number,
): boolean {
  const previous = crossLeaderAverageSkipLastJournaled.get(mint);
  if (
    previous &&
    previous.reason === reason &&
    nowMs - previous.atMs < 5 * 60_000
  ) return false;
  crossLeaderAverageSkipLastJournaled.set(mint, { reason, atMs: nowMs });
  if (crossLeaderAverageSkipLastJournaled.size > 2048) {
    const oldest = crossLeaderAverageSkipLastJournaled.keys().next().value;
    if (typeof oldest === 'string') crossLeaderAverageSkipLastJournaled.delete(oldest);
  }
  return true;
}

export type CrossLeaderBuyFeedOptions = {
  leaders: readonly string[];
  maxAgeMs: number;
  minSizeUsd: number;
};

export function resolveCrossLeaderAverageLeaders(
  configured: readonly string[],
  ownLeaders: readonly string[],
): string[] {
  const own = new Set(ownLeaders);
  return configured.filter((leader) => leader && !own.has(leader));
}

export function crossLeaderAverageDiscountReached(
  markPriceUsd: number,
  entryPriceUsd: number,
  minDiscountPct: number,
): boolean {
  return (
    entryPriceUsd > 0 &&
    markPriceUsd <= entryPriceUsd * (1 - minDiscountPct / 100)
  );
}

export function parseCrossLeaderBuyLines(
  lines: readonly string[],
  nowMs: number,
  options: CrossLeaderBuyFeedOptions,
): CrossLeaderBuyEvent[] {
  const allowed = new Set(options.leaders.map((leader) => leader.trim()).filter(Boolean));
  const result: CrossLeaderBuyEvent[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        row.kind !== 'trade_fill' ||
        row.actor !== 'leader' ||
        row.side !== 'buy' ||
        row.ok !== true
      ) continue;
      const leader = typeof row.wallet === 'string' && allowed.has(row.wallet)
        ? row.wallet
        : '';
      const mint = typeof row.mint === 'string' ? row.mint : '';
      const blockTimeMs = eventTimestampMs(row);
      const sizeUsd = finiteNumber(row.sizeUsdIntent) ?? finiteNumber(row.sizeUsd);
      if (
        !leader ||
        !mint ||
        blockTimeMs == null ||
        sizeUsd == null ||
        sizeUsd < options.minSizeUsd
      ) continue;
      if (options.maxAgeMs > 0 && nowMs - blockTimeMs > options.maxAgeMs) continue;
      result.push({
        mint,
        leader,
        signature: typeof row.signature === 'string' ? row.signature : null,
        blockTimeMs,
        fillPriceUsd: finiteNumber(row.fillPriceUsd),
        sizeUsd,
      });
    } catch {
      // Append-only journals can contain a partial or malformed line.
    }
  }
  return result;
}

export function reconcileCrossLeaderBuyEvents(options: {
  path: string;
  leaders: readonly string[];
  nowMs: number;
  maxAgeMs: number;
  minSizeUsd: number;
}): CrossLeaderBuyEvent[] {
  const lines: string[] = [];
  for (const file of [options.path, `${options.path}.1`]) {
    try {
      lines.push(...readTailLines(file));
    } catch {
      // Journal rotation and absence are expected during startup.
    }
  }
  const events = parseCrossLeaderBuyLines(lines, options.nowMs, {
    leaders: options.leaders,
    maxAgeMs: 0,
    minSizeUsd: options.minSizeUsd,
  });
  const cutoff = options.nowMs - options.maxAgeMs;
  const latest = new Map<string, CrossLeaderBuyEvent>();
  for (const event of events) {
    if (event.blockTimeMs < cutoff) continue;
    const prior = latest.get(event.mint);
    if (!prior || event.blockTimeMs > prior.blockTimeMs) {
      latest.set(event.mint, event);
    }
  }
  return [...latest.values()];
}

export class CrossLeaderBuyFeed {
  private offset = 0;
  private pending = '';
  private started = false;
  private readonly buffer = new Map<string, CrossLeaderBuyEvent>();
  private readonly maxBuffered = 256;

  constructor(
    private readonly path: string,
    private readonly options: CrossLeaderBuyFeedOptions,
  ) {}

  start(): void {
    this.started = true;
    this.pending = '';
    try {
      this.offset = fs.statSync(this.path).size;
    } catch {
      this.offset = 0;
    }
  }

  seed(events: readonly CrossLeaderBuyEvent[]): void {
    for (const event of events) this.buffer.set(event.mint, event);
  }

  read(nowMs: number): CrossLeaderBuyEvent[] {
    if (!this.started) this.start();
    try {
      const size = fs.statSync(this.path).size;
      if (size < this.offset) {
        this.offset = 0;
        this.pending = '';
      }
      if (size === this.offset) {
        this.prune(nowMs);
        return [];
      }
      const fd = fs.openSync(this.path, 'r');
      try {
        const length = size - this.offset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, this.offset);
        this.offset = size;
        const rows = (this.pending + buffer.toString('utf8')).split('\n');
        this.pending = rows.pop() ?? '';
        const events = parseCrossLeaderBuyLines(rows, nowMs, this.options);
        for (const event of events) this.buffer.set(event.mint, event);
        this.prune(nowMs);
        while (this.buffer.size > this.maxBuffered) {
          const oldest = this.buffer.keys().next().value;
          if (typeof oldest !== 'string') break;
          this.buffer.delete(oldest);
        }
        return events;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  get(mint: string, nowMs: number): CrossLeaderBuyEvent | null {
    this.prune(nowMs);
    return this.buffer.get(mint) ?? null;
  }

  private prune(nowMs: number): void {
    if (this.options.maxAgeMs <= 0) return;
    for (const [mint, event] of this.buffer) {
      if (nowMs - event.blockTimeMs > this.options.maxAgeMs) this.buffer.delete(mint);
    }
  }
}

export function parseLeaderSellLines(
  lines: readonly string[],
  nowMs: number,
  options: LeaderSellFeedOptions,
): LeaderSellEvent[] {
  const allowed = new Set(options.leaders.map((leader) => leader.trim()).filter(Boolean));
  const result: LeaderSellEvent[] = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        row.kind !== 'trade_fill' ||
        row.actor !== 'leader' ||
        row.side !== 'sell' ||
        row.ok !== true
      ) {
        continue;
      }
      const wallet = typeof row.wallet === 'string' ? row.wallet : '';
      const leaderField = typeof row.leader === 'string' ? row.leader : '';
      const leader = allowed.has(wallet) ? wallet : allowed.has(leaderField) ? leaderField : '';
      const mint = typeof row.mint === 'string' ? row.mint : '';
      const blockTimeMs = eventTimestampMs(row);
      if (!leader || !mint || blockTimeMs == null || !allowed.has(leader)) continue;
      if (options.maxAgeMs > 0 && nowMs - blockTimeMs > options.maxAgeMs) {
        if (options.stats) options.stats.staleDropped += 1;
        continue;
      }
      result.push({
        mint,
        leader,
        signature: typeof row.signature === 'string' ? row.signature : null,
        blockTimeMs,
        fillPriceUsd: finiteNumber(row.fillPriceUsd),
        markPnlPct: finiteNumber(row.markPnlPct),
      });
    } catch {
      // Append-only journals can contain a partial or malformed line.
    }
  }
  return result;
}

/** Read current and one rotated observer journal without the live-feed age gate. */
export function reconcileLeaderSellEvents(
  options: LeaderSellReconciliationOptions,
): LeaderSellEvent[] {
  const paths = [options.path, `${options.path}.1`];
  const lines: string[] = [];
  for (const file of paths) {
    try {
      lines.push(...readTailLines(file, options.tailBytes));
    } catch {
      // A journal may be absent or rotate between the two reads.
    }
  }
  const events = parseLeaderSellLines(lines, options.nowMs, {
    leaders: options.leaders,
    maxAgeMs: 0,
  });
  const cutoff = options.nowMs - (options.windowMs ?? 6 * 60 * 60_000);
  const latest = new Map<string, LeaderSellEvent>();
  for (const event of events) {
    if (event.blockTimeMs < cutoff || !options.openMints.has(event.mint)) continue;
    const prior = latest.get(event.mint);
    if (prior == null || event.blockTimeMs > prior.blockTimeMs) latest.set(event.mint, event);
  }
  return [...latest.values()];
}

export function reconcileLeaderBuyEvents(
  options: LeaderBuyReconciliationOptions,
): LeaderBuyReconciliationEvent[] {
  const lines: string[] = [];
  for (const file of [options.path, `${options.path}.1`]) {
    try {
      lines.push(...readTailLines(file));
    } catch {
      // The current journal is authoritative; rotation is optional.
    }
  }
  const allowed = new Set(options.leaders);
  const cutoff = options.nowMs - (options.windowMs ?? 6 * 60 * 60_000);
  const buys = new Map<string, LeaderBuyReconciliationEvent>();
  const sells = new Map<string, number>();
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        row.kind !== 'trade_fill' ||
        row.actor !== 'leader' ||
        row.ok !== true
      ) continue;
      const leader =
        typeof row.wallet === 'string' && allowed.has(row.wallet)
          ? row.wallet
          : typeof row.leader === 'string' && allowed.has(row.leader)
            ? row.leader
            : '';
      const mint = typeof row.mint === 'string' ? row.mint : '';
      const blockTimeMs = eventTimestampMs(row);
      if (!leader || !mint || blockTimeMs == null || blockTimeMs < cutoff) continue;
      const key = `${mint}:${leader}`;
      if (row.side === 'sell') {
        sells.set(key, Math.max(sells.get(key) ?? 0, blockTimeMs));
        continue;
      }
      if (row.side !== 'buy') continue;
      if (options.openMints.has(mint)) continue;
      const prior = buys.get(key);
      if (prior && prior.blockTimeMs >= blockTimeMs) continue;
      buys.set(key, {
        mint,
        leader,
        signature: typeof row.signature === 'string' ? row.signature : null,
        blockTimeMs,
        fillPriceUsd: finiteNumber(row.fillPriceUsd),
        sizeUsd: finiteNumber(row.sizeUsdIntent) ?? finiteNumber(row.sizeUsd),
        lastSeenAtMs: blockTimeMs,
        isAdd: row.isAdd === true,
      });
    } catch {
      // Ignore partial or malformed append-only lines.
    }
  }
  return [...buys.values()].filter((event) => {
    const sellTime = sells.get(`${event.mint}:${event.leader}`);
    return sellTime == null || sellTime < event.blockTimeMs;
  });
}

export class LeaderSellFeed {
  private offset = 0;
  private pending = '';
  private started = false;
  private readonly buffer = new Map<string, LeaderSellEvent>();
  private readonly maxBuffered = 256;
  private readonly feedStats: LeaderSellFeedStats;

  constructor(
    private readonly path: string,
    private readonly options: LeaderSellFeedOptions,
  ) {
    this.feedStats = options.stats ?? { staleDropped: 0 };
  }

  stats(): LeaderSellFeedStats {
    return { ...this.feedStats };
  }

  start(): void {
    this.started = true;
    this.pending = '';
    try {
      this.offset = fs.statSync(this.path).size;
    } catch {
      this.offset = 0;
    }
  }

  read(nowMs: number): LeaderSellEvent[] {
    if (!this.started) this.start();
    try {
      const size = fs.statSync(this.path).size;
      if (size < this.offset) {
        this.offset = 0;
        this.pending = '';
      }
      if (size === this.offset) return [];
      const fd = fs.openSync(this.path, 'r');
      try {
        const length = size - this.offset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, this.offset);
        this.offset = size;
        const text = this.pending + buffer.toString('utf8');
        const rows = text.split('\n');
        this.pending = rows.pop() ?? '';
        const events = parseLeaderSellLines(rows, nowMs, this.options);
        for (const event of events) {
          this.buffer.delete(event.mint);
          this.buffer.set(event.mint, event);
        }
        this.prune(nowMs);
        while (this.buffer.size > this.maxBuffered) {
          const oldest = this.buffer.keys().next().value;
          if (typeof oldest !== 'string') break;
          this.buffer.delete(oldest);
        }
        return events;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  get(mint: string, nowMs: number): LeaderSellEvent | null {
    this.prune(nowMs);
    return this.buffer.get(mint) ?? null;
  }

  remove(mint: string): void {
    this.buffer.delete(mint);
  }

  private prune(nowMs: number): void {
    if (this.options.maxAgeMs <= 0) return;
    for (const [mint, event] of this.buffer) {
      if (nowMs - event.blockTimeMs > this.options.maxAgeMs) this.buffer.delete(mint);
    }
  }
}
