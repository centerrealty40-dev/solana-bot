import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { heliusFetch, HeliusGuardError } from '../core/helius-guard.js';
import { isQuoteMint, QUOTE_MINTS } from '../core/constants.js';
import { getJupPrices } from './jupiter-price.js';
import type { HeliusEnhancedTx } from './normalizer.js';

const log = child('helius-discovery');

const HELIUS_API = 'https://api.helius.xyz';

/**
 * One observed swap event involving a wallet and our target token.
 * Aggregated by `aggregateSwapEvents` into per-wallet quality features.
 */
export interface SwapEvent {
  /** wallet that signed (feePayer) */
  wallet: string;
  /** mint of the target token (NOT the quote side) */
  baseMint: string;
  /** USD value of the swap; 0 if we couldn't price */
  amountUsd: number;
  /** 'buy' = wallet received baseMint, 'sell' = wallet sent baseMint */
  side: 'buy' | 'sell';
  /** unix epoch seconds */
  ts: number;
  /** tx signature for traceability */
  signature: string;
}

/**
 * Pull recent SWAP enhanced transactions for a token mint and reduce them to
 * SwapEvent rows. Uses Helius enhanced transactions endpoint, paginated.
 *
 * Cost: ~100 credits per page of up to 100 transactions.
 *
 * @param mint   token mint to scan
 * @param pages  number of pages of 100 (default 2 = 200 transactions)
 * @param quotePrices quote-mint prices in USD (provide once, reuse across calls)
 */
export async function getSwappersForToken(
  mint: string,
  pages = 2,
  quotePrices: Record<string, number> = {},
): Promise<SwapEvent[]> {
  if (config.heliusMode === 'off') {
    log.debug({ mint }, 'HELIUS_MODE=off; returning empty');
    return [];
  }

  const out: SwapEvent[] = [];
  let before: string | undefined;

  for (let p = 0; p < pages; p++) {
    const url =
      `${HELIUS_API}/v0/addresses/${mint}/transactions` +
      `?api-key=${config.heliusApiKey}&type=SWAP&limit=100` +
      (before ? `&before=${before}` : '');

    let txs: HeliusEnhancedTx[] = [];
    try {
      const res = await heliusFetch({
        url,
        kind: 'wallet_history',
        note: `discovery:${mint.slice(0, 6)} p${p}`,
      });
      if (res.statusCode !== 200) {
        log.warn({ mint, status: res.statusCode, page: p }, 'helius discovery non-200');
        break;
      }
      txs = (await res.body.json()) as HeliusEnhancedTx[];
    } catch (err) {
      if (err instanceof HeliusGuardError) {
        log.warn({ mint, reason: err.reason }, `guard blocked discovery: ${err.message}`);
        break;
      }
      log.warn({ err: String(err), mint }, 'helius discovery fetch failed');
      break;
    }

    if (txs.length === 0) break;

    for (const tx of txs) {
      const event = parseSwapEvent(tx, mint, quotePrices);
      if (event) out.push(event);
    }

    before = txs[txs.length - 1]?.signature;
    if (!before) break;
    // be polite — 4 req/s
    await new Promise((r) => setTimeout(r, 250));
  }

  return out;
}

/**
 * Reduce one Helius enhanced tx to a SwapEvent for the given target mint.
 * Returns null if the tx doesn't actually swap our target.
 *
 * Direction logic:
 *   - if our mint appears in tokenOutputs.userAccount==feePayer (or via transfers
 *     terminating at a feePayer-owned ATA), wallet RECEIVED our token = buy
 *   - if our mint appears in tokenInputs from feePayer = sell
 *   - we use the quote-side leg (SOL/USDC/USDT) to derive USD
 */
