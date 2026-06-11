import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { formatPrice, formatSize, SymbolConverter } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchHlPerpPositionSzi } from '../hyperliquid-meta.js';
import type { HlTwapLiveConfig } from './config.js';
import { wrapWithExecSlices } from './exec-slice.js';
import { appendLiveJournal, journalOrderRow } from './journal.js';
import {
  parseHlOrderStatus,
  reconcileOrderFill,
} from './parse-order-fill.js';
import type { HlTwapExchangeClient, MarketOrderParams, OrderFillResult } from './types.js';

export class HyperliquidExchangeClient implements HlTwapExchangeClient {
  readonly mode = 'live' as const;

  private exchange!: ExchangeClient;
  private converter!: SymbolConverter;
  private maxLeverageByCoin = new Map<string, number>();
  private leverageSet = new Set<string>();

  constructor(private readonly cfg: HlTwapLiveConfig) {
    if (!cfg.privateKey) {
      throw new Error('HL_TWAP_LIVE_PRIVATE_KEY required for live mode');
    }
  }

  async init(): Promise<void> {
    const transport = new HttpTransport({ isTestnet: this.cfg.testnet });
    const wallet = privateKeyToAccount(
      this.cfg.privateKey!.startsWith('0x')
        ? (this.cfg.privateKey as `0x${string}`)
        : (`0x${this.cfg.privateKey}` as `0x${string}`),
    );
    this.exchange = new ExchangeClient({ transport, wallet });
    this.converter = await SymbolConverter.create({ transport });

    const info = new InfoClient({ transport });
    const meta = await info.meta({});
    for (const asset of meta.universe) {
      if (asset.name && asset.maxLeverage > 0) {
        this.maxLeverageByCoin.set(asset.name, asset.maxLeverage);
      }
    }
  }

  leverageForCoin(coin: string): number {
    const max = this.maxLeverageByCoin.get(coin);
    const requested = this.cfg.leverage;
    if (max == null) return requested;
    return Math.min(requested, max);
  }

  /** Gross position USD for a new open (margin × effective leverage). */
  private openPositionNotionalUsd(coin: string, marginUsd: number): number {
    return marginUsd * this.leverageForCoin(coin);
  }

  accountAddress(): string {
    return this.cfg.masterAddress;
  }

  async getPositionSzi(coin: string): Promise<number> {
    return fetchHlPerpPositionSzi(this.cfg.masterAddress, coin);
  }

  async marketOrder(params: MarketOrderParams): Promise<OrderFillResult> {
    const assetId = this.converter.getAssetId(params.coin);
    if (assetId == null) {
      throw new Error(`unknown HL asset: ${params.coin}`);
    }
    const szDecimals = this.converter.getSzDecimals(params.coin);
    if (szDecimals == null) {
      throw new Error(`no szDecimals for ${params.coin}`);
    }

    if (!this.leverageSet.has(params.coin)) {
      const leverage = this.leverageForCoin(params.coin);
      await this.exchange.updateLeverage({
        asset: assetId,
        isCross: true,
        leverage,
      });
      this.leverageSet.add(params.coin);
      const max = this.maxLeverageByCoin.get(params.coin);
      if (max != null && leverage < this.cfg.leverage) {
        console.log(
          `[hl-twap-live] leverage ${params.displaySymbol} ${leverage}x (HL max ${max}x, requested ${this.cfg.leverage}x)`,
        );
      }
    }

    const isBuy = params.side === 'buy';
    const leverage = this.leverageForCoin(params.coin);
    const marginUsd = params.intent === 'open' ? params.notionalUsd : undefined;
    const orderUsd =
      params.intent === 'open'
        ? this.openPositionNotionalUsd(params.coin, params.notionalUsd)
        : params.notionalUsd;
    const requestedBase =
      params.sizeBase != null && params.sizeBase > 0 ? params.sizeBase : orderUsd / params.markPx;
    const aggressivePx =
      params.markPx * (1 + (isBuy ? this.cfg.slippageTolerance : -this.cfg.slippageTolerance));
    const p = formatPrice(aggressivePx, szDecimals);
    const s = formatSize(requestedBase, szDecimals);

    const sziBefore = await this.getPositionSzi(params.coin);

    const result = await this.exchange.order({
      orders: [
        {
          a: assetId,
          b: isBuy,
          p,
          s,
          r: params.reduceOnly,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    });

    const sziAfter = await this.getPositionSzi(params.coin);
    const status = parseHlOrderStatus(result);
    if (status?.kind === 'error') {
      throw new Error(`HL order rejected: ${status.message}`);
    }

    const parsedFill = status?.kind === 'filled' ? status.fill : null;
    const { sizeBase, fillPx, partialFill } = reconcileOrderFill({
      parsed: parsedFill,
      sziBefore,
      sziAfter,
      side: params.side,
      reduceOnly: params.reduceOnly,
      markPx: params.markPx,
      requestedBase,
    });

    const filledNotionalUsd = sizeBase * fillPx;
    const actualMarginUsd =
      params.intent === 'open' && leverage > 0 ? filledNotionalUsd / leverage : undefined;

    const row = journalOrderRow(params.intent, {
      coin: params.coin,
      side: params.side,
      notionalUsd: filledNotionalUsd,
      markPx: params.markPx,
      reduceOnly: params.reduceOnly,
      mode: 'live',
      fillPx,
      sizeBase,
    });
    appendLiveJournal(this.cfg.journalPath, row);

    const levNote =
      params.intent === 'open' ? ` margin $${(actualMarginUsd ?? params.notionalUsd).toFixed(0)} · ${leverage}x` : '';
    const partialNote = partialFill
      ? ` PARTIAL req $${orderUsd.toFixed(0)} got $${filledNotionalUsd.toFixed(0)}`
      : '';
    console.log(
      `[hl-twap-live] order ${params.side} ${params.displaySymbol} $${filledNotionalUsd.toFixed(2)}${levNote}${partialNote} status=${JSON.stringify(result?.status ?? result).slice(0, 120)}`,
    );

    return {
      fillPx,
      sizeBase,
      notionalUsd: filledNotionalUsd,
      marginUsd: actualMarginUsd ?? marginUsd,
      leverage: params.intent === 'open' ? leverage : undefined,
      requestedNotionalUsd: orderUsd,
      partialFill,
    };
  }
}

export function createHyperliquidClient(cfg: HlTwapLiveConfig): HlTwapExchangeClient {
  return wrapWithExecSlices(new HyperliquidExchangeClient(cfg), cfg);
}
