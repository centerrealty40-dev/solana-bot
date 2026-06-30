/**
 * Preset C candidates from fresh spike-channel dedupe (пролив alerts).
 * PG pullback geometry may differ; use spike dump % from dedupe entry.
 */
import { sql as dsql } from 'drizzle-orm';

import { db } from '../core/db/client.js';
import {
  readRetracePullbackChannelStore,
} from '../scripts/market-retrace-pullback-channel-dedupe.js';
import { isTelegramMarketAlertMintBlocked } from '../scripts/telegram-alert-mint-blacklist.js';
import {
  PRESET_C_ELITE_SPIKE_ENABLED,
  PRESET_C_MIN_RETRACE_PCT,
  passesPresetCEliteSpikeDumpBand,
  passesPresetCEliteSpikeSanity,
  passesPresetCEliteSpikeUtcWindow,
  passesPresetCRetraceBand,
  passesPresetCSpikeMcapBand,
  isPresetCMcapKnown,
} from './filters.js';
import type { PresetCPullbackCandidate } from './pullback-scan.js';
import { matchingPresetCTelegramGateKeys } from './telegram-gate.js';

const SNAPSHOT_TABLES = [
  'pumpswap_pair_snapshots',
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
] as const;

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const MAX_BAR_AGE_MS = 30 * 60_000;

type SpikeMintSignal = {
  mint: string;
  spikeDumpPct: number;
  refMcapUsd: number;
  sentAtMs: number;
};

function freshSpikeSignalsByMint(nowMs: number): Map<string, SpikeMintSignal> {
  const store = readRetracePullbackChannelStore();
  const byMint = new Map<string, SpikeMintSignal>();

  for (const [key, entry] of Object.entries(store)) {
    if (entry.source !== 'spike') continue;
    const pipe = key.indexOf('|');
    if (pipe <= 0) continue;
    const mint = key.slice(0, pipe).trim();
    if (!ADDR_RE.test(mint)) continue;
    if (!matchingPresetCTelegramGateKeys(mint, nowMs).includes(key)) continue;

    const dumpPct = entry.spikeDumpPct ?? 0;
    if (PRESET_C_ELITE_SPIKE_ENABLED) {
      if (!passesPresetCEliteSpikeDumpBand(dumpPct)) continue;
      if (!passesPresetCEliteSpikeSanity(dumpPct)) continue;
      if (!passesPresetCEliteSpikeUtcWindow(entry.sentAtMs)) continue;
    } else if (!(dumpPct >= PRESET_C_MIN_RETRACE_PCT)) {
      continue;
    }

    const refM = entry.refMcapUsd ?? 0;
    if (!passesPresetCSpikeMcapBand(refM)) continue;

    const prev = byMint.get(mint);
    if (!prev || entry.sentAtMs > prev.sentAtMs) {
      byMint.set(mint, {
        mint,
        spikeDumpPct: dumpPct,
        refMcapUsd: refM,
        sentAtMs: entry.sentAtMs,
      });
    }
  }

  return byMint;
}

function sqlMintInList(mints: string[]): string | null {
  const parts: string[] = [];
  for (const m of mints) {
    if (!ADDR_RE.test(m)) continue;
    parts.push(`'${m.replace(/'/g, "''")}'`);
  }
  if (!parts.length) return null;
  return parts.join(', ');
}

type LatestRow = {
  base_mint: string;
  pair_address: string;
  px_now: number;
  ts_now: Date | string;
  symbol: string | null;
  token_name: string | null;
  holder_count: number | null;
  liq_usd: number | null;
  token_fdv_usd: number | null;
  token_age_min: number | null;
  market_cap_usd: number | null;
};

