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
  /** Running low-water mark from entry (never-arm bounce / freefall). */
  postEntryTroughUsd?: number;
  /** When postEntryTroughUsd was last deepened. */
  postEntryTroughAtMs?: number;
  /** W9.1 trail armed after MFE ≥ armPct. */
  trailArmed?: boolean;
  /**
   * Sticky exit after a failed sell. While set, every mark re-queues the same
   * exit reason — bounce must not clear giveback.
   */
  exitPendingReason?: string | null;
  /** Legacy partial flag (also mirrored by scaleOutDone / mfeBankStage). */
  exitPartialTaken?: boolean;
  /** True after a successful partial scale-out / mfe bank peel. */
  scaleOutDone?: boolean;
  /**
   * MFE-bank ladder: 0/undefined = none, 1 = bank1 filled, 2 = bank2 filled.
   */
  mfeBankStage?: number;
  /** 5m Dex volume at entry — baseline for activity-fade. */
  entryVolume5mUsd?: number | null;
  /** Spaced Dex vol5m samples for sustained never_arm_vol_fade. */
  volFadeSamples?: Array<{ ts: number; vol: number }>;
};

export type MildDipLastExit = {
  priceUsd: number;
  atMs: number;
  pnlPct?: number;
};

export type MildDipState = {
  open: Record<string, MildDipOpenPosition>;
  cooldownUntilMs: Record<string, number>;
  lastExitByMint?: Record<string, MildDipLastExit>;
  updatedAtMs: number;
};

function sanitizeLastExitByMint(raw: unknown): Record<string, MildDipLastExit> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, MildDipLastExit> = {};
  for (const [mint, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!mint || mint.length < 32 || !v || typeof v !== 'object') continue;
    const o = v as Partial<MildDipLastExit>;
    const priceUsd = Number(o.priceUsd);
    const atMs = Number(o.atMs);
    if (!(priceUsd > 0) || !(atMs > 0)) continue;
    out[mint] = {
      priceUsd,
      atMs,
      pnlPct: typeof o.pnlPct === 'number' ? o.pnlPct : undefined,
    };
  }
  return out;
}

export function emptyMildDipState(nowMs = Date.now()): MildDipState {
  return { open: {}, cooldownUntilMs: {}, lastExitByMint: {}, updatedAtMs: nowMs };
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
