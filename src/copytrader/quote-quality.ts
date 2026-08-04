/**
 * Refuse to send a buy when the current Jupiter outAmount is worse than the
 * best quote already seen in this attempt cycle (Am8i RCA: 10→70bps fill at
 * −3% tokens vs earlier quotes in the same ladder).
 */
export function isQuoteOutRegressed(args: {
  outRaw: bigint;
  bestOutRaw: bigint;
  maxRegressionPct: number;
}): boolean {
  if (!(args.maxRegressionPct > 0) || args.bestOutRaw <= 0n || args.outRaw <= 0n) return false;
  const keepBps = Math.max(0, Math.min(10_000, Math.round((100 - args.maxRegressionPct) * 100)));
  return args.outRaw * 10_000n < args.bestOutRaw * BigInt(keepBps);
}

export function parseTokenRaw(raw: unknown): bigint | null {
  if (typeof raw === 'bigint') return raw > 0n ? raw : null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return BigInt(Math.floor(raw));
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = BigInt(raw);
    return n > 0n ? n : null;
  }
  return null;
}