async function loadLatestForMints(table: string, mintsSql: string): Promise<LatestRow[]> {
  const q = `
SELECT DISTINCT ON (s.base_mint)
  s.base_mint,
  s.pair_address,
  s.price_usd::double precision AS px_now,
  s.ts AS ts_now,
  t.symbol,
  t.name AS token_name,
  t.holder_count,
  s.liquidity_usd::double precision AS liq_usd,
  t.fdv_usd::double precision AS token_fdv_usd,
  COALESCE(s.market_cap_usd, s.fdv_usd, t.fdv_usd)::double precision AS market_cap_usd,
  EXTRACT(EPOCH FROM (now() - COALESCE(s.launch_ts, t.first_seen_at))) / 60.0 AS token_age_min
FROM ${table} s
INNER JOIN tokens t ON t.mint = s.base_mint
WHERE s.base_mint IN (${mintsSql})
  AND COALESCE(s.price_usd, 0) > 0
  AND s.ts > now() - interval '2 hours'
ORDER BY s.base_mint, s.liquidity_usd DESC NULLS LAST, s.ts DESC`;
  const r = await db.execute(dsql.raw(q));
  return (r as unknown as Record<string, unknown>[]).map((row) => ({
    base_mint: String(row.base_mint ?? ''),
    pair_address: String(row.pair_address ?? ''),
    px_now: Number(row.px_now),
    ts_now: row.ts_now as Date | string,
    symbol: row.symbol != null ? String(row.symbol) : null,
    token_name: row.token_name != null ? String(row.token_name) : null,
    holder_count: row.holder_count != null ? Number(row.holder_count) : null,
    liq_usd: row.liq_usd != null ? Number(row.liq_usd) : null,
    token_fdv_usd:
      row.token_fdv_usd != null && Number.isFinite(Number(row.token_fdv_usd))
        ? Number(row.token_fdv_usd)
        : null,
    token_age_min:
      row.token_age_min != null && Number.isFinite(Number(row.token_age_min))
        ? Number(row.token_age_min)
        : null,
    market_cap_usd:
      row.market_cap_usd != null && Number.isFinite(Number(row.market_cap_usd))
        ? Number(row.market_cap_usd)
        : null,
  }));
}

function parseTs(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function refMcap(meta: LatestRow, spikeRef: number): number {
  if (isPresetCMcapKnown(spikeRef)) return spikeRef;
  const mcap = meta.market_cap_usd;
  if (mcap != null && isPresetCMcapKnown(mcap)) return mcap;
  const fdv = meta.token_fdv_usd;
  if (fdv != null && isPresetCMcapKnown(fdv)) return fdv;
  return 0;
}

/** Spike TG dumps with fresh dedupe keys → Preset C candidates (entry path preset_c_spike). */
export async function evaluatePresetCSpikeCandidates(
  nowMs = Date.now(),
): Promise<PresetCPullbackCandidate[]> {
  const signals = freshSpikeSignalsByMint(nowMs);
  if (signals.size === 0) return [];

  const mintsSql = sqlMintInList([...signals.keys()]);
  if (!mintsSql) return [];

  const byMint = new Map<string, PresetCPullbackCandidate>();

  for (const table of SNAPSHOT_TABLES) {
    let rows: LatestRow[];
    try {
      rows = await loadLatestForMints(table, mintsSql);
    } catch {
      continue;
    }

    const dex = table.replace('_pair_snapshots', '');
    for (const meta of rows) {
      const mint = meta.base_mint.trim();
      const sig = signals.get(mint);
      if (!sig) continue;
      if (isTelegramMarketAlertMintBlocked(mint)) continue;

      const ts = parseTs(meta.ts_now);
      if (nowMs - ts.getTime() > MAX_BAR_AGE_MS) continue;

      const retracePct = sig.spikeDumpPct;
      if (PRESET_C_ELITE_SPIKE_ENABLED) {
        if (!passesPresetCEliteSpikeDumpBand(retracePct)) continue;
        if (!passesPresetCEliteSpikeSanity(retracePct)) continue;
        if (!passesPresetCEliteSpikeUtcWindow(sig.sentAtMs)) continue;
      } else if (!passesPresetCRetraceBand(retracePct)) {
        continue;
      }

      const refM = refMcap(meta, sig.refMcapUsd);
      if (!passesPresetCSpikeMcapBand(refM)) continue;

      const liq = meta.liq_usd ?? 0;
      const prev = byMint.get(mint);
      if (prev && (prev.liqUsd ?? 0) >= liq) continue;

      const px = meta.px_now;
      const anchorPx = px / (1 - retracePct / 100);
      const now = ts;

      byMint.set(mint, {
        dex,
        mint,
        pair: meta.pair_address.trim(),
        symbol: meta.symbol?.trim() || meta.token_name?.trim() || mint.slice(0, 8),
        tokenAgeMin: meta.token_age_min ?? 0,
        holderCount: meta.holder_count,
        liqUsd: liq,
        refMcapUsd: refM,
        priceUsd: px,
        entryPath: 'preset_c_spike',
        spikeSentAtMs: sig.sentAtMs,
        pick: {
          signalMode: 'local_high_retrace',
          anchorTs: now,
          peakTs: now,
          lastTs: now,
          anchorPx,
          peakPx: anchorPx,
          lastPx: px,
          risePct: 0,
          retraceFromPeakPct: retracePct,
          anchorMcapUsd: refM > 0 ? refM / (1 - retracePct / 100) : null,
          peakMcapUsd: refM > 0 ? refM / (1 - retracePct / 100) : null,
          lastMcapUsd: refM > 0 ? refM : null,
        },
      });
    }
  }

  return [...byMint.values()];
}
