/**
 * Preset C scalp — pending signals (TG + discovery pass, no immediate buy).
 * Persisted to `data/live/preset-c-scalp-pending.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { EvalDecision } from '../papertrader/discovery/dip-clones.js';
import { fetchLatestSnapshotQuote, type DexSnapshotSource } from '../papertrader/pricing.js';
import { loadPresetCScalpConfig } from './scalp-config.js';

const PENDING_REL = 'data/live/preset-c-scalp-pending.json';

export type PresetCScalpPendingSignal = {
  mint: string;
  symbol: string;
  lane: string;
  source?: string;
  entryPath?: string;
  signalTs: number;
  /** Anchor for entry drops and exit levels (price at discovery pass / TG gate). */
  signalPriceUsd: number;
  liveOscarMcapTier?: EvalDecision['liveOscarMcapTier'];
  features: EvalDecision['features'];
  expiresAtMs: number;
  entryLegDone?: boolean;
  tgDedupeKeys?: string[];
};

type PendingStore = Record<string, PresetCScalpPendingSignal>;

function pendingFilePath(): string {
  return path.join(process.cwd(), PENDING_REL);
}

function readStoreSync(): PendingStore {
  try {
    const raw = fs.readFileSync(pendingFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as PendingStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoreSync(store: PendingStore): void {
  const file = pendingFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 0)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function listPresetCScalpPending(): PresetCScalpPendingSignal[] {
  return Object.values(readStoreSync());
}

export function getPresetCScalpPending(mint: string): PresetCScalpPendingSignal | undefined {
  return readStoreSync()[mint.trim()];
}

export function hasPresetCScalpPending(mint: string): boolean {
  return getPresetCScalpPending(mint) != null;
}

export function removePresetCScalpPending(mint: string): void {
  const store = readStoreSync();
  if (!delete store[mint.trim()]) return;
  writeStoreSync(store);
}

export function upsertPresetCScalpPendingFromDecision(
  d: EvalDecision,
  tgDedupeKeys: string[],
  nowMs = Date.now(),
): PresetCScalpPendingSignal {
  const scalp = loadPresetCScalpConfig();
  const mint = d.mint.trim();
  const store = readStoreSync();
  const existing = store[mint];
  const signalPriceUsd = d.features.price_usd;
  const next: PresetCScalpPendingSignal = {
    mint,
    symbol: d.symbol,
    lane: d.lane,
    source: d.source,
    entryPath: d.entryPath,
    signalTs: existing?.signalTs ?? nowMs,
    signalPriceUsd: existing?.signalPriceUsd ?? signalPriceUsd,
    liveOscarMcapTier: d.liveOscarMcapTier,
    features: { ...d.features },
    expiresAtMs: (existing?.signalTs ?? nowMs) + scalp.maxPendingAgeMs,
    entryLegDone: existing?.entryLegDone,
    tgDedupeKeys: tgDedupeKeys.length > 0 ? tgDedupeKeys : existing?.tgDedupeKeys,
  };
  store[mint] = next;
  writeStoreSync(store);
  return next;
}

export function markPresetCScalpPendingEntryDone(mint: string): void {
  const store = readStoreSync();
  const row = store[mint.trim()];
  if (!row) return;
  row.entryLegDone = true;
  store[mint.trim()] = row;
  writeStoreSync(store);
}

export function pruneExpiredPresetCScalpPending(nowMs = Date.now()): string[] {
  const store = readStoreSync();
  const removed: string[] = [];
  for (const [mint, row] of Object.entries(store)) {
    if (nowMs <= row.expiresAtMs) continue;
    delete store[mint];
    removed.push(mint);
  }
  if (removed.length > 0) writeStoreSync(store);
  return removed;
}

/** Drop from signal anchor in percent (positive when price below signal). */
export function presetCScalpSignalDropPct(signalPriceUsd: number, curPriceUsd: number): number | null {
  if (!(signalPriceUsd > 0) || !(curPriceUsd > 0)) return null;
  return (1 - curPriceUsd / signalPriceUsd) * 100;
}

export type PresetCScalpReadyEntry = PresetCScalpPendingSignal & {
  currentPriceUsd: number;
  signalDropPct: number;
};

/**
 * Pending mints whose price reached entry drop (−10% default) and are not yet opened.
 */
export async function findPresetCScalpEntriesReady(
  openMints: ReadonlySet<string>,
  nowMs = Date.now(),
): Promise<PresetCScalpReadyEntry[]> {
  const scalp = loadPresetCScalpConfig();
  pruneExpiredPresetCScalpPending(nowMs);
  const out: PresetCScalpReadyEntry[] = [];

  for (const row of listPresetCScalpPending()) {
    if (row.entryLegDone || openMints.has(row.mint)) continue;
    if (nowMs > row.expiresAtMs) continue;

    const src = row.source as DexSnapshotSource | undefined;
    const q = await fetchLatestSnapshotQuote(row.mint, src);
    const px = q.priceUsd ?? row.features.price_usd;
    if (!(px > 0)) continue;

    const dropPct = presetCScalpSignalDropPct(row.signalPriceUsd, px);
    if (dropPct == null || dropPct + 1e-6 < scalp.entryDropPct) continue;

    out.push({
      ...row,
      currentPriceUsd: px,
      signalDropPct: dropPct,
    });
  }

  return out;
}

/** Build EvalDecision for the deferred open path in main discovery loop. */
export function presetCScalpReadyToEvalDecision(ready: PresetCScalpReadyEntry): EvalDecision {
  return {
    lane: ready.lane as EvalDecision['lane'],
    source: ready.source ?? 'preset_c_scalp',
    mint: ready.mint,
    symbol: ready.symbol,
    ageMin: ready.features.token_age_min ?? 0,
    pass: true,
    reasons: [],
    features: {
      ...ready.features,
      price_usd: ready.currentPriceUsd,
      snapshot_ts_ms: Date.now(),
    },
    whale: null,
    entryPath: (ready.entryPath ?? 'preset_c_pullback') as EvalDecision['entryPath'],
    liveOscarMcapTier: ready.liveOscarMcapTier,
    liveOscarTradeLane: 'prod',
  };
}
