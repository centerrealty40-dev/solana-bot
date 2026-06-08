import { displaySymbolFromCoin, resolveTwapMarket, type HyperliquidMarketCache } from './hyperliquid-meta.js';
import type { HlWsTwapOpenEvent } from './hl-ws-types.js';
import type { NormalizedTwapSignal } from './types.js';

/** Stable local hash for WS-first TWAP (before HypurrScan tx hash arrives). */
export function wsLocalTwapHash(syntheticId: string): string {
  return `ws:${syntheticId}`;
}

export function resolveTwapMarketByCoin(coin: string, cache: HyperliquidMarketCache) {
  const raw = coin.trim();
  let perpIndex = cache.perpNames.indexOf(raw);
  if (perpIndex < 0) {
    const sym = displaySymbolFromCoin(raw);
    perpIndex = cache.perpNames.findIndex((n) => displaySymbolFromCoin(n) === sym);
  }
  if (perpIndex >= 0) return resolveTwapMarket(perpIndex, cache);

  for (const [assetId, name] of cache.spotByAssetId) {
    if (name === raw || displaySymbolFromCoin(name) === displaySymbolFromCoin(raw)) {
      return resolveTwapMarket(assetId, cache);
    }
  }

  const displaySymbol = displaySymbolFromCoin(raw);
  const midPx = cache.mids.get(raw) ?? cache.mids.get(displaySymbol) ?? 0;
  return {
    coin: raw,
    displaySymbol,
    isSpot: raw.startsWith('@'),
    assetId: -1,
    midPx,
    dayNtlVlmUsd: null as number | null,
  };
}

export function normalizeHlWsTwap(
  ev: HlWsTwapOpenEvent,
  cache: HyperliquidMarketCache,
): NormalizedTwapSignal | null {
  const market = resolveTwapMarketByCoin(ev.coin, cache);
  const midPx = market.midPx > 0 ? market.midPx : 0;
  const notionalUsd = midPx > 0 ? ev.size * midPx : 0;
  const volumeSharePct =
    market.dayNtlVlmUsd != null && market.dayNtlVlmUsd > 0 && notionalUsd > 0
      ? (notionalUsd / market.dayNtlVlmUsd) * 100
      : null;

  return {
    hash: wsLocalTwapHash(ev.syntheticId),
    twapId: ev.twapId,
    user: ev.user.toLowerCase(),
    side: ev.side,
    coin: market.coin,
    displaySymbol: market.displaySymbol,
    isSpot: market.isSpot,
    size: ev.size,
    minutes: ev.minutes,
    randomize: ev.randomize,
    reduceOnly: ev.reduceOnly,
    notionalUsd,
    midPx,
    dayNtlVlmUsd: market.dayNtlVlmUsd,
    volumeSharePct,
    startedAtMs: ev.startedAtMs,
    block: 0,
    ended: null,
  };
}
