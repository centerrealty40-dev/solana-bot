import { Connection, PublicKey } from '@solana/web3.js';

export async function walletSolSpentFromTx(args: {
  rpcUrl: string;
  wallet: PublicKey;
  signature: string;
}): Promise<{ solSpent: number; feeSol: number } | null> {
  const conn = new Connection(args.rpcUrl, 'confirmed');
  const tx = await conn.getTransaction(args.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) return null;

  const msg = tx.transaction.message;
  const keys =
    'staticAccountKeys' in msg && Array.isArray(msg.staticAccountKeys)
      ? msg.staticAccountKeys
      : msg.getAccountKeys().staticAccountKeys;
  const idx = keys.findIndex((k) => k.equals(args.wallet));
  if (idx < 0) return null;

  const feeSol = tx.meta.fee / 1e9;
  const pre = tx.meta.preBalances[idx]! / 1e9;
  const post = tx.meta.postBalances[idx]! / 1e9;
  const solSpent = pre - post - feeSol;
  if (!(solSpent > 0)) return null;
  return { solSpent, feeSol };
}

export function fillFromChainAndTokens(args: {
  solSpent: number;
  solUsd: number;
  tokenBefore: bigint;
  tokenAfter: bigint;
  decimals: number;
  fallbackPriceUsd: number;
}): {
  fillPriceUsd: number;
  usdAtMarket: number;
  tokensReceived: number;
  solSpent: number;
  solUsdAtFill: number;
} {
  const received = args.tokenAfter - args.tokenBefore;
  const tokensReceived =
    received > 0n ? Number(received) / 10 ** args.decimals : 0;
  const usdAtMarket = args.solSpent * args.solUsd;
  if (!(tokensReceived > 0) || !(usdAtMarket > 0)) {
    return {
      fillPriceUsd: args.fallbackPriceUsd,
      usdAtMarket: 0,
      tokensReceived: 0,
      solSpent: args.solSpent,
      solUsdAtFill: args.solUsd,
    };
  }
  return {
    fillPriceUsd: usdAtMarket / tokensReceived,
    usdAtMarket,
    tokensReceived,
    solSpent: args.solSpent,
    solUsdAtFill: args.solUsd,
  };
}
