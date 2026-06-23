/**
 * Preset C must not buy until the dips channel watcher has sent an alert for that mint.
 * Uses the shared `telegram-retrace-pullback-dedupe.json` store written on TG send.
 */
import {
  readRetracePullbackChannelStore,
  type RetracePullbackChannelDedupeEntry,
} from '../scripts/market-retrace-pullback-channel-dedupe.js';

const DEFAULT_MAX_AGE_MS = 3_600_000;

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

export function isPresetCTelegramGateEnabled(): boolean {
  return envBool('PRESET_C_TELEGRAM_GATE_ENABLED', true);
}

export function presetCTelegramGateReasons(mint: string, nowMs = Date.now()): string[] {
  if (!isPresetCTelegramGateEnabled()) return [];

  const trimmed = mint.trim();
  if (!trimmed) return ['preset_c_telegram_gate_mint_missing'];

  const maxAgeMs = Math.max(
    60_000,
    Math.min(6 * 60 * 60_000, envNum('PRESET_C_TELEGRAM_GATE_MAX_AGE_MS', DEFAULT_MAX_AGE_MS)),
  );
  const sources = allowedSources();
  const prefix = `${trimmed}|`;
  const store = readRetracePullbackChannelStore();

  for (const [key, entry] of Object.entries(store)) {
    if (!key.startsWith(prefix)) continue;
    if (!sources.has(entry.source)) continue;
    if (nowMs - entry.sentAtMs > maxAgeMs) continue;
    return [];
  }

  return ['preset_c_telegram_gate_no_channel_alert'];
}
