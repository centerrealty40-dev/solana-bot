import { and, eq, sql as dsql } from 'drizzle-orm';
import { db, schema } from '../core/db/client.js';
import { config } from '../core/config.js';
import { child } from '../core/logger.js';
import { QUOTE_MINTS } from '../core/constants.js';
import { openPosition, applyExit } from './position-store.js';
import { notifyCopyEntry, notifyCopyExit } from './telegram.js';
import type { NormalizedSwap } from '../core/types.js';

const log = child('copy-trader');

/**
 * Hypothesis id we use for paper positions opened by the copy-trader.
 *
 * H8 = "fresh-wallet rotation network". Every wallet currently in
 * watchlist_wallets was discovered by either H8 (rotation-seed/parent) or by
 * the legacy helius-seed multi-token scan; we lump them under one id so that
 * daily reports / heartbeats aggregate the whole copy-trader bucket together.
 */
const HYPOTHESIS_ID = 'copy_h8';

/**
 * In-memory cache of the watchlist. Refreshed on demand and at startup.
 *
 * We keep this in process so the hot webhook path doesn't hit the DB on every
 * inbound swap. The webhook is registered with Helius using EXACTLY this set,
 * so any swap reaching processCopyBatch is already wallet-of-interest, but we
 * still double-check (defence in depth in case the webhook drifts).
 */
const watchlistCache = {
  set: new Set<string>(),
  loadedAt: 0,
};

const WATCHLIST_CACHE_TTL_MS = 5 * 60_000;

async function getWatchlist(force = false): Promise<Set<string>> {
  const now = Date.now();
  if (!force && now - watchlistCache.loadedAt < WATCHLIST_CACHE_TTL_MS && watchlistCache.set.size > 0) {
    return watchlistCache.set;
  }
  const rows = await db
    .select({ wallet: schema.watchlistWallets.wallet })
    .from(schema.watchlistWallets)
    .where(dsql`${schema.watchlistWallets.removedAt} IS NULL`);
  watchlistCache.set = new Set(rows.map((r) => r.wallet));
  watchlistCache.loadedAt = now;
  log.debug({ size: watchlistCache.set.size }, 'watchlist cache refreshed');
  return watchlistCache.set;
}

export async function refreshWatchlistCache(): Promise<number> {
  const set = await getWatchlist(true);
  return set.size;
}

/**
 * Bluechip / quote mints we never want to "copy-buy". A watchlist wallet
 * picking up SOL or USDC is operational liquidity, not alpha.
 */
const COPY_BLACKLIST_MINTS = new Set<string>([
  QUOTE_MINTS.SOL,
  QUOTE_MINTS.USDC,
  QUOTE_MINTS.USDT,
]);

/**
 * Minimum lead size in USD. MEMECOIN-OP leaders (GoorwtjW / CnjzwkRh pattern)
 * routinely buy on $20-30 — setting the floor too high kills the whole point.
 * $10 keeps obvious dust out (Helius/Jupiter price-glitches show as $0.50)
 * while letting the small-but-systematic micro-snipers through.
 */
const MIN_LEAD_USD = 10;

/** Hard time-stop: close any copy position older than this regardless of mirror. */
const COPY_TIME_STOP_HOURS = 48;

/**
 * Honeypot pre-check via DexScreener.
 *
 * Discovered the hard way: H8 rotation network reliably finds wallet clusters,
 * but those clusters can also be the SCAMMER's own laundering ring buying his
 * own honeypot token to fake volume (5 fresh wallets all buying mint X with
 * ~$50k each, no sell side ever). A copy-trade follower mirrors the buy and
 * gets locked in.
 *
 * Cheapest defence: before opening a copy position, ask DexScreener if anyone
 * outside the cluster has been able to SELL the token in the last hour. No
 * sells + many buys = honeypot or freshly-launched rug bait.
 *
 * Cache results for 60 s so a burst of leader buys on the same mint doesn't
 * hammer DexScreener.
 */
const honeypotCache = new Map<string, { ts: number; verdict: { reject: boolean; reason: string } }>();
const HONEYPOT_CACHE_MS = 60_000;

