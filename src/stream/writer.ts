import { count, gte } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';

export type StreamEventRow = {
  signature: string;
  slot: number;
  programId: string;
  kind: string;
  err: unknown | null;
  logCount: number;
  payload: Record<string, unknown>;
  observedSlot: number | null;
};

export const streamMetrics = {
  received_total: 0,
  inserted_total: 0,
  flush_failures_total: 0,
  last_event_at: null as Date | null,
  last_flush_at: null as Date | null,
  last_flush_inserted: 0,
};

export class StreamWriter {
  private pending: StreamEventRow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(
    private readonly batchSize: number,
    private readonly batchMs: number,
  ) {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.batchMs);
  }

  enqueue(row: StreamEventRow): void {
    streamMetrics.received_total += 1;
    streamMetrics.last_event_at = new Date();
    this.pending.push(row);
    if (this.pending.length >= this.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<number> {
    if (this.flushing || this.pending.length === 0) return 0;
    this.flushing = true;
    const batch = this.pending.splice(0, this.pending.length);
    streamMetrics.last_flush_at = new Date();
    try {
      const q = await db
        .insert(schema.streamEvents)
        .values(
          batch.map((r) => ({
            signature: r.signature,
            slot: r.slot,
            programId: r.programId,
            kind: r.kind,
            err: r.err,
            logCount: r.logCount,
            payload: r.payload,
            observedSlot: r.observedSlot,
          })),
        )
        .onConflictDoNothing({
          target: [schema.streamEvents.signature, schema.streamEvents.programId],
        })
        .returning({ id: schema.streamEvents.id });
      const inserted = q.length;
      streamMetrics.inserted_total += inserted;
      streamMetrics.last_flush_inserted = inserted;
      return inserted;
    } catch (e) {
      streamMetrics.flush_failures_total += 1;
      this.pending.unshift(...batch);
      throw e;
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.pending.length > 0) {
      await this.flush();
    }
  }
}

/** Rolling window count for health / logs (cheap aggregate). */
export async function countStreamEventsLastMinutes(minutes: number): Promise<number> {
  const since = new Date(Date.now() - minutes * 60_000);
  const [row] = await db
    .select({ c: count() })
    .from(schema.streamEvents)
    .where(gte(schema.streamEvents.receivedAt, since));
  return Number(row?.c ?? 0);
}
