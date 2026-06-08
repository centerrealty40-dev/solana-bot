import type { HlTwapExchangeClient, MarketOrderIntent } from './types.js';

const FLATTEN_SLEEP_MS = 400;
const FLATTEN_MAX_ATTEMPTS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reduce-only IOC until flat or attempts exhausted. Uses exchange szi each pass. */
export async function flattenCoinOnExchange(
  client: HlTwapExchangeClient,
  coin: string,
  displaySymbol: string,
  markPx: number,
  intent: MarketOrderIntent | 'residual',
  opts?: { maxBaseSize?: number },
): Promise<{ flat: boolean; remainingAbsSize: number }> {
  if (markPx <= 0) return { flat: false, remainingAbsSize: Number.POSITIVE_INFINITY };

  const orderIntent: MarketOrderIntent = intent === 'residual' ? 'close' : intent;

  for (let attempt = 0; attempt < FLATTEN_MAX_ATTEMPTS; attempt++) {
    const szi = await client.getPositionSzi(coin);
    const absSize = Math.abs(szi);
    if (absSize <= 0) return { flat: true, remainingAbsSize: 0 };

    let closeBase = absSize;
    if (opts?.maxBaseSize != null && opts.maxBaseSize > 0) {
      closeBase = Math.min(closeBase, opts.maxBaseSize);
    }
    const closeSide = szi > 0 ? 'sell' : 'buy';

    try {
      await client.marketOrder({
        coin,
        displaySymbol,
        side: closeSide,
        notionalUsd: closeBase * markPx,
        markPx,
        reduceOnly: true,
        intent: orderIntent,
        sizeBase: closeBase,
      });
    } catch (e) {
      const msg = String(e);
      if (/reduce only|would increase position|position/i.test(msg)) {
        const remaining = Math.abs(await client.getPositionSzi(coin));
        return { flat: remaining <= 0, remainingAbsSize: remaining };
      }
      throw e;
    }

    if (attempt + 1 < FLATTEN_MAX_ATTEMPTS) {
      await sleep(FLATTEN_SLEEP_MS);
    }
  }

  const remaining = Math.abs(await client.getPositionSzi(coin));
  return { flat: remaining <= 0, remainingAbsSize: remaining };
}