async function honeypotPrecheck(mint: string): Promise<{ reject: boolean; reason: string }> {
  const cached = honeypotCache.get(mint);
  if (cached && Date.now() - cached.ts < HONEYPOT_CACHE_MS) return cached.verdict;

  const verdict = await (async (): Promise<{ reject: boolean; reason: string }> => {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) return { reject: false, reason: '' }; // fail-open: don't block on infra issues
      const j = (await res.json()) as { pairs?: Array<{
        txns?: { h1?: { buys: number; sells: number }; h6?: { buys: number; sells: number } };
        liquidity?: { usd?: number };
        priceUsd?: string;
      }> };
      const pairs = j.pairs ?? [];
      if (pairs.length === 0) return { reject: true, reason: 'no_dex_pair' };

      // Aggregate across all pairs (Raydium + pump.fun bonding etc)
      const tot = { buys1: 0, sells1: 0, buys6: 0, sells6: 0, liq: 0 };
      for (const p of pairs) {
        tot.buys1 += p.txns?.h1?.buys ?? 0;
        tot.sells1 += p.txns?.h1?.sells ?? 0;
        tot.buys6 += p.txns?.h6?.buys ?? 0;
        tot.sells6 += p.txns?.h6?.sells ?? 0;
        tot.liq += p.liquidity?.usd ?? 0;
      }

      // Hard honeypot signal: meaningful buy activity but ZERO sells in last hour
      if (tot.buys1 >= 10 && tot.sells1 === 0) {
        return { reject: true, reason: `honeypot_${tot.buys1}b/0s_h1` };
      }
      // Soft signal: very low sell ratio over 6h (only allow if liquidity is decent)
      const ratio6 = tot.sells6 / Math.max(tot.buys6, 1);
      if (tot.buys6 >= 30 && ratio6 < 0.05) {
        return { reject: true, reason: `near_honeypot_${(ratio6 * 100).toFixed(0)}%_sells_h6` };
      }
      // Rug bait: liquidity too low to ever exit at scale
      if (tot.liq < 3000) {
        return { reject: true, reason: `low_liq_$${tot.liq.toFixed(0)}` };
      }
      return { reject: false, reason: '' };
    } catch (err) {
      log.debug({ err: String(err), mint }, 'honeypot precheck failed, fail-open');
      return { reject: false, reason: '' };
    }
  })();

  honeypotCache.set(mint, { ts: Date.now(), verdict });
  return verdict;
}

/**
 * Process a batch of normalized swaps after they are persisted.
 *
 * Caller (helius-webhook.processHeliusBatch) invokes this AFTER insertSwapsBatch
 * succeeds, so we know every swap row exists in DB. We do not do any I/O on the
 * critical path that could fail-loud; copy-trade failures are logged but never
 * thrown back to the webhook.
 */
export async function processCopyBatch(swaps: NormalizedSwap[]): Promise<void> {
  if (swaps.length === 0) return;
  const wl = await getWatchlist();
  if (wl.size === 0) return;

  for (const swap of swaps) {
    if (!wl.has(swap.wallet)) continue;
    if (COPY_BLACKLIST_MINTS.has(swap.baseMint)) continue;
    try {
      if (swap.side === 'buy') {
        await onLeaderBuy(swap);
      } else {
        await onLeaderSell(swap);
      }
    } catch (err) {
      log.warn(
        { err: String(err), wallet: swap.wallet, mint: swap.baseMint, side: swap.side },
        'copy-trader swap handler failed',
      );
    }
  }
}

/* ---------- entry side: First-N attribution ---------- */

