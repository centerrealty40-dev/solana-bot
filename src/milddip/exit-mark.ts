/**
 * Exit marks — stream/ring only.
 *
 * The open-book mark pass must never await DexScreener. Sync Dex + a 120 RPM
 * gate turned every mark cycle into a 20–60s queue when stream went quiet.
 * Price for exits comes from the in-process price ring (stream swaps + entry
 * fill seed). Dex stays on discovery/entry paths only.
 */

export type ExitMarkRingSample = {
  priceUsd: number;
  tsMs: number;
  source: 'stream' | 'dex';
};

export type ExitMarkResult = {
  px: number | null;
  /** Always null on the exit path — vol fade must not pull Dex here. */
  volume5mUsd: null;
  source: 'stream' | 'dex' | null;
  ageMs: number | null;
};

/**
 * Resolve an exit mark from the last ring print.
 *
 * @param maxAgeMs 0 = accept any last print; else drop if older than this.
 */
export function resolveExitMarkFromRing(args: {
  last: ExitMarkRingSample | null | undefined;
  nowMs: number;
  maxAgeMs: number;
}): ExitMarkResult {
  const last = args.last;
  if (!last || !(last.priceUsd > 0) || !Number.isFinite(last.priceUsd)) {
    return { px: null, volume5mUsd: null, source: null, ageMs: null };
  }
  const ageMs = Math.max(0, args.nowMs - last.tsMs);
  if (args.maxAgeMs > 0 && ageMs > args.maxAgeMs) {
    return { px: null, volume5mUsd: null, source: null, ageMs };
  }
  return {
    px: last.priceUsd,
    volume5mUsd: null,
    source: last.source === 'stream' ? 'stream' : 'dex',
    ageMs,
  };
}
