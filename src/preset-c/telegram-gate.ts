/**
 * Preset C must not buy until the dips channel watcher has sent an alert for that mint.
 * Uses the shared `telegram-retrace-pullback-dedupe.json` store written on TG send.
 *
 * After a full close, matching dedupe keys are recorded in `preset-c-tg-consumed.json`
 * so the same TG dip signal cannot re-open until TTL (24h) or a new peak bucket alert.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { OpenTrade } from '../papertrader/types.js';
import {
  readRetracePullbackChannelStore,
  type RetracePullbackChannelDedupeEntry,
} from '../scripts/market-retrace-pullback-channel-dedupe.js';
import { isLiveOscarPresetCStrategyId } from './live-oscar-family.js';

const DEFAULT_MAX_AGE_MS = 3_600_000;
const CONSUMED_REL = 'data/live/preset-c-tg-consumed.json';
/** Consumed keys expire after 24h. A new channel alert uses a different peak-bucket key and is not blocked. */
const CONSUMED_TTL_MS = 24 * 60 * 60_000;

export type PresetCTgConsumedEntry = {
  consumedAtMs: number;
  peakBucket?: number;
};

type ConsumedStore = Record<string, PresetCTgConsumedEntry>;

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v !== '0' && v !== 'false' && v !== 'no';
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function allowedSources(): Set<RetracePullbackChannelDedupeEntry['source']> {
  const raw = (process.env.PRESET_C_TELEGRAM_GATE_SOURCES ?? 'pullback,retrace').trim();
  const out = new Set<RetracePullbackChannelDedupeEntry['source']>();
  for (const part of raw.split(',')) {
    const s = part.trim().toLowerCase();
    if (s === 'pullback' || s === 'retrace') out.add(s);
  }
  if (out.size === 0) {
    out.add('pullback');
    out.add('retrace');
  }
  return out;
}

function consumedFilePath(): string {
  return path.join(process.cwd(), CONSUMED_REL);
}

function readConsumedStoreSync(): ConsumedStore {
  try {
    const raw = fs.readFileSync(consumedFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as ConsumedStore;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeConsumedStoreSync(store: ConsumedStore): void {
  const file = consumedFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  cleanupExpiredConsumed(store, Date.now());
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function isPresetCTelegramGateEnabled(): boolean {
  return envBool('PRESET_C_TELEGRAM_GATE_ENABLED', true);
}

function gateMaxAgeMs(): number {
  return Math.max(
    60_000,
    Math.min(6 * 60 * 60_000, envNum('PRESET_C_TELEGRAM_GATE_MAX_AGE_MS', DEFAULT_MAX_AGE_MS)),
  );
}

/** Fresh channel dedupe keys for mint that satisfy source + max-age filters. */
export function matchingPresetCTelegramGateKeys(mint: string, nowMs = Date.now()): string[] {
  const trimmed = mint.trim();
  if (!trimmed) return [];

  const maxAgeMs = gateMaxAgeMs();
  const sources = allowedSources();
  const prefix = `${trimmed}|`;
  const store = readRetracePullbackChannelStore();
  const keys: string[] = [];

  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    if (!sources.has(entry.source)) continue;
    if (nowMs - entry.sentAtMs > maxAgeMs) continue;
    keys.push(key);
  }

  return keys;
}

/** Drop consumed entries older than 24h. Mutates `store` when passed; otherwise prunes persisted file. */
export function cleanupExpiredConsumed(
  store?: ConsumedStore,
  nowMs = Date.now(),
): ConsumedStore {
  const s = store ?? readConsumedStoreSync();
  const cut = nowMs - CONSUMED_TTL_MS;
  for (const [k, v] of Object.entries(s)) {
    if (v.consumedAtMs < cut) delete s[k];
  }
  if (!store) writeConsumedStoreSync(s);
  return s;
}

export function isConsumed(key: string, nowMs = Date.now()): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const entry = readConsumedStoreSync()[trimmed];
  if (!entry) return false;
  return nowMs - entry.consumedAtMs <= CONSUMED_TTL_MS;
}

export function markConsumed(key: string, peakBucket?: number): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  const store = readConsumedStoreSync();
  store[trimmed] = {
    consumedAtMs: Date.now(),
    ...(peakBucket != null ? { peakBucket } : {}),
  };
  writeConsumedStoreSync(store);
}

export function markConsumedKeys(keys: string[]): void {
  const channelStore = readRetracePullbackChannelStore();
  for (const key of keys) {
    const trimmed = key.trim();
    if (!trimmed) continue;
    markConsumed(trimmed, channelStore[trimmed]?.peakBucket);
  }
}

/** Stamp TG dedupe keys that unlocked entry — used on full close to block re-buy on same signal. */
export function stampPresetCTgDedupeKeysOnOpen(ot: OpenTrade, nowMs = Date.now()): void {
  const keys = matchingPresetCTelegramGateKeys(ot.mint, nowMs);
  if (keys.length > 0) ot.presetCTgDedupeKeys = keys;
}

/** After full close: mark entry-time TG keys consumed (preset-c only). */
export function markPresetCTelegramGateConsumedOnFullClose(
  strategyId: string,
  openTrade?: OpenTrade,
): void {
  if (!isLiveOscarPresetCStrategyId(strategyId)) return;
  const keys =
    openTrade?.presetCTgDedupeKeys?.length
      ? openTrade.presetCTgDedupeKeys
      : openTrade?.mint
        ? matchingPresetCTelegramGateKeys(openTrade.mint)
        : [];
  if (keys.length > 0) markConsumedKeys(keys);
}

export function presetCTelegramGateReasons(mint: string, nowMs = Date.now()): string[] {
  if (!isPresetCTelegramGateEnabled()) return [];

  const trimmed = mint.trim();
  if (!trimmed) return ['preset_c_telegram_gate_mint_missing'];

  const freshKeys = matchingPresetCTelegramGateKeys(trimmed, nowMs);
  if (freshKeys.length === 0) return ['preset_c_telegram_gate_no_channel_alert'];

  const tradeableKeys = freshKeys.filter((k) => !isConsumed(k, nowMs));
  if (tradeableKeys.length === 0) return ['preset_c_telegram_gate_signal_already_traded'];

  return [];
}
