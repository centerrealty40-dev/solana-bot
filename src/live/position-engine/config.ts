import type { PositionEngineConfig } from './types.js';
import { defaultPositionEngineConfig } from './guards.js';

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return fallback;
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Load UPE config from env (live-oscar). */
export function loadPositionEngineConfigFromEnv(): PositionEngineConfig {
  return defaultPositionEngineConfig({
    enabled: envBool('LIVE_UNIFIED_POSITION_ENGINE', true),
    minChainJournalRatio: envNum('LIVE_UPE_MIN_CHAIN_JOURNAL_RATIO', 0.55),
    allowLiqDrainDuringAcquire: envBool('LIVE_UPE_ALLOW_LIQ_DRAIN_DURING_ACQUIRE', true),
  });
}