async function onLeaderBuy(swap: NormalizedSwap): Promise<void> {
  if (swap.amountUsd < MIN_LEAD_USD) {
    log.debug(
      { wallet: swap.wallet, mint: swap.baseMint, usd: swap.amountUsd },
      'lead buy too small, ignoring',
    );
    return;
  }

  // Honeypot pre-check (DexScreener) — block wallets-cluster pumps of un-sellable
  // tokens. Cached for 60s to avoid hammering DexScreener on bursts.
  const hp = await honeypotPrecheck(swap.baseMint);
  if (hp.reject) {
    log.warn(
      { wallet: swap.wallet, mint: swap.baseMint, reason: hp.reason },
      'honeypot precheck blocked copy entry',
    );
    return;
  }

  // First-N gate: try to claim this mint atomically. If another wallet (or this
  // same wallet in a previous tx) already claimed it, do nothing.
  const claimed = await db
    .insert(schema.copySeenMints)
    .values({
      mint: swap.baseMint,
      firstWallet: swap.wallet,
      firstSeenAt: swap.blockTime,
      firstSignature: swap.signature,
    })
    .onConflictDoNothing()
    .returning({ mint: schema.copySeenMints.mint });

  if (claimed.length === 0) {
    log.debug(
      { wallet: swap.wallet, mint: swap.baseMint },
      'mint already claimed by an earlier watchlist buy, follow-the-leader skipped',
    );
    return;
  }

  // Open the paper position. We use the leader's exact fill price (no slippage
  // model) — the conservative assumption is "we got the same block as the
  // leader". Daily report will surface whether this assumption is realistic.
  const sizeUsd = config.maxPositionUsd; // fixed $50 per copy spec
  const entryPrice = Math.max(swap.priceUsd, 1e-12);
  // baseAmountRaw is bookkeeping-only for paper (applyExit derives PnL from
  // sizeUsd*fraction*ratio). Use a 6-decimal placeholder so partial-fraction
  // math stays stable.
  const placeholderBaseRaw = BigInt(Math.round((sizeUsd / entryPrice) * 1_000_000));
  const placeholderQuoteRaw = BigInt(Math.round(sizeUsd * 1_000_000));

  const positionId = await openPosition({
    hypothesisId: HYPOTHESIS_ID,
    mode: 'paper',
    baseMint: swap.baseMint,
    quoteMint: swap.quoteMint,
    sizeUsd,
    entryPriceUsd: entryPrice,
    baseAmountRaw: placeholderBaseRaw,
    quoteAmountRaw: placeholderQuoteRaw,
    slippageBps: 0,
    feeUsd: 0,
    signature: null,
    signalMeta: {
      triggerWallet: swap.wallet,
      triggerSignature: swap.signature,
      leadAmountUsd: swap.amountUsd,
      leadDex: swap.dex,
    },
  });

  log.info(
    {
      positionId: String(positionId),
      mint: swap.baseMint,
      leader: swap.wallet,
      leadUsd: swap.amountUsd,
      sizeUsd,
      entryPrice,
    },
    'copy paper entry opened',
  );

  void notifyCopyEntry({
    positionId,
    baseMint: swap.baseMint,
    triggerWallet: swap.wallet,
    sizeUsd,
    entryPriceUsd: entryPrice,
    leadAmountUsd: swap.amountUsd,
    dex: swap.dex,
  });
}

/* ---------- exit side: mirror sell ---------- */

