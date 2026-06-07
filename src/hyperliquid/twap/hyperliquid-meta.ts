import type { ResolvedTwapMarket } from './types.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';

type PerpUniverseEntry = { name: string; szDecimals?: number; isDelisted?: boolean };
type PerpMeta = { universe: PerpUniverseEntry[] };
type SpotUniverseEntry = { name: string; index: number; tokens: number[]; isCanonical?: boolean };
type SpotMeta = { universe: SpotUniverseEntry[] };
type AssetCtx = {
  markPx?: string;
  midPx?: string;
  dayNtlVlm?: string;
};

export type HyperliquidMarketCache = {
  perpNames: string[];
  spotByAssetId: Map<number, string>;
  mids: Map<string, number>;
  perpCtxByIndex: Map<number, AssetCtx>;
  loadedAtMs: number;
};

function num(v: string | number | undefined | null): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function loadHyperliquidMarketCache(): Promise<HyperliquidMarketCache> {
  const [meta, spotMeta, midsRaw, ctxs] = await Promise.all([
    postInfo<PerpMeta>({ type: 'meta' }),
    postInfo<SpotMeta>({ type: 'spotMeta' }),
    postInfo<Record<string, string>>({ type: 'allMids' }),
    postInfo<[PerpMeta, AssetCtx[]]>({ type: 'metaAndAssetCtxs' }),
  ]);

  const perpNames = meta.universe.map((u) => u.name);
  const spotByAssetId = new Map<number, string>();
  for (const u of spotMeta.universe) {
    spotByAssetId.set(10_000 + u.index, u.name);
  }

  const mids = new Map<string, number>();
  for (const [k, v] of Object.entries(midsRaw)) {
    const px = num(v);
    if (px != null) mids.set(k, px);
  }

  const perpCtxByIndex = new Map<number, AssetCtx>();
  const ctxArr = ctxs[1] ?? [];
  for (let i = 0; i < ctxArr.length; i++) perpCtxByIndex.set(i, ctxArr[i]!);

  return {
    perpNames,
    spotByAssetId,
    mids,
    perpCtxByIndex,
    loadedAtMs: Date.now(),
  };
}

async function postInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`hyperliquid info ${body.type}: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function resolveTwapMarket(assetId: number, cache: HyperliquidMarketCache): ResolvedTwapMarket {
  const isSpot = assetId >= 10_000;
  let coin: string;
  if (isSpot) {
    coin = cache.spotByAssetId.get(assetId) ?? `@${assetId - 10_000}`;
  } else {
    coin = cache.perpNames[assetId] ?? `asset:${assetId}`;
  }

  const displaySymbol = displaySymbolFromCoin(coin);
  const midFromMids = cache.mids.get(coin) ?? cache.mids.get(displaySymbol);
  let midPx = midFromMids ?? 0;
  let dayNtlVlmUsd: number | null = null;

  if (!isSpot) {
    const ctx = cache.perpCtxByIndex.get(assetId);
    if (ctx) {
      const ctxMid = num(ctx.midPx) ?? num(ctx.markPx);
      if (ctxMid != null) midPx = ctxMid;
      dayNtlVlmUsd = num(ctx.dayNtlVlm);
    }
  }

  if (!midPx) {
    const alt = cache.mids.get(displaySymbol);
    if (alt != null) midPx = alt;
  }

  return { coin, displaySymbol, isSpot, assetId, midPx, dayNtlVlmUsd };
}

export type HlExchangePosition = {
  coin: string;
  displaySymbol: string;
  side: 'buy' | 'sell';
  size: number;
  entryPx: number;
  notionalUsd: number;
  unrealizedPnlUsd: number;
};

export type HlAccountMargin = {
  accountValueUsd: number;
  totalMarginUsedUsd: number;
  withdrawableUsd: number;
};

/** Cross-margin summary from clearinghouse (live wallet). */
export async function fetchHlClearinghouseMargin(user: string): Promise<HlAccountMargin> {
  const st = await postInfo<{
    marginSummary?: Record<string, string | number>;
    withdrawable?: string | number;
  }>({ type: 'clearinghouseState', user });
  const ms = st.marginSummary ?? {};
  return {
    accountValueUsd: num(ms.accountValue) ?? 0,
    totalMarginUsedUsd: num(ms.totalMarginUsed) ?? 0,
    withdrawableUsd: num(st.withdrawable) ?? 0,
  };
}

/** Live perp positions from Hyperliquid clearinghouse (source of truth for wallet). */
export async function fetchHlClearinghousePositions(user: string): Promise<HlExchangePosition[]> {
  const st = await postInfo<{
    assetPositions?: Array<{ position?: Record<string, string | number> }>;
  }>({ type: 'clearinghouseState', user });
  const out: HlExchangePosition[] = [];
  for (const row of st.assetPositions ?? []) {
    const p = row.position ?? {};
    const szi = num(p.szi) ?? 0;
    if (Math.abs(szi) <= 0) continue;
    const coin = String(p.coin ?? '');
    if (!coin) continue;
    const entryPx = num(p.entryPx) ?? 0;
    const notionalUsd = num(p.positionValue) ?? 0;
    const unrealizedPnlUsd = num(p.unrealizedPnl) ?? 0;
    out.push({
      coin,
      displaySymbol: displaySymbolFromCoin(coin),
      side: szi > 0 ? 'buy' : 'sell',
      size: Math.abs(szi),
      entryPx,
      notionalUsd,
      unrealizedPnlUsd,
    });
  }
  out.sort((a, b) => b.notionalUsd - a.notionalUsd);
  return out;
}

/** Signed perp size (base units) for one coin; 0 if flat. */
export async function fetchHlPerpPositionSzi(user: string, coin: string): Promise<number> {
  const st = await postInfo<{
    assetPositions?: Array<{ position?: Record<string, string | number> }>;
  }>({ type: 'clearinghouseState', user });
  for (const row of st.assetPositions ?? []) {
    const p = row.position ?? {};
    if (String(p.coin ?? '') === coin) return num(p.szi) ?? 0;
  }
  return 0;
}

/** Strip HIP-3 dex prefix and spot @index for human-readable tickers. */
export function displaySymbolFromCoin(coin: string): string {
  const c = coin.trim();
  if (!c) return '?';
  if (c.startsWith('@')) return c.slice(1) || c;
  const colon = c.indexOf(':');
  if (colon > 0) return c.slice(colon + 1);
  return c;
}
