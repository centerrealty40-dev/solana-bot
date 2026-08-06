import fs from 'node:fs';
import path from 'node:path';

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
  /** 5m Dex volume at entry — baseline for the activity-fade exit. */
  entryVolume5mUsd?: number | null;
  /**
   * Spaced Dex vol5m samples (≥5m apart) for sustained `never_arm_vol_fade`.
   * A single weak tick must not sell — need N consecutive weak windows.
   */
  volFadeSamples?: Array<{ ts: number; vol: number }>;
};

export type MildDipState = {
  open: Record<string, MildDipOpenPosition>;
  /** mint → last close/attempt ms (cooldown). */
  cooldownUntilMs: Record<string, number>;
  updatedAtMs: number;
};

export function emptyMildDipState(nowMs = Date.now()): MildDipState {
  return { open: {}, cooldownUntilMs: {}, updatedAtMs: nowMs };
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
