import {
  decodeAllowlistedDexSwapForWallet,
  extractPumpSwapPoolFromTx,
  PUMP_SWAP_AMM_PROGRAM_ID,
  programIdsInvokedInTx,
} from '../parser/allowlisted-dex-swap.js';
import { signerPubkeys } from '../parser/pumpfun.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { PUMPSWAP_WSOL_QUOTE_MINT } from '../pumpswap-combo/watchlist.js';

export type PumpSwapStreamSnapshot = {
  pairAddress: string;
  baseMint: string;
  quoteMint: string;
  priceUsd: number;
  side: 'buy' | 'sell';
  signature: string;
  slot: number;
  blockTimeMs: number;
};

export function isPumpSwapTradeLog(logs: string[]): boolean {
  if (!logs.length) return false;
  const joined = logs.join('\n');
  return (
    joined.includes('Program log: Instruction: Buy') ||
    joined.includes('Program log: Instruction: Sell')
  );
}

export function decodePumpSwapStreamSnapshot(
  tx: TxJsonParsed,
  solUsd: number,
): PumpSwapStreamSnapshot | null {
  if (tx.meta?.err != null) return null;
  if (!programIdsInvokedInTx(tx).has(PUMP_SWAP_AMM_PROGRAM_ID)) return null;

  const pool = extractPumpSwapPoolFromTx(tx);
  if (!pool) return null;

  const sig = tx.transaction?.signatures?.[0];
  if (!sig || typeof sig !== 'string') return null;
  const slot = typeof tx.slot === 'number' && Number.isFinite(tx.slot) ? tx.slot : null;
  const bt = tx.blockTime;
  if (slot === null || typeof bt !== 'number' || !Number.isFinite(bt)) return null;

  for (const wallet of signerPubkeys(tx)) {
    const swap = decodeAllowlistedDexSwapForWallet(tx, wallet, solUsd);
    if (!swap || !(swap.priceUsd > 0)) continue;
    if (swap.quoteMint !== PUMPSWAP_WSOL_QUOTE_MINT) continue;
    return {
      pairAddress: pool,
      baseMint: swap.baseMint,
      quoteMint: swap.quoteMint,
      priceUsd: swap.priceUsd,
      side: swap.side,
      signature: sig,
      slot,
      blockTimeMs: bt * 1000,
    };
  }
  return null;
}
