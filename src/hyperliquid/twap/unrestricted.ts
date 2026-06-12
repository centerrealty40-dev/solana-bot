function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** Unrestricted: all TWAP durations, no momentum/BTC/whale/prior-loss gates. Impact ≥2%/h always enforced (detect + schedule). */
export function hlTwapUnrestrictedMode(): boolean {
  return envBool('HL_TWAP_UNRESTRICTED', false);
}

/** Reset env cache for tests. */
export function resetHlTwapUnrestrictedCache(): void {
  /* env read live — no cache yet */
}
