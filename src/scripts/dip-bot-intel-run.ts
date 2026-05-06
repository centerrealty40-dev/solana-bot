/**
 * W9.0 — Batch job: Live Oscar `live_position_open` anchors → `swaps` pre-window buyers → `dip_bot_intel_*` + `wallet_tags`.
 *
 * Postgres-first (no billable RPC). Requires `DATABASE_URL` and ingested `swaps` for coverage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from '../core/db/client.js';
import {
  DIP_BOT_TAG_SOURCE,
  extractDipBotJournalAnchors,
  fetchBuyersInWindow,
  loadDipBotEnv,
  markAnchorProcessed,
  promoteWalletsToTags,
  upsertObservation,
} from '../intel/dip-bot-intel.js';

function readTailFromOffset(filePath: string, offset: number): { chunk: string; fileSize: number } {
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const start = Math.min(Math.max(0, offset), size);
  const len = size - start;
  if (len <= 0) return { chunk: '', fileSize: size };
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { chunk: buf.toString('utf8'), fileSize: size };
  } finally {
    fs.closeSync(fd);
  }
}

async function isAnchorProcessed(mint: string, entryTsMs: number): Promise<boolean> {
  const rows = await sql<{ c: string }[]>`
    SELECT COUNT(*)::text AS c FROM dip_bot_intel_anchors_processed
    WHERE anchor_mint = ${mint} AND anchor_entry_ts_ms = ${entryTsMs}
  `;
  return Number(rows[0]?.c || 0) > 0;
}

async function main(): Promise<void> {
  const env = loadDipBotEnv();
  const jsonlPath = path.resolve(env.liveJsonlPath);
  if (!fs.existsSync(jsonlPath)) {
    console.error(`[dip-bot-intel] missing JSONL: ${jsonlPath}`);
    process.exitCode = 1;
    return;
  }

  const stateRows = await sql<{ last_jsonl_offset_bytes: string }[]>`
    SELECT last_jsonl_offset_bytes::text FROM dip_bot_intel_state WHERE id = 1
  `;
  let offset = Number(stateRows[0]?.last_jsonl_offset_bytes ?? 0);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const { chunk, fileSize } = readTailFromOffset(jsonlPath, offset);
  const lines = chunk.split('\n').filter((l) => l.trim());

  /** Distinct new anchors in tail order */
  const pending: { mint: string; entryTsMs: number }[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const anchor = extractDipBotJournalAnchors(line, env.strategyIds);
    if (!anchor) continue;
    const key = `${anchor.mint}:${anchor.entryTsMs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isAnchorProcessed(anchor.mint, anchor.entryTsMs)) continue;
    pending.push({ mint: anchor.mint, entryTsMs: anchor.entryTsMs });
  }

  const pendingCount = pending.length;
  const batch = pending.slice(0, env.maxAnchorsPerRun);
  let anchorsProcessedThisRun = 0;

  for (const anchor of batch) {
    const windowEndMs = anchor.entryTsMs;
    const windowStartMs = anchor.entryTsMs - env.tPreMs;
    const buyers = await fetchBuyersInWindow(sql, {
      mint: anchor.mint,
      windowStartMs,
      windowEndMs,
      minUsd: env.minUsdPerAnchorBuyer,
      excludeWallet: env.excludeWallet,
    });

    let swapsRowsUsed = 0;
    for (const b of buyers) {
      swapsRowsUsed += b.swapsRows;
      await upsertObservation(sql, b.wallet, anchor.mint, anchor.entryTsMs, b.buyUsd);
    }

    await markAnchorProcessed(sql, anchor.mint, anchor.entryTsMs, buyers.length, swapsRowsUsed);
    anchorsProcessedThisRun++;
  }

  const promoted = await promoteWalletsToTags(sql, env.minHitsForTag);

  /** Advance offset only when tail has no backlog beyond this run (avoid losing anchors). */
  const newOffset = pendingCount <= env.maxAnchorsPerRun ? fileSize : offset;
  await sql`
    UPDATE dip_bot_intel_state SET last_jsonl_offset_bytes = ${newOffset}, updated_at = now() WHERE id = 1
  `;

  console.log(
    JSON.stringify({
      ok: true,
      jsonlPath,
      anchorStrategyFilter: env.strategyIds === null ? '*' : env.strategyIds.join(','),
      jsonlPrevOffset: offset,
      jsonlNewOffset: newOffset,
      jsonlFileSize: fileSize,
      linesInTail: lines.length,
      pendingNewAnchorsInTail: pendingCount,
      anchorsProcessedThisRun,
      walletsPromotedToDipBotTag: promoted,
      billableRpcCalls: 0,
      tagSource: DIP_BOT_TAG_SOURCE,
    }),
  );
}

main().catch((e) => {
  console.error('[dip-bot-intel] fatal', e);
  process.exit(1);
});
