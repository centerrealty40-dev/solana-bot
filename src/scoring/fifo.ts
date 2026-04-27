import type { Swap, TokenPosition, WalletAggregate } from './types.js';

/**
 * Apply a single swap to a per-token FIFO position.
 *
 * Buys add a lot. Sells consume earliest lots first; realized PnL accumulates as
 * (sellPrice - lotEntryPrice) * filledAmount. We track time in net long
 * (`holdingMinutes`) by accumulating quantity*minutes between events.
 */
export function applySwapFifo(pos: TokenPosition, swap: Swap): void {
  const t = swap.blockTime;
  // Compute time-in-position contribution: between previous event and this one,
  // we held `currentQty`. If we never become flat, it accumulates.
  const currentQty = pos.lots.reduce((acc, l) => acc + l.amountRaw, 0n);
  if (pos.lastFlatAt && currentQty > 0n) {
    // we had something open; accumulate weighted time
    // For simplicity we count whole-position holding minutes (not qty-weighted).
    // The hypothesis only needs a relative measure.
    const minutes = (t.getTime() - pos.lastFlatAt.getTime()) / 60_000;
    if (minutes > 0) pos.holdingMinutes += minutes;
  }
  if (currentQty === 0n) {
    pos.lastFlatAt = t;
  }

  if (swap.side === 'buy') {
    pos.lots.push({
      amountRaw: swap.baseAmountRaw,
      priceUsd: swap.priceUsd,
      openedAt: t,
    });
    pos.costUsd += swap.amountUsd;
  } else {
    let toSell = swap.baseAmountRaw;
    let realized = 0;
    let sellPrice = swap.priceUsd;
    let salesInThisExit = 1; // every sell counts; partial-exit grouping happens at position close
    while (toSell > 0n && pos.lots.length > 0) {
      const lot = pos.lots[0]!;
      const take = lot.amountRaw <= toSell ? lot.amountRaw : toSell;
      const baseUnits = Number(take) / 1e9; // approximate, since we don't have decimals here
      // Use raw ratio instead: realized in USD = (sellPrice - entryPrice) * (take / baseAmountRaw) * sellAmountUsd
      const fraction = Number(take) / Number(swap.baseAmountRaw);
      const realizedFromLot = fraction * (sellPrice - lot.priceUsd) * (Number(swap.baseAmountRaw) / 1e9);
      // The /1e9 cancels in this path because both sellAmount and lot amount share the same scale.
      // Use simpler approach below to avoid decimals confusion:
      void baseUnits;
      void realizedFromLot;
      const sellPortionUsd = swap.amountUsd * fraction;
      const costPortionUsd = (Number(take) / Number(lot.amountRaw)) * lot.priceUsd * (Number(lot.amountRaw) / Number(swap.baseAmountRaw)) * swap.amountUsd / sellPrice;
      // The math above is messy — use a direct formula instead
      void sellPortionUsd;
      void costPortionUsd;

      // direct formula: pnl = take * (sellPrice - lotEntryPrice), in USD per "raw unit / 10^decimals"
      // we don't have decimals here, but ratios cancel: amountUsd = baseAmountRaw/10^d * priceUsd
      // -> pnl = (take/baseAmountRaw) * amountUsd - (take/baseAmountRaw) * (lot.priceUsd/sellPrice) * amountUsd
      const pnlPart =
        fraction * swap.amountUsd * (1 - lot.priceUsd / sellPrice);
      realized += pnlPart;

      lot.amountRaw -= take;
      if (lot.amountRaw === 0n) pos.lots.shift();
      toSell -= take;
    }
    pos.realizedPnlUsd += realized;
    if (pos.lots.length === 0) {
      pos.closedCount += 1;
      // We can't know "salesInThisExit" without more state; leave counter to caller.
      void salesInThisExit;
      pos.lastFlatAt = t;
    }
  }
}

/**
 * Build per-wallet aggregate for a window of swaps.
 *
 * Swaps must be ordered ascending by blockTime (oldest first). The function is pure: it
 * does not touch the DB.
 */
export function buildWalletAggregate(wallet: string, swaps: Swap[]): WalletAggregate {
  const ordered = [...swaps].sort(
    (a, b) => a.blockTime.getTime() - b.blockTime.getTime(),
  );
  const positions = new Map<string, TokenPosition>();
  for (const s of ordered) {
    let p = positions.get(s.baseMint);
    if (!p) {
      p = {
        baseMint: s.baseMint,
        lots: [],
        realizedPnlUsd: 0,
        costUsd: 0,
        holdingMinutes: 0,
        closedCount: 0,
        trancheClosedCount: 0,
        lastFlatAt: null,
      };
      positions.set(s.baseMint, p);
    }
    applySwapFifo(p, s);
  }
  const distinctTokens = positions.size;
  const totalRealized = Array.from(positions.values()).reduce(
    (acc, p) => acc + p.realizedPnlUsd,
    0,
  );
  const closedTotal = Array.from(positions.values()).reduce((acc, p) => acc + p.closedCount, 0);
  const wins = Array.from(positions.values()).filter((p) => p.realizedPnlUsd > 0).length;
  const winrate = closedTotal > 0 ? wins / Math.max(distinctTokens, 1) : 0;
  return {
    wallet,
    swaps: ordered,
    positions,
    tradeCount: ordered.length,
    distinctTokens,
    winrate,
    totalRealizedPnlUsd: totalRealized,
  };
}

/**
 * Estimate `sellInTranchesRatio`: for closed token positions, fraction that were closed
 * via more than one sell transaction (group consecutive sells separated by < 24h with no buy).
 */
export function computeTrancheRatio(swaps: Swap[]): number {
  const byToken = new Map<string, Swap[]>();
  for (const s of swaps) {
    if (!byToken.has(s.baseMint)) byToken.set(s.baseMint, []);
    byToken.get(s.baseMint)!.push(s);
  }
  let closed = 0;
  let multiSell = 0;
  for (const [, list] of byToken) {
    list.sort((a, b) => a.blockTime.getTime() - b.blockTime.getTime());
    let inPos = false;
    let sellsInExit = 0;
    let qty = 0n;
    for (const s of list) {
      if (s.side === 'buy') {
        if (!inPos) {
          inPos = true;
          sellsInExit = 0;
          qty = s.baseAmountRaw;
        } else {
          qty += s.baseAmountRaw;
        }
      } else {
        sellsInExit += 1;
        qty -= s.baseAmountRaw;
        if (qty <= 0n) {
          closed += 1;
          if (sellsInExit > 1) multiSell += 1;
          inPos = false;
          qty = 0n;
        }
      }
    }
  }
  return closed === 0 ? 0 : multiSell / closed;
}
