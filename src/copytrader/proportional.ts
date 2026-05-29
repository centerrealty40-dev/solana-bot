/** Leader / our position sizing from observed swap raw amounts. */

export function absRawAmount(raw: bigint): bigint {
  return raw < 0n ? -raw : raw;
}

/** Fraction of leader position sold (0–1). */
export function leaderSellFraction(preBalanceRaw: bigint, sellRaw: bigint): number {
  const sold = absRawAmount(sellRaw);
  if (sold <= 0n) return 0;
  if (preBalanceRaw <= 0n) return 1;
  const f = Number(sold) / Number(preBalanceRaw);
  if (!Number.isFinite(f) || f <= 0) return 0;
  return Math.min(1, f);
}

/** Leader add size relative to pre-buy holdings (buyRaw / preBalance). */
export function leaderAddFraction(preBalanceRaw: bigint, buyRaw: bigint): number {
  const bought = absRawAmount(buyRaw);
  if (bought <= 0n || preBalanceRaw <= 0n) return 0;
  const f = Number(bought) / Number(preBalanceRaw);
  if (!Number.isFinite(f) || f <= 0) return 0;
  return f;
}

export function ourAddUsdFromLeaderAdd(args: {
  ourSizeUsd: number;
  addFraction: number;
  maxRoomUsd: number;
  minAddUsd: number;
}): number {
  const { ourSizeUsd, addFraction, maxRoomUsd, minAddUsd } = args;
  if (!(ourSizeUsd > 0) || !(addFraction > 0) || !(maxRoomUsd > 0)) return 0;
  const raw = ourSizeUsd * addFraction;
  const capped = Math.min(raw, maxRoomUsd);
  if (capped < minAddUsd) return 0;
  return Math.round(capped * 100) / 100;
}

export function scaleTokenRaw(tokenRaw: bigint, fraction: number): bigint {
  if (tokenRaw <= 0n || !(fraction > 0)) return 0n;
  const f = Math.min(1, fraction);
  const scaled = (tokenRaw * BigInt(Math.floor(f * 1_000_000))) / 1_000_000n;
  return scaled > 0n ? scaled : tokenRaw;
}

export function reduceUsdAfterPartialSell(sizeUsd: number, sellFraction: number): number {
  if (!(sizeUsd > 0)) return 0;
  const f = Math.min(1, Math.max(0, sellFraction));
  const remain = sizeUsd * (1 - f);
  return Math.round(remain * 100) / 100;
}

export function isFullCloseFraction(fraction: number): boolean {
  return fraction >= 0.999;
}
