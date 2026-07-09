/**
 * Hot-tick sell probe anchors — independent price sources for ghost-quote cross-check.
 * Shyft is optional; PG / Dex / lastObserved must carry the gate without it.
 */
import type { PaperTraderConfig } from '../papertrader/config.js';
import type { OpenTrade } from '../papertrader/types.js';
import { fetchLatestSnapshotQuote } from '../papertrader/pricing.js';
import { resolveDiscoveryMarketQuote } from '../papertrader/pricing/discovery-market-quote.js';
import { getShyftShadowStreamPrice } from '../papertrader/stream/shadow-state.js';
import type { LiveHotTickAnchorCheck, LiveHotTickPriceAnchor } from './sell-price-sanity.js';

function pushAnchor(
  anchors: LiveHotTickPriceAnchor[],
  kind: LiveHotTickPriceAnchor['kind'],
  priceUsd: number | null | undefined,
): void {
  if (priceUsd == null || !(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
  anchors.push({ kind, priceUsd });
}

export function collectStaticHotTickAnchors(args: {
  lastObservedPriceUsd?: number | null;
  avgEntryMarket?: number;
  avgEntry?: number;
  shyftStreamRefUsd?: number | null;
}): LiveHotTickPriceAnchor[] {
  const anchors: LiveHotTickPriceAnchor[] = [];
  pushAnchor(anchors, 'observed', args.lastObservedPriceUsd);
  pushAnchor(anchors, 'entry_market', args.avgEntryMarket);
  pushAnchor(anchors, 'entry_avg', args.avgEntry);
  pushAnchor(anchors, 'shyft', args.shyftStreamRefUsd);
  return anchors;
}

export function collectTrackerHotTickAnchors(args: {
  lastObservedPriceUsd?: number | null;
  avgEntryMarket?: number;
  avgEntry?: number;
  tickMtmUsd?: number | null;
  shyftStreamRefUsd?: number | null;
}): LiveHotTickPriceAnchor[] {
  const anchors = collectStaticHotTickAnchors(args);
  pushAnchor(anchors, 'tick_mtm', args.tickMtmUsd);
  return anchors;
}

export async function appendExternalHotTickAnchors(args: {
  anchors: LiveHotTickPriceAnchor[];
  mint: string;
  ot: OpenTrade;
  paperCfg: PaperTraderConfig;
}): Promise<void> {
  const { anchors, mint, ot, paperCfg } = args;
  let snapPx = 0;
  let snapVol5m: number | null = null;
  let snapTsMs: number | null = null;
  try {
    const quote = await fetchLatestSnapshotQuote(
      mint,
      ot.source as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
    );
    snapPx = Number(quote.priceUsd ?? 0);
    snapVol5m = quote.volume5mUsd;
    snapTsMs = quote.snapshotTsMs ?? null;
    pushAnchor(anchors, 'pg_snapshot', snapPx);
  } catch {
    /* best-effort */
  }

  try {
    const mtmQuote = await resolveDiscoveryMarketQuote({
      enabled: paperCfg.birdeyePrimaryEnabled,
      mint,
      pgRow: {
        mint,
        symbol: ot.symbol ?? mint.slice(0, 8),
        ts: snapTsMs != null ? new Date(snapTsMs) : new Date(),
        launch_ts: null,
        age_min: null,
        price_usd: snapPx > 0 ? snapPx : 0,
        liquidity_usd: 0,
        volume_5m: snapVol5m ?? 0,
        volume_1h: 0,
        buys_5m: 0,
        sells_5m: 0,
        market_cap_usd: null,
        source: ot.source ?? 'pumpswap',
        holder_count: 0,
        token_age_min: 0,
        pair_address: ot.pairAddress ?? null,
      },
      birdeyeTtlMs: paperCfg.birdeyeMarketTtlMs,
      birdeyeMaxStaleMs: paperCfg.birdeyeMaxStaleMs,
      coverageGapMinMs: paperCfg.birdeyeCoverageGapMinMs,
    });
    if (
      (mtmQuote.source === 'birdeye' || mtmQuote.source === 'dexscreener') &&
      mtmQuote.priceUsd != null &&
      mtmQuote.priceUsd > 0
    ) {
      pushAnchor(anchors, 'dex_quote', mtmQuote.priceUsd);
    }
  } catch {
    /* best-effort */
  }
}

export async function buildHotTickPriceAnchors(args: {
  mint: string;
  ot: OpenTrade;
  paperCfg: PaperTraderConfig;
}): Promise<LiveHotTickPriceAnchor[]> {
  const shyftStream = getShyftShadowStreamPrice(args.mint);
  const anchors = collectStaticHotTickAnchors({
    lastObservedPriceUsd: args.ot.lastObservedPriceUsd,
    avgEntryMarket: args.ot.avgEntryMarket,
    avgEntry: args.ot.avgEntry,
    shyftStreamRefUsd: shyftStream?.priceUsd ?? null,
  });
  await appendExternalHotTickAnchors({
    anchors,
    mint: args.mint,
    ot: args.ot,
    paperCfg: args.paperCfg,
  });
  return anchors;
}

export function summarizeHotTickAnchorChecks(checks: LiveHotTickAnchorCheck[]): {
  observedRefUsd: number | null;
  shyftRefUsd: number | null;
  pgRefUsd: number | null;
  dexRefUsd: number | null;
} {
  const pick = (kind: LiveHotTickPriceAnchor['kind']) =>
    checks.find((c) => c.kind === kind)?.priceUsd ?? null;
  return {
    observedRefUsd: pick('observed'),
    shyftRefUsd: pick('shyft'),
    pgRefUsd: pick('pg_snapshot'),
    dexRefUsd: pick('dex_quote'),
  };
}
