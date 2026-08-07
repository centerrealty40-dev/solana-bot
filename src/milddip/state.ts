import fs from 'node:fs';
import path from 'node:path';
import type { KnifeWatchEntry } from './knife-stabilize.js';

export type MildDipOpenPosition = {
  mint: string;
  symbol: string;
  entryPriceUsd: number;
  sizeUsd: number;
  tokenRaw: string | null;
  openedAtMs: number;
  entryPc5mPct: number | null;
  buySignature: string | null;
  /** Running high-water mark from entry (W9.1). */
  peakPriceUsd?: number;
  /** W9.1 trail armed after MFE ≥ armPct. */
  trailArmed?: boolean;
  /** True after a successful partial scale-out (half bag sold). */
  scaleOutDone?: boolean;
  /** True after mild_stabilize second $5 clip was merged into this position. */
  bounceClipDone?: boolean;
  /** 5m Dex volume at entry — baseline for the activity-fade exit. */
  entryVolume5mUsd?: number | null;
  /**
   * Spaced Dex vol5m samples (≥5m apart) for sustained `never_arm_vol_fade`.
   * A single weak tick must not sell — need N consecutive weak windows.
   */
  volFadeSamples?: Array<{ ts: number; vol: number }>;
};

/** Last full exit — block rebuy near the same USD price (no Dex needed). */
export type MildDipLastExit = {
  priceUsd: number;
  atMs: number;
  pnlPct?: number;
};

export type MildDipState = {
  open: Record<string, MildDipOpenPosition>;
  /** mint → last close/attempt ms (cooldown). */
  cooldownUntilMs: Record<string, number>;
  /** mint → last full-exit fill/mark price for same-price rebuy guard. */
  lastExitByMint?: Record<string, MildDipLastExit>;
  /** mint → deep-knife watch (wait for stabilize / bounce). */
  knifeWatch?: Record<string, KnifeWatchEntry>;
  updatedAtMs: number;
};

function sanitizeKnifeWatch(
  raw: unknown,
): Record<string, KnifeWatchEntry> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, KnifeWatchEntry> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<KnifeWatchEntry>;
    const detectedAtMs = Number(o.detectedAtMs);
    const knifeDipPct = Number(o.knifeDipPct);
    const peakPriceUsd = Number(o.peakPriceUsd);
    const troughPriceUsd = Number(o.troughPriceUsd);
    const troughAtMs = Number(o.troughAtMs);
    const lastPriceUsd = Number(o.lastPriceUsd);
    const lastAtMs = Number(o.lastAtMs);
    if (
      !(detectedAtMs > 0) ||
      !Number.isFinite(knifeDipPct) ||
      !(peakPriceUsd > 0) ||
      !(troughPriceUsd > 0) ||
      !(troughAtMs > 0) ||
      !(lastPriceUsd > 0) ||
      !(lastAtMs > 0)
    ) {
      continue;
    }
    const readyNotifiedAtMs = Number(o.readyNotifiedAtMs);
    out[mint] = {
      detectedAtMs,
      knifeDipPct,
      peakPriceUsd,
      troughPriceUsd,
      troughAtMs,
      lastPriceUsd,
      lastAtMs,
      ...(readyNotifiedAtMs > 0 ? { readyNotifiedAtMs } : {}),
    };
  }
  return out;
}

function sanitizeLastExitByMint(raw: unknown): Record<string, MildDipLastExit> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, MildDipLastExit> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<MildDipLastExit>;
    const priceUsd = Number(o.priceUsd);
    const atMs = Number(o.atMs);
    if (!(priceUsd > 0) || !(atMs > 0)) continue;
    const pnlPct = Number(o.pnlPct);
    out[mint] = {
      priceUsd,
      atMs,
      ...(Number.isFinite(pnlPct) ? { pnlPct } : {}),
    };
  }
  return out;
}

export function emptyMildDipState(nowMs = Date.now()): MildDipState {
  return { open: {}, cooldownUntilMs: {}, lastExitByMint: {}, knifeWatch: {}, updatedAtMs: nowMs };
}

export function loadMildDipState(statePath: string): MildDipState {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as MildDipState;
    if (!parsed || typeof parsed !== 'object') return emptyMildDipState();
    return {
      open: parsed.open && typeof parsed.open === 'object' ? parsed.open : {},
      cooldownUntilMs:
        parsed.cooldownUntilMs && typeof parsed.cooldownUntilMs === 'object'
          ? parsed.cooldownUntilMs
          : {},
      lastExitByMint: sanitizeLastExitByMint(parsed.lastExitByMint),
      knifeWatch: sanitizeKnifeWatch(parsed.knifeWatch),
      updatedAtMs: Number(parsed.updatedAtMs) || Date.now(),
    };
  } catch {
    return emptyMildDipState();
  }
}

export function saveMildDipState(statePath: string, state: MildDipState): void {
  const dir = path.dirname(statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  state.updatedAtMs = Date.now();
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, statePath);
}

export function appendMildDipJournal(
  journalPath: string,
  event: Record<string, unknown>,
): void {
  const dir = path.dirname(journalPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8');
}
