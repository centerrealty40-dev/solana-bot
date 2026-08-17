export type StreamDexPriceSanity = {
  valid: boolean;
  divergence: number | null;
};

export function validateStreamDexPrice(args: {
  streamPriceUsd: number | null | undefined;
  dexPriceUsd: number | null | undefined;
  maxDivergenceFactor: number;
}): StreamDexPriceSanity {
  const stream = args.streamPriceUsd;
  const dex = args.dexPriceUsd;
  if (!(stream != null && Number.isFinite(stream) && stream > 0) || !(dex != null && Number.isFinite(dex) && dex > 0)) {
    return { valid: true, divergence: null };
  }
  const divergence = Math.max(stream / dex, dex / stream);
  return { valid: divergence <= Math.max(1, args.maxDivergenceFactor), divergence };
}
