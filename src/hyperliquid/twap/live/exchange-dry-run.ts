import type { HlTwapLiveConfig } from './config.js';
import {
  appendLiveJournal,
  journalOrderRow,
  type LiveJournalRow,
} from './journal.js';
import type { HlTwapExchangeClient, MarketOrderParams, OrderFillResult } from './types.js';

export class DryRunExchangeClient implements HlTwapExchangeClient {
  readonly mode = 'dry_run' as const;

  /** coin → signed base size (simulated clearinghouse). */
  private positions = new Map<string, number>();

  constructor(
    private readonly cfg: HlTwapLiveConfig,
    private readonly onJournal?: (row: LiveJournalRow) => void,
  ) {}

  async init(): Promise<void> {
    /* no-op */
  }

  accountAddress(): string {
    return '0x000000000000000000000000000000000000d001';
  }

  async getPositionSzi(coin: string): Promise<number> {
    return this.positions.get(coin) ?? 0;
  }

  /** Test helper: seed simulated exchange position. */
  seedPosition(coin: string, signedSzi: number): void {
    if (Math.abs(signedSzi) <= 0) this.positions.delete(coin);
    else this.positions.set(coin, signedSzi);
  }

  async marketOrder(params: MarketOrderParams): Promise<OrderFillResult> {
    const fillPx = params.markPx;
    const leverage = this.cfg.leverage;
    const orderUsd =
      params.intent === 'open' ? params.notionalUsd * leverage : params.notionalUsd;
    const sizeBase =
      params.sizeBase != null && params.sizeBase > 0 ? params.sizeBase : orderUsd / fillPx;

    this.applySimulatedFill(params.coin, params.side, sizeBase, params.reduceOnly);

    const row = journalOrderRow(params.intent, {
      coin: params.coin,
      side: params.side,
      notionalUsd: params.sizeBase != null ? sizeBase * fillPx : orderUsd,
      markPx: params.markPx,
      reduceOnly: params.reduceOnly,
      mode: 'dry_run',
      fillPx,
      sizeBase,
    });
    appendLiveJournal(this.cfg.journalPath, row);
    this.onJournal?.(row);

    console.log(
      `[hl-twap-live:DRY] ${params.reduceOnly ? 'reduce' : 'open'} ${params.side} ${params.displaySymbol} $${(sizeBase * fillPx).toFixed(2)} @ ${fillPx.toFixed(4)}`,
    );

    return {
      fillPx,
      sizeBase,
      notionalUsd: sizeBase * fillPx,
      marginUsd: params.intent === 'open' ? params.notionalUsd : undefined,
      leverage: params.intent === 'open' ? leverage : undefined,
    };
  }

  private applySimulatedFill(
    coin: string,
    side: MarketOrderParams['side'],
    sizeBase: number,
    reduceOnly: boolean,
  ): void {
    let cur = this.positions.get(coin) ?? 0;
    const delta = side === 'buy' ? sizeBase : -sizeBase;
    if (reduceOnly) {
      if (cur > 0 && side === 'sell') cur = Math.max(0, cur - sizeBase);
      else if (cur < 0 && side === 'buy') cur = Math.min(0, cur + sizeBase);
    } else {
      cur += delta;
    }
    if (Math.abs(cur) <= 1e-12) this.positions.delete(coin);
    else this.positions.set(coin, cur);
  }
}

export function createDryRunClient(cfg: HlTwapLiveConfig): DryRunExchangeClient {
  return new DryRunExchangeClient(cfg);
}
