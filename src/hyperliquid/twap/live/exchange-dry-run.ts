import type { HlTwapLiveConfig } from './config.js';
import {
  appendLiveJournal,
  journalOrderRow,
  type LiveJournalRow,
} from './journal.js';
import type { HlTwapExchangeClient, MarketOrderParams, OrderFillResult } from './types.js';

export class DryRunExchangeClient implements HlTwapExchangeClient {
  readonly mode = 'dry_run' as const;

  constructor(
    private readonly cfg: HlTwapLiveConfig,
    private readonly onJournal?: (row: LiveJournalRow) => void,
  ) {}

  async init(): Promise<void> {
    /* no-op */
  }

  async marketOrder(params: MarketOrderParams): Promise<OrderFillResult> {
    const fillPx = params.markPx;
    const leverage = this.cfg.leverage;
    const orderUsd =
      params.intent === 'open' ? params.notionalUsd * leverage : params.notionalUsd;
    const sizeBase = orderUsd / fillPx;
    const row = journalOrderRow(params.intent, {
        coin: params.coin,
        side: params.side,
        notionalUsd: orderUsd,
        markPx: params.markPx,
        reduceOnly: params.reduceOnly,
        mode: 'dry_run',
        fillPx,
        sizeBase,
      },
    );
    appendLiveJournal(this.cfg.journalPath, row);
    this.onJournal?.(row);

    console.log(
      `[hl-twap-live:DRY] ${params.reduceOnly ? 'reduce' : 'open'} ${params.side} ${params.displaySymbol} $${orderUsd.toFixed(2)} @ ${fillPx.toFixed(4)}`,
    );

    return {
      fillPx,
      sizeBase,
      notionalUsd: orderUsd,
      marginUsd: params.intent === 'open' ? params.notionalUsd : undefined,
      leverage: params.intent === 'open' ? leverage : undefined,
    };
  }
}

export function createDryRunClient(cfg: HlTwapLiveConfig): DryRunExchangeClient {
  return new DryRunExchangeClient(cfg);
}
