/** Tier dump/pump thresholds shared by PG spike-watch and Jupiter fast-path. */

export type SpikeSignalKind = 'consecutive' | 'rolling';

function envNum(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const PUMP_MIN_PCT = envNum('SPIKE_ALERT_PUMP_MIN_PCT', 30);
const DUMP_TIER1_MCAP = envNum('SPIKE_ALERT_DUMP_TIER1_MCAP_USD', 1_500_000);
const DUMP_TIER2_MCAP = envNum('SPIKE_ALERT_DUMP_TIER2_MCAP_USD', 3_000_000);
const DUMP_TIER3_MCAP = envNum('SPIKE_ALERT_DUMP_TIER3_MCAP_USD', 7_000_000);
const DUMP_TIER1_MIN_PCT_CONSEC = envNum('SPIKE_ALERT_DUMP_TIER1_MIN_PCT', 14);
const DUMP_TIER2_MIN_PCT_CONSEC = envNum('SPIKE_ALERT_DUMP_TIER2_MIN_PCT', 11);
const DUMP_TIER3_MIN_PCT_CONSEC = envNum('SPIKE_ALERT_DUMP_TIER3_MIN_PCT', 8);
const DUMP_TIER1_MIN_PCT_ROLLING = envNum('SPIKE_ALERT_DUMP_TIER1_MIN_PCT_ROLLING', 15);
const DUMP_TIER2_MIN_PCT_ROLLING = envNum('SPIKE_ALERT_DUMP_TIER2_MIN_PCT_ROLLING', 12);
const DUMP_TIER3_MIN_PCT_ROLLING = envNum('SPIKE_ALERT_DUMP_TIER3_MIN_PCT_ROLLING', 10);

export function tierRequiredMinAbsPct(
  refMcap: number,
  isPump: boolean,
  signalKind: SpikeSignalKind = 'consecutive',
): number | null {
  if (isPump) return PUMP_MIN_PCT;
  if (refMcap >= DUMP_TIER3_MCAP) {
    return signalKind === 'rolling' ? DUMP_TIER3_MIN_PCT_ROLLING : DUMP_TIER3_MIN_PCT_CONSEC;
  }
  if (refMcap >= DUMP_TIER2_MCAP) {
    return signalKind === 'rolling' ? DUMP_TIER2_MIN_PCT_ROLLING : DUMP_TIER2_MIN_PCT_CONSEC;
  }
  if (refMcap >= DUMP_TIER1_MCAP) {
    return signalKind === 'rolling' ? DUMP_TIER1_MIN_PCT_ROLLING : DUMP_TIER1_MIN_PCT_CONSEC;
  }
  return null;
}
