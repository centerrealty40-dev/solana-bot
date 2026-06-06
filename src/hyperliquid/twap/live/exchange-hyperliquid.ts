import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { formatPrice, formatSize, SymbolConverter } from '@nktkas/hyperliquid/utils';
import { privateKeyToAccount } from 'viem/accounts';

import type { HlTwapLiveConfig } from './config.js';
import { appendLiveJournal, journalOrderRow } from './journal.js';
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

  private leverageForCoin(coin: string): number {
    const max = this.maxLeverageByCoin.get(coin);
    const requested = this.cfg.leverage;
    if (max == null) return requested;
    return Math.min(requested, max);
  }

  /** Gross position USD for a new open (margin × effective leverage). */
  private openPositionNotionalUsd(coin: string, marginUsd: number): number {
    return marginUsd * this.leverageForCoin(coin);
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
    const aggressivePx =
      params.markPx * (1 + (isBuy ? this.cfg.slippageTolerance : -this.cfg.slippageTolerance));
    const sizeBase = orderUsd / params.markPx;
    const p = formatPrice(aggressivePx, szDecimals);
    const s = formatSize(sizeBase, szDecimals);

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

    const fillPx = params.markPx;
    const row = journalOrderRow(params.intent, {
      coin: params.coin,
      side: params.side,
      notionalUsd: orderUsd,
      markPx: params.markPx,
      reduceOnly: params.reduceOnly,
      mode: 'live',
      fillPx,
      sizeBase,
    });
    appendLiveJournal(this.cfg.journalPath, row);

    const levNote =
      params.intent === 'open' ? ` margin $${params.notionalUsd.toFixed(0)} · ${leverage}x` : '';
    console.log(
      `[hl-twap-live] order ${params.side} ${params.displaySymbol} $${orderUsd.toFixed(2)}${levNote} status=${JSON.stringify(result?.status ?? result).slice(0, 120)}`,
    );

    return {
      fillPx,
      sizeBase,
      notionalUsd: orderUsd,
      marginUsd,
      leverage: params.intent === 'open' ? leverage : undefined,
    };
  }
}

export function createHyperliquidClient(cfg: HlTwapLiveConfig): HyperliquidExchangeClient {
  return new HyperliquidExchangeClient(cfg);
}
