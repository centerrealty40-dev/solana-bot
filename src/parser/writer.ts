import { db, schema } from '../core/db/client.js';
import type { SwapInsert } from './pumpfun.js';

function toSwapRow(r: SwapInsert) {
  return {
    signature: r.signature,
    slot: r.slot,
    blockTime: r.blockTime,
    wallet: r.wallet,
    baseMint: r.baseMint,
    quoteMint: r.quoteMint,
    side: r.side,
    baseAmountRaw: r.baseAmountRaw,
    quoteAmountRaw: r.quoteAmountRaw,
    priceUsd: r.priceUsd,
    amountUsd: r.amountUsd,
    dex: r.dex,
    source: r.source,
  };
}

export async function insertSwaps(rows: SwapInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const q = await db
    .insert(schema.swaps)
    .values(rows.map(toSwapRow))
    .onConflictDoNothing({
      target: [schema.swaps.signature, schema.swaps.wallet, schema.swaps.baseMint],
    })
    .returning({ id: schema.swaps.id });
  return q.length;
}

/** Minimal touches — mint PK + wallet PK only (no enrichment). */
export async function touchTokensAndWallets(swaps: SwapInsert[]): Promise<void> {
  if (swaps.length === 0) return;
  const mintSet = new Set<string>();
  const walletSet = new Set<string>();
  for (const s of swaps) {
    mintSet.add(s.baseMint);
    walletSet.add(s.wallet);
  }
  const mints = [...mintSet];
  const wallets = [...walletSet];

  if (mints.length > 0) {
    await db
      .insert(schema.tokens)
      .values(mints.map((mint) => ({ mint })))
      .onConflictDoNothing({ target: schema.tokens.mint });
  }
  if (wallets.length > 0) {
    await db
      .insert(schema.wallets)
      .values(wallets.map((address) => ({ address })))
      .onConflictDoNothing({ target: schema.wallets.address });
  }
}