function parseSwapEvent(
  tx: HeliusEnhancedTx,
  targetMint: string,
  quotePrices: Record<string, number>,
): SwapEvent | null {
  const wallet = tx.feePayer;
  if (!wallet) return null;

  const swap = tx.events?.swap;

  // Try the parsed-swap path first (cleanest)
  if (swap) {
    const ourOutput = (swap.tokenOutputs ?? []).find((o) => o.mint === targetMint);
    const ourInput = (swap.tokenInputs ?? []).find((i) => i.mint === targetMint);
    const side: 'buy' | 'sell' | null = ourOutput ? 'buy' : ourInput ? 'sell' : null;
    if (!side) return null;

    // Derive USD from the quote side (whichever of inputs/outputs holds a quote mint)
    const quoteLegs = [
      ...(swap.tokenInputs ?? []).filter((l) => isQuoteMint(l.mint)),
      ...(swap.tokenOutputs ?? []).filter((l) => isQuoteMint(l.mint)),
    ];

    let amountUsd = 0;
    if (quoteLegs.length > 0) {
      const qLeg = quoteLegs[0]!;
      const decimals = qLeg.tokenAmount.decimals;
      const qty = Number(qLeg.tokenAmount.tokenAmount) / 10 ** decimals;
      const price = quotePrices[qLeg.mint] ?? (qLeg.mint === QUOTE_MINTS.USDC ? 1 : qLeg.mint === QUOTE_MINTS.USDT ? 1 : 0);
      amountUsd = qty * price;
    } else if (swap.nativeInput || swap.nativeOutput) {
      const lamports = Number(swap.nativeInput?.amount ?? swap.nativeOutput?.amount ?? 0);
      const sol = lamports / 1e9;
      amountUsd = sol * (quotePrices[QUOTE_MINTS.SOL] ?? 0);
    }

    return {
      wallet,
      baseMint: targetMint,
      amountUsd,
      side,
      ts: tx.timestamp,
      signature: tx.signature,
    };
  }

  // Fallback: scan tokenTransfers for the target mint and feePayer involvement
  const transfers = tx.tokenTransfers ?? [];
  const ours = transfers.find((t) => t.mint === targetMint);
  if (!ours) return null;
  const side: 'buy' | 'sell' = ours.toUserAccount === wallet ? 'buy' : 'sell';

  // Best-effort USD from any quote-mint transfer to/from the wallet
  const quoteTransfer = transfers.find(
    (t) => isQuoteMint(t.mint) && (t.fromUserAccount === wallet || t.toUserAccount === wallet),
  );
  let amountUsd = 0;
  if (quoteTransfer) {
    const price =
      quotePrices[quoteTransfer.mint] ??
      (quoteTransfer.mint === QUOTE_MINTS.USDC || quoteTransfer.mint === QUOTE_MINTS.USDT
        ? 1
        : 0);
    amountUsd = quoteTransfer.tokenAmount * price;
  }

  return {
    wallet,
    baseMint: targetMint,
    amountUsd,
    side,
    ts: tx.timestamp,
    signature: tx.signature,
  };
}

/**
 * Bulk discovery across many tokens.
 *
 * @param mints     list of token mints to scan
 * @param pagesPerToken how deep to paginate per token (cost = mints * pages * 100 credits)
 */
export async function discoverSwappers(
  mints: string[],
  pagesPerToken = 2,
): Promise<SwapEvent[]> {
  log.info({ tokens: mints.length, pagesPerToken, estCredits: mints.length * pagesPerToken * 100 }, 'starting helius discovery');
  const quotePrices = await getJupPrices([QUOTE_MINTS.SOL, QUOTE_MINTS.USDC, QUOTE_MINTS.USDT]);

  const all: SwapEvent[] = [];
  for (let i = 0; i < mints.length; i++) {
    const m = mints[i]!;
    const events = await getSwappersForToken(m, pagesPerToken, quotePrices);
    all.push(...events);
    log.debug(
      { done: i + 1, of: mints.length, eventsThisToken: events.length, totalSoFar: all.length },
      'discovery progress',
    );
  }
  log.info({ totalEvents: all.length }, 'helius discovery done');
  return all;
}
