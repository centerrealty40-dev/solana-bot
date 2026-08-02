import type { CopyTraderConfig } from './config.js';

export type CopyTraderExitMode = 'oscar_half8' | 'mirror' | 'trail_runner';

/** Default: Oscar wave_b half8_runner exit — do not mirror leader sells. */
export function parseCopyTraderExitMode(raw: unknown): CopyTraderExitMode {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'mirror' || s === 'leader_mirror' || s === 'mirror_leader') return 'mirror';
  if (s === 'trail_runner' || s === 'trail' || s === 'trailing') return 'trail_runner';
  return 'oscar_half8';
}

export function usesOscarExitPolicy(cfg: CopyTraderConfig): boolean {
  return cfg.exitMode === 'oscar_half8';
}

/**
 * Self-managed peak trail + hard time cap. Own exit only — leader sells are
 * ignored; the twin lane `copy-trader-*-mirror` is the one that follows him out.
 */
export function usesTrailingExitPolicy(cfg: CopyTraderConfig): boolean {
  return cfg.exitMode === 'trail_runner';
}

/** Proportional leader sells + flat-tail sweep. Only `mirror` mode. */
export function mirrorsLeaderSells(cfg: CopyTraderConfig): boolean {
  return cfg.exitMode === 'mirror';
}
