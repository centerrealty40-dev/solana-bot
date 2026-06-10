function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/** Trade every TWAP — no duration / momentum / BTC / whale / impact gates. */
export function hlTwapUnrestrictedMode(): boolean {
  return envBool('HL_TWAP_UNRESTRICTED', false);
}

/** Reset env cache for tests. */
export function resetHlTwapUnrestrictedCache(): void {
  /* env read live — no cache yet */
}
