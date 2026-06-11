import type { HlTwapLiveConfig } from './config.js';
import type { DryRunExchangeClient } from './exchange-dry-run.js';
import type {
  HlTwapExchangeClient,
  MarketOrderIntent,
  MarketOrderParams,
  OrderFillResult,
} from './types.js';

/** Split gross order notional into max-chunk USD pieces + remainder (≤ chunk). */
export function splitExecNotional(totalUsd: number, maxChunkUsd: number): number[] {
  if (totalUsd <= 0 || maxChunkUsd <= 0) return totalUsd > 0 ? [totalUsd] : [];
  if (totalUsd <= maxChunkUsd + 1e-9) return [totalUsd];
  const parts: number[] = [];
  let rem = totalUsd;
  while (rem > maxChunkUsd + 1e-9) {
    parts.push(maxChunkUsd);
    rem -= maxChunkUsd;
  }
  if (rem > 1e-9) parts.push(rem);
  return parts;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function orderGrossUsd(params: MarketOrderParams, leverage: number): number {
  if (params.sizeBase != null && params.sizeBase > 0) {
    return params.sizeBase * params.markPx;
  }
  if (params.intent === 'open') {
    return params.notionalUsd * leverage;
  }
  return params.notionalUsd;
}

function splitSizeBase(totalBase: number, markPx: number, maxChunkUsd: number): number[] {
  const grossParts = splitExecNotional(totalBase * markPx, maxChunkUsd);
  const bases: number[] = [];
  let rem = totalBase;
  for (let i = 0; i < grossParts.length; i++) {
    const isLast = i === grossParts.length - 1;
    const sliceBase = isLast ? rem : grossParts[i] / markPx;
    bases.push(sliceBase);
    rem -= sliceBase;
  }
  return bases;
}

function buildSliceParams(
  params: MarketOrderParams,
  partGrossUsd: number,
  partSizeBase: number | undefined,
  leverage: number,
): MarketOrderParams {
  if (params.intent === 'open') {
    return { ...params, notionalUsd: partGrossUsd / leverage, sizeBase: undefined };
  }
  if (partSizeBase != null && partSizeBase > 0) {
    return { ...params, notionalUsd: partGrossUsd, sizeBase: partSizeBase };
  }
  return { ...params, notionalUsd: partGrossUsd, sizeBase: undefined };
}

/** VWAP aggregate for multi-slice market orders. */
export function aggregateOrderFills(
  fills: OrderFillResult[],
  requestedGrossUsd: number,
  intent: MarketOrderIntent,
): OrderFillResult {
  if (fills.length === 0) {
    throw new Error('aggregateOrderFills: empty fills');
  }
  if (fills.length === 1) return fills[0]!;

  const notionalUsd = fills.reduce((s, f) => s + f.notionalUsd, 0);
  const sizeBase = fills.reduce((s, f) => s + f.sizeBase, 0);
  const fillPx = sizeBase > 0 ? notionalUsd / sizeBase : fills[fills.length - 1]!.fillPx;
  const marginUsd =
    intent === 'open' ? fills.reduce((s, f) => s + (f.marginUsd ?? 0), 0) : undefined;
  const leverage = fills.find((f) => f.leverage != null)?.leverage;
  const partialFill =
    fills.some((f) => f.partialFill) || notionalUsd < requestedGrossUsd * 0.95 - 1e-6;

  return {
    fillPx,
    sizeBase,
    notionalUsd,
    marginUsd,
    leverage: intent === 'open' ? leverage : undefined,
    requestedNotionalUsd: requestedGrossUsd,
    partialFill,
  };
}

export async function executeSlicedMarketOrder(
  inner: HlTwapExchangeClient,
  params: MarketOrderParams,
  cfg: HlTwapLiveConfig,
): Promise<OrderFillResult> {
  const maxChunk = cfg.execSliceUsd;
  if (maxChunk <= 0) {
    return inner.marketOrder(params);
  }

  const leverage = inner.leverageForCoin(params.coin);
  const grossUsd = orderGrossUsd(params, leverage);
  const parts = splitExecNotional(grossUsd, maxChunk);
  if (parts.length <= 1) {
    return inner.marketOrder(params);
  }

  const sizeBases =
    params.sizeBase != null && params.sizeBase > 0
      ? splitSizeBase(params.sizeBase, params.markPx, maxChunk)
      : undefined;

  const fills: OrderFillResult[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0 && cfg.execSliceGapMs > 0) {
      await sleep(cfg.execSliceGapMs);
    }
    const sliceParams = buildSliceParams(params, parts[i]!, sizeBases?.[i], leverage);
    fills.push(await inner.marketOrder(sliceParams));
  }

  const agg = aggregateOrderFills(fills, grossUsd, params.intent);
  console.log(
    `[hl-twap-live] exec ${parts.length}×≤$${maxChunk}/${cfg.execSliceGapMs}ms ${params.intent} ${params.displaySymbol} total $${agg.notionalUsd.toFixed(2)}`,
  );
  return agg;
}

/** Wrap exchange client so every marketOrder splits into ≤ execSliceUsd chunks. */
export class ExecSlicedExchangeClient implements HlTwapExchangeClient {
  readonly mode;

  constructor(
    private readonly inner: HlTwapExchangeClient,
    private readonly cfg: HlTwapLiveConfig,
  ) {
    this.mode = inner.mode;
  }

  async init(): Promise<void> {
    await this.inner.init();
  }

  accountAddress(): string {
    return this.inner.accountAddress();
  }

  async getPositionSzi(coin: string): Promise<number> {
    return this.inner.getPositionSzi(coin);
  }

  leverageForCoin(coin: string): number {
    return this.inner.leverageForCoin(coin);
  }

  async marketOrder(params: MarketOrderParams): Promise<OrderFillResult> {
    return executeSlicedMarketOrder(this.inner, params, this.cfg);
  }

  /** Forward dry-run test helper when present on inner client. */
  seedPosition(coin: string, signedSzi: number): void {
    const dry = this.inner as DryRunExchangeClient;
    dry.seedPosition(coin, signedSzi);
  }
}

export function wrapWithExecSlices(
  inner: HlTwapExchangeClient,
  cfg: HlTwapLiveConfig,
): HlTwapExchangeClient {
  if (cfg.execSliceUsd <= 0) return inner;
  return new ExecSlicedExchangeClient(inner, cfg);
}