async function onLeaderSell(swap: NormalizedSwap): Promise<void> {
  // Find every open copy position on this mint whose triggerWallet matches the
  // wallet that just sold. We mirror the leader fully (fraction=1) — partial
  // sells could be added later by reading swap size vs. wallet balance.
  const open = await db
    .select()
    .from(schema.positions)
    .where(
      and(
        eq(schema.positions.hypothesisId, HYPOTHESIS_ID),
        eq(schema.positions.status, 'open'),
        eq(schema.positions.baseMint, swap.baseMint),
        dsql`${schema.positions.signalMeta} ->> 'triggerWallet' = ${swap.wallet}`,
      ),
    );

  if (open.length === 0) {
    log.debug(
      { wallet: swap.wallet, mint: swap.baseMint },
      'leader sold but we have no matching open copy position',
    );
    return;
  }

  const exitPrice = Math.max(swap.priceUsd, 1e-12);

  for (const pos of open) {
    const updated = await applyExit({
      positionId: pos.id,
      fraction: 1,
      exitPriceUsd: exitPrice,
      slippageBps: 0,
      feeUsd: 0,
      signature: null,
      reason: 'mirror_leader_sell',
    });
    const tradePnl =
      pos.sizeUsd * (exitPrice / Math.max(pos.entryPriceUsd, 1e-12) - 1);
    const heldMs = Date.now() - pos.openedAt.getTime();
    log.info(
      {
        positionId: String(pos.id),
        mint: swap.baseMint,
        leader: swap.wallet,
        entry: pos.entryPriceUsd,
        exit: exitPrice,
        pnl: tradePnl,
        heldMs,
      },
      'copy paper exit (mirror)',
    );
    void notifyCopyExit({
      positionId: pos.id,
      baseMint: swap.baseMint,
      triggerWallet: swap.wallet,
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: exitPrice,
      pnlUsd: tradePnl,
      heldMs,
      reason: 'mirror_leader_sell',
    });
    // Keep daily PnL aggregate in sync for the copy hypothesis.
    if (updated.status === 'closed') {
      const day = new Date().toISOString().slice(0, 10);
      const won = tradePnl > 0 ? 1 : 0;
      await db
        .insert(schema.dailyPnl)
        .values({
          hypothesisId: HYPOTHESIS_ID,
          day,
          mode: 'paper',
          realizedPnlUsd: tradePnl,
          tradesCount: 1,
          winsCount: won,
        })
        .onConflictDoUpdate({
          target: [schema.dailyPnl.hypothesisId, schema.dailyPnl.day, schema.dailyPnl.mode],
          set: {
            realizedPnlUsd: dsql`${schema.dailyPnl.realizedPnlUsd} + EXCLUDED.realized_pnl_usd`,
            tradesCount: dsql`${schema.dailyPnl.tradesCount} + 1`,
            winsCount: dsql`${schema.dailyPnl.winsCount} + EXCLUDED.wins_count`,
          },
        });
    }
  }
}

/* ---------- safety net: time-stop sweep ---------- */

/**
 * Close any copy position that has been open longer than COPY_TIME_STOP_HOURS.
 * Use case: leader funded, bought, then disappeared (rugged wallet, stopped
 * trading, hodl forever). Safer to mark-to-market and book the result than to
 * carry it indefinitely in the paper book.
 *
 * Intended to be called by a cron (every 30 min). NOT part of the hot webhook
 * path because it requires querying current price which is rate-limited.
 */
export async function sweepStaleCopyPositions(
  lookupPrice: (mint: string) => Promise<number | null>,
): Promise<{ closed: number }> {
  const cutoff = new Date(Date.now() - COPY_TIME_STOP_HOURS * 60 * 60 * 1000);
  const stale = await db
    .select()
    .from(schema.positions)
    .where(
      and(
        eq(schema.positions.hypothesisId, HYPOTHESIS_ID),
        eq(schema.positions.status, 'open'),
        dsql`${schema.positions.openedAt} < ${cutoff}`,
      ),
    );

  let closed = 0;
  for (const pos of stale) {
    const px = (await lookupPrice(pos.baseMint).catch(() => null)) ?? pos.entryPriceUsd;
    const exitPrice = Math.max(px, 1e-12);
    await applyExit({
      positionId: pos.id,
      fraction: 1,
      exitPriceUsd: exitPrice,
      slippageBps: 0,
      feeUsd: 0,
      signature: null,
      reason: 'time_stop_48h',
    });
    const tradePnl =
      pos.sizeUsd * (exitPrice / Math.max(pos.entryPriceUsd, 1e-12) - 1);
    const heldMs = Date.now() - pos.openedAt.getTime();
    void notifyCopyExit({
      positionId: pos.id,
      baseMint: pos.baseMint,
      triggerWallet: String((pos.signalMeta as Record<string, unknown>)?.triggerWallet ?? '?'),
      entryPriceUsd: pos.entryPriceUsd,
      exitPriceUsd: exitPrice,
      pnlUsd: tradePnl,
      heldMs,
      reason: 'time_stop_48h',
    });
    closed++;
  }
  if (closed > 0) {
    log.info({ closed, hours: COPY_TIME_STOP_HOURS }, 'time-stop sweep closed stale copy positions');
  }
  return { closed };
}
