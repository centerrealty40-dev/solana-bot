import fs from 'node:fs';
import path from 'node:path';
import { and, asc, gt, gte, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../core/db/client.js';
import { extractMintFromStreamPayload } from './awakening-mint-from-logs.js';

export type StreamEventBatchRow = {
  id: bigint;
  signature: string;
  programId: string;
  receivedAt: Date;
  payload: Record<string, unknown>;
};

export type StreamCursor = {
  lastEventId: string;
  updatedAtMs: number;
};

export function loadStreamCursor(cursorPath: string): bigint {
  try {
    const raw = fs.readFileSync(cursorPath, 'utf8');
    const j = JSON.parse(raw) as StreamCursor;
    const id = BigInt(j.lastEventId ?? '0');
    return id > 0n ? id : 0n;
  } catch {
    return 0n;
  }
}

export function saveStreamCursor(cursorPath: string, lastEventId: bigint): void {
  const dir = path.dirname(cursorPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const payload: StreamCursor = {
    lastEventId: lastEventId.toString(),
    updatedAtMs: Date.now(),
  };
  fs.writeFileSync(cursorPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function readAwakeningStreamBatch(opts: {
  programIds: string[];
  afterId: bigint;
  lookbackHours: number;
  limit: number;
}): Promise<StreamEventBatchRow[]> {
  const hours = Math.max(1, Math.floor(opts.lookbackHours));
  const since = sql.raw(`now() - interval '${hours} hours'`);

  const rows = await db
    .select({
      id: schema.streamEvents.id,
      signature: schema.streamEvents.signature,
      programId: schema.streamEvents.programId,
      receivedAt: schema.streamEvents.receivedAt,
      payload: schema.streamEvents.payload,
    })
    .from(schema.streamEvents)
    .where(
      and(
        inArray(schema.streamEvents.programId, opts.programIds),
        gt(schema.streamEvents.id, opts.afterId),
        gte(schema.streamEvents.receivedAt, since),
      ),
    )
    .orderBy(asc(schema.streamEvents.id))
    .limit(opts.limit);

  return rows.map((r) => ({
    id: typeof r.id === 'bigint' ? r.id : BigInt(r.id as unknown as string),
    signature: r.signature,
    programId: r.programId,
    receivedAt: r.receivedAt,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}

export function mintsFromStreamBatch(rows: StreamEventBatchRow[]): string[] {
  const found = new Set<string>();
  for (const row of rows) {
    for (const mint of extractMintFromStreamPayload(row.payload)) {
      found.add(mint);
    }
  }
  return [...found];
}
