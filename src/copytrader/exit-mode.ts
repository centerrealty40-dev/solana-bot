import type { CopyTraderConfig } from './config.js';

export type CopyTraderExitMode = 'oscar_half8' | 'mirror';

/** Default: Oscar wave_b half8_runner exit — do not mirror leader sells. */
export function parseCopyTraderExitMode(raw: unknown): CopyTraderExitMode {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'mirror' || s === 'leader_mirror' || s === 'mirror_leader') return 'mirror';
  return 'oscar_half8';
}

export function usesOscarExitPolicy(cfg: CopyTraderConfig): boolean {
  return cfg.exitMode === 'oscar_half8';
}
