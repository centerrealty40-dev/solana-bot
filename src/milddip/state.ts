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

export type SaveMildDipStateOpts = {
  /**
   * Mints intentionally dropped this write (successful sell, empty drop, or
   * aborted buy with no on-chain bag). Without this, a twin writer's confirmed
   * opens on disk are merged back in so a failed buy cannot wipe a filled seat
   * (89RAitwP… sat ~5h after a raced send_failed clobbered state.json).
   */
  removeMints?: string[];
};

/**
 * Merge in-memory opens with disk opens for a crash/twin-safe write.
 * Memory wins on key overlap; disk-only opens are kept unless removed.
 */
export function mergeMildDipOpenForSave(
  memory: Record<string, MildDipOpenPosition>,
  disk: Record<string, MildDipOpenPosition>,
  removeMints?: Iterable<string>,
): Record<string, MildDipOpenPosition> {
  const removed = new Set(removeMints ?? []);
  const out: Record<string, MildDipOpenPosition> = { ...memory };
  for (const m of removed) delete out[m];
  for (const [m, pos] of Object.entries(disk)) {
    if (removed.has(m) || out[m]) continue;
    out[m] = pos;
  }
  return out;
}

export function saveMildDipState(
  statePath: string,
  state: MildDipState,
  opts?: SaveMildDipStateOpts,
): void {
  const dir = path.dirname(statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const disk = loadMildDipState(statePath);
  state.open = mergeMildDipOpenForSave(state.open, disk.open, opts?.removeMints);
  for (const [m, until] of Object.entries(disk.cooldownUntilMs)) {
    const local = state.cooldownUntilMs[m] ?? 0;
    if (until > local) state.cooldownUntilMs[m] = until;
  }
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
