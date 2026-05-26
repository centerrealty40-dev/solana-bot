/** Known program ids for labels / ops (extend in W4+). */

export const KNOWN_PROGRAMS: Record<string, string> = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-amm-v4',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'orca-whirlpool',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'meteora-dlmm',
};

export function programIdToName(programId: string): string {
  return KNOWN_PROGRAMS[programId] ?? 'unknown';
}
