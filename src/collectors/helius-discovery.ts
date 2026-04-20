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
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await heliusFetch({
          url,
          kind: 'wallet_history',
          note: `discovery:${mint.slice(0, 6)} p${p}${attempt > 0 ? ` retry${attempt}` : ''}`,
        });
        lastStatus = res.statusCode;
        if (res.statusCode === 200) {
          txs = (await res.body.json()) as HeliusEnhancedTx[];
          break;
        }
        // Retry only on transient server errors
        if (res.statusCode >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        if (err instanceof HeliusGuardError) {
          log.warn({ mint, reason: err.reason }, `guard blocked discovery: ${err.message}`);
          return out;
        }
        log.warn({ err: String(err), mint, attempt }, 'helius discovery fetch failed');
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    if (txs.length === 0 && lastStatus !== 200) {
      log.warn({ mint, status: lastStatus, page: p }, 'helius discovery gave up after retries');
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
 * Helius is inconsistent about how it reports token amounts in `events.swap`:
 *   - newer payloads use `rawTokenAmount: { tokenAmount: string, decimals: number }`
 *   - older/webhook payloads use `tokenAmount: { tokenAmount: string, decimals: number }`
 *   - some use a flat `tokenAmount: number` (already decimal-adjusted)
 *
 * This helper returns the human-readable token quantity regardless of format.
 */
function readSwapLegAmount(leg: unknown): number {
  if (!leg || typeof leg !== 'object') return 0;
  const l = leg as Record<string, unknown>;

  const raw = l.rawTokenAmount as { tokenAmount?: string | number; decimals?: number } | undefined;
  if (raw && raw.tokenAmount !== undefined && raw.decimals !== undefined) {
    return Number(raw.tokenAmount) / 10 ** Number(raw.decimals);
  }

  const ta = l.tokenAmount;
  if (ta && typeof ta === 'object') {
    const obj = ta as { tokenAmount?: string | number; decimals?: number };
    if (obj.tokenAmount !== undefined && obj.decimals !== undefined) {
      return Number(obj.tokenAmount) / 10 ** Number(obj.decimals);
    }
  }
  if (typeof ta === 'number') return ta;
  if (typeof ta === 'string') {
    const n = Number(ta);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
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
    const ourOutput = (swap.tokenOutputs ?? []).find((o) => o && o.mint === targetMint);
    const ourInput = (swap.tokenInputs ?? []).find((i) => i && i.mint === targetMint);
    const side: 'buy' | 'sell' | null = ourOutput ? 'buy' : ourInput ? 'sell' : null;
    if (!side) {
      // Sometimes the swap payload doesn't list the user-side leg — fall through
      // to tokenTransfers heuristic below.
    } else {
      const quoteLegs = [
        ...(swap.tokenInputs ?? []).filter((l) => l && isQuoteMint(l.mint)),
        ...(swap.tokenOutputs ?? []).filter((l) => l && isQuoteMint(l.mint)),
      ];

      let amountUsd = 0;
      if (quoteLegs.length > 0) {
        const qLeg = quoteLegs[0]!;
        const qty = readSwapLegAmount(qLeg);
        const price =
          quotePrices[qLeg.mint] ??
          (qLeg.mint === QUOTE_MINTS.USDC || qLeg.mint === QUOTE_MINTS.USDT ? 1 : 0);
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

/**
 * Stage-2 discovery: pull a wallet's own SWAP history regardless of which
 * tokens they swap. Used to deep-dive top candidates from stage 1 so we
 * see their REAL activity (across tokens NOT in our seed universe).
 *
 * Cost: pages * 100 credits per wallet.
 */
export async function getWalletSwapHistory(
  wallet: string,
  pages = 1,
  quotePrices: Record<string, number> = {},
): Promise<SwapEvent[]> {
  if (config.heliusMode === 'off') return [];

  const out: SwapEvent[] = [];
  let before: string | undefined;

  for (let p = 0; p < pages; p++) {
    const url =
      `${HELIUS_API}/v0/addresses/${wallet}/transactions` +
      `?api-key=${config.heliusApiKey}&type=SWAP&limit=100` +
      (before ? `&before=${before}` : '');

    let txs: HeliusEnhancedTx[] = [];
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await heliusFetch({
          url,
          kind: 'wallet_history',
          note: `s2:${wallet.slice(0, 6)} p${p}`,
        });
        lastStatus = res.statusCode;
        if (res.statusCode === 200) {
          txs = (await res.body.json()) as HeliusEnhancedTx[];
          break;
        }
        if (res.statusCode >= 500 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      } catch (err) {
        if (err instanceof HeliusGuardError) {
          log.warn({ wallet, reason: err.reason }, `guard blocked stage-2: ${err.message}`);
          return out;
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }
    }
    if (txs.length === 0) {
      if (lastStatus !== 200) {
        log.debug({ wallet, status: lastStatus, page: p }, 'stage-2 page empty');
      }
      break;
    }

    for (const tx of txs) {
      const ev = parseSwapEventForWallet(tx, wallet, quotePrices);
      if (ev) out.push(ev);
    }

    before = txs[txs.length - 1]?.signature;
    if (!before) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  return out;
}

/**
 * Same as `parseSwapEvent` but the user-side leg is determined by the
 * wallet we're inspecting (not by a target mint).
 *
 * The base mint is whichever non-quote token the wallet swapped to/from.
 */
function parseSwapEventForWallet(
  tx: HeliusEnhancedTx,
  wallet: string,
  quotePrices: Record<string, number>,
): SwapEvent | null {
  if (tx.feePayer !== wallet) return null;
  const swap = tx.events?.swap;

  if (swap) {
    // Find any non-quote leg the wallet received (= buy) or sent (= sell)
    const recvBase = (swap.tokenOutputs ?? []).find(
      (o) => o && o.userAccount === wallet && !isQuoteMint(o.mint),
    );
    const sentBase = (swap.tokenInputs ?? []).find(
      (i) => i && i.userAccount === wallet && !isQuoteMint(i.mint),
    );
    let baseMint: string | null = null;
    let side: 'buy' | 'sell' | null = null;
    if (recvBase) {
      baseMint = recvBase.mint;
      side = 'buy';
    } else if (sentBase) {
      baseMint = sentBase.mint;
      side = 'sell';
    }
    if (!baseMint || !side) return null;

    const quoteLegs = [
      ...(swap.tokenInputs ?? []).filter((l) => l && isQuoteMint(l.mint)),
      ...(swap.tokenOutputs ?? []).filter((l) => l && isQuoteMint(l.mint)),
    ];
    let amountUsd = 0;
    if (quoteLegs.length > 0) {
      const qLeg = quoteLegs[0]!;
      const qty = readSwapLegAmount(qLeg);
      const price =
        quotePrices[qLeg.mint] ??
        (qLeg.mint === QUOTE_MINTS.USDC || qLeg.mint === QUOTE_MINTS.USDT ? 1 : 0);
      amountUsd = qty * price;
    } else if (swap.nativeInput || swap.nativeOutput) {
      const lamports = Number(swap.nativeInput?.amount ?? swap.nativeOutput?.amount ?? 0);
      const sol = lamports / 1e9;
      amountUsd = sol * (quotePrices[QUOTE_MINTS.SOL] ?? 0);
    }
    return {
      wallet,
      baseMint,
      amountUsd,
      side,
      ts: tx.timestamp,
      signature: tx.signature,
    };
  }

  return null;
}

/**
 * Stage-2 batch wrapper. Politely paginates through `wallets`, returning
 * combined SwapEvent rows from each wallet's recent SWAP history.
 *
 * @param wallets candidate wallets to deep-dive (top of stage-1 by frequency)
 * @param pagesPerWallet 1 page = 100 swaps = 100 credits per wallet
 */
export async function deepDiveWallets(
  wallets: string[],
  pagesPerWallet = 1,
): Promise<SwapEvent[]> {
  if (wallets.length === 0) return [];
  log.info(
    { wallets: wallets.length, pagesPerWallet, estCredits: wallets.length * pagesPerWallet * 100 },
    'starting stage-2 deep-dive',
  );
  const quotePrices = await getJupPrices([QUOTE_MINTS.SOL, QUOTE_MINTS.USDC, QUOTE_MINTS.USDT]);
  const out: SwapEvent[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i]!;
    const evs = await getWalletSwapHistory(w, pagesPerWallet, quotePrices);
    out.push(...evs);
    if ((i + 1) % 25 === 0) {
      log.debug(
        { done: i + 1, of: wallets.length, totalEvents: out.length },
        'stage-2 progress',
      );
    }
  }
  log.info({ totalEvents: out.length }, 'stage-2 done');
  return out;
}
