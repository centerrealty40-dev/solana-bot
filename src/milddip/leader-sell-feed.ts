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
};

export type LeaderSellReconciliationOptions = {
  path: string;
  leaders: readonly string[];
  openMints: ReadonlySet<string>;
  nowMs: number;
  windowMs?: number;
};

export const LEADER_SELL_RECONCILIATION_TAIL_BYTES = 32 * 1024 * 1024;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function eventTimestampMs(row: Record<string, unknown>): number | null {
  const blockTime = finiteNumber(row.blockTime);
  if (blockTime != null && blockTime > 0) return blockTime * 1000;
  const ts = finiteNumber(row.ts);
  return ts != null && ts > 0 ? ts : null;
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
      if (options.maxAgeMs > 0 && nowMs - blockTimeMs > options.maxAgeMs) continue;
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
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, LEADER_SELL_RECONCILIATION_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        const text = buffer.toString('utf8');
        const rows = text.split('\n');
        if (size > length) rows.shift();
        lines.push(...rows.filter(Boolean));
      } finally {
        fs.closeSync(fd);
      }
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

export class LeaderSellFeed {
  private offset = 0;
  private pending = '';
  private started = false;
  private readonly buffer = new Map<string, LeaderSellEvent>();
  private readonly maxBuffered = 256;

  constructor(
    private readonly path: string,
    private readonly options: LeaderSellFeedOptions,
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
