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

export class LeaderSellFeed {
  private offset = 0;
  private pending = '';
  private started = false;

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
        return parseLeaderSellLines(rows, nowMs, this.options);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }
}
