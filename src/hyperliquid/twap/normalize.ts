import { resolveTwapMarket, type HyperliquidMarketCache } from './hyperliquid-meta.js';
import type { HypurrscanTwapRow, NormalizedTwapSignal, TwapSide } from './types.js';

export function normalizeHypurrscanRow(
  row: HypurrscanTwapRow,
  cache: HyperliquidMarketCache,
): NormalizedTwapSignal | null {
  const tw = row.action?.twap;
  if (!tw || row.action.type !== 'twapOrder') return null;

  const size = Number(tw.s);
  if (!Number.isFinite(size) || size <= 0) return null;

  const market = resolveTwapMarket(tw.a, cache);
  const midPx = market.midPx > 0 ? market.midPx : 0;
  const notionalUsd = midPx > 0 ? size * midPx : 0;
  const volumeSharePct =
    market.dayNtlVlmUsd != null && market.dayNtlVlmUsd > 0 && notionalUsd > 0
      ? (notionalUsd / market.dayNtlVlmUsd) * 100
      : null;

  const side: TwapSide = tw.b ? 'buy' : 'sell';

  return {
    hash: row.hash,
    twapId: null,
    user: row.user.toLowerCase(),
    side,
    coin: market.coin,
    displaySymbol: market.displaySymbol,
    isSpot: market.isSpot,
    size,
    minutes: tw.m,
    randomize: tw.t,
    reduceOnly: tw.r,
    notionalUsd,
    midPx,
    dayNtlVlmUsd: market.dayNtlVlmUsd,
    volumeSharePct,
    startedAtMs: row.time,
    block: row.block,
    ended: row.ended ?? null,
  };
}
