import type { ResolvedTwapMarket } from './types.js';

const HL_INFO = 'https://api.hyperliquid.xyz/info';

type PerpUniverseEntry = { name: string; szDecimals?: number; isDelisted?: boolean; maxLeverage?: number };
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
  /** HL perp max cross leverage by coin name. */
  maxLeverageByCoin: Map<string, number>;
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
  const maxLeverageByCoin = new Map<string, number>();
  for (const asset of meta.universe) {
    if (asset.name && asset.maxLeverage != null && asset.maxLeverage > 0) {
      maxLeverageByCoin.set(asset.name, asset.maxLeverage);
    }
  }
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
    maxLeverageByCoin,
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
  /** Perp `marginSummary.accountValue` (includes uPnL when populated). */
  perpAccountValueUsd?: number;
  totalMarginUsedUsd: number;
  withdrawableUsd: number;
  /** USDC total from spot clearinghouse (unified account source of truth). */
  spotUsdcTotalUsd?: number;
  /** USDC on hold from spot clearinghouse. */
  spotUsdcHoldUsd?: number;
};

export type HlSpotUsdcBalance = {
  totalUsd: number;
  holdUsd: number;
  freeUsd: number;
};

/** USDC balance from spot clearinghouse — canonical for unified HL accounts. */
export function parseSpotUsdcBalance(spotSt: {
  balances?: Array<{ coin?: string; total?: string | number; hold?: string | number }>;
}): HlSpotUsdcBalance {
  for (const b of spotSt.balances ?? []) {
    if (b.coin !== 'USDC') continue;
    const totalUsd = num(b.total) ?? 0;
    const holdUsd = num(b.hold) ?? 0;
    return {
      totalUsd,
      holdUsd,
      freeUsd: Math.max(0, totalUsd - holdUsd),
    };
  }
  return { totalUsd: 0, holdUsd: 0, freeUsd: 0 };
}

/**
 * Cross-margin summary for live wallet.
 * Unified HL accounts: USDC lives in spotClearinghouseState; perp marginSummary.accountValue is often 0.
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes
 */
export async function fetchHlClearinghouseMargin(user: string): Promise<HlAccountMargin> {
  const [perpSt, spotSt] = await Promise.all([
    postInfo<{
      marginSummary?: Record<string, string | number>;
      withdrawable?: string | number;
    }>({ type: 'clearinghouseState', user }),
    postInfo<{
      balances?: Array<{ coin?: string; total?: string | number; hold?: string | number }>;
    }>({ type: 'spotClearinghouseState', user }),
  ]);

  const ms = perpSt.marginSummary ?? {};
  const perpAccountValueUsd = num(ms.accountValue) ?? 0;
  const totalMarginUsedUsd = num(ms.totalMarginUsed) ?? 0;
  const perpWithdrawableUsd = num(perpSt.withdrawable) ?? 0;

  const spotUsdc = parseSpotUsdcBalance(spotSt);
  const accountValueUsd =
    spotUsdc.totalUsd > 0 ? spotUsdc.totalUsd : perpAccountValueUsd;
  // Unified account: free USDC is spot (total−hold); perp withdrawable is often 0.
  const withdrawableUsd = Math.max(perpWithdrawableUsd, spotUsdc.freeUsd);

  return {
    accountValueUsd,
    perpAccountValueUsd: perpAccountValueUsd,
    totalMarginUsedUsd,
    withdrawableUsd,
    spotUsdcTotalUsd: spotUsdc.totalUsd,
    spotUsdcHoldUsd: spotUsdc.holdUsd,
  };
}

/**
 * Total account equity including unrealized PnL (drawdown / risk monitoring).
 * Matches HL UI "Total Balance" on unified accounts: spot USDC + Σ uPnL.
 * Perp-only accounts fall back to marginSummary.accountValue.
 */
export function resolveAccountEquityUsd(
  margin: Pick<HlAccountMargin, 'accountValueUsd' | 'perpAccountValueUsd' | 'spotUsdcTotalUsd'>,
  positions: Array<{ unrealizedPnlUsd: number }>,
): number {
  const spot = margin.spotUsdcTotalUsd ?? 0;
  if (spot > 0) {
    const uPnl = positions.reduce((s, p) => s + p.unrealizedPnlUsd, 0);
    return spot + uPnl;
  }
  const perpAv = margin.perpAccountValueUsd ?? 0;
  if (perpAv > 0) return perpAv;
  return margin.accountValueUsd;
}

/** Fetch total equity (collateral + uPnL) for drawdown monitoring. */
export async function fetchHlAccountEquityUsd(user: string): Promise<number> {
  const [margin, positions] = await Promise.all([
    fetchHlClearinghouseMargin(user),
    fetchHlClearinghousePositions(user),
  ]);
  return resolveAccountEquityUsd(margin, positions);
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

export type HlUserFill = {
  coin: string;
  px: number;
  sz: number;
  /** `B` = buy, `A` = ask/sell (close long). */
  side: 'B' | 'A';
  closedPnl: number;
  time: number;
};

/** User fills since `startTimeMs` (HL `userFillsByTime`). */
export async function fetchHlUserFillsByTime(user: string, startTimeMs: number): Promise<HlUserFill[]> {
  const raw = await postInfo<Array<Record<string, string | number>>>({
    type: 'userFillsByTime',
    user,
    startTime: startTimeMs,
  });
  const out: HlUserFill[] = [];
  for (const row of raw ?? []) {
    const coin = String(row.coin ?? '');
    if (!coin) continue;
    const px = num(row.px) ?? 0;
    const sz = num(row.sz) ?? 0;
    const side = String(row.side ?? '') === 'A' ? 'A' : 'B';
    const closedPnl = num(row.closedPnl) ?? 0;
    const time = num(row.time) ?? 0;
    out.push({ coin, px, sz, side, closedPnl, time });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Sum `closedPnl` for one coin (partials + final close). */
export function sumHlCoinClosedPnl(fills: HlUserFill[], coin: string): number {
  return fills.filter((f) => f.coin === coin).reduce((s, f) => s + f.closedPnl, 0);
}

/** Last sell fill price for a coin, if any. */
export function lastHlCoinSellPx(fills: HlUserFill[], coin: string): number | null {
  const sells = fills.filter((f) => f.coin === coin && f.side === 'A');
  if (sells.length === 0) return null;
  return sells[sells.length - 1]!.px;
}

/** Realized PnL on HL for a coin since entry (includes partial closes). */
export async function fetchHlCoinRealizedPnlSince(
  user: string,
  coin: string,
  sinceMs: number,
): Promise<{ pnlUsd: number; exitPx: number | null }> {
  const fills = await fetchHlUserFillsByTime(user, sinceMs);
  return {
    pnlUsd: sumHlCoinClosedPnl(fills, coin),
    exitPx: lastHlCoinSellPx(fills, coin),
  };
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
