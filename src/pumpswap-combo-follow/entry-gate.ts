import { fetchParsedTransaction, rpcCall, type SignatureRow } from '../copytrader/rpc.js';
import {
  decodeAllowlistedDexSwapInserts,
} from '../parser/allowlisted-dex-swap.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import type { TxJsonParsed } from '../parser/rpc-http.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { PumpswapComboFollowConfig } from './config.js';

export type FlowEntryGateMode = 'all' | 'flow';

export type PriorExtSellHit = {
  usd: number;
  lagSec: number;
  signature: string;
};

export type FlowEntryGateVerdict = {
  pass: boolean;
  reason?: 'no_pool' | 'no_ext_sell' | 'whale_dump' | 'lag_too_slow';
  extSell: PriorExtSellHit | null;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pure gate — testable without RPC. */
export function evaluateFlowEntryGate(
  cfg: Pick<
    PumpswapComboFollowConfig,
    'flowGateMinExtSellUsd' | 'flowGateMaxExtSellUsd' | 'flowGateMaxLagSec'
  >,
  pool: string | null | undefined,
  extSell: PriorExtSellHit | null,
): FlowEntryGateVerdict {
  if (!pool?.trim()) {
    return { pass: false, reason: 'no_pool', extSell: null };
  }
  if (!extSell || extSell.usd < cfg.flowGateMinExtSellUsd) {
    return { pass: false, reason: 'no_ext_sell', extSell: extSell ?? null };
  }
  if (cfg.flowGateMaxExtSellUsd > 0 && extSell.usd > cfg.flowGateMaxExtSellUsd) {
    return { pass: false, reason: 'whale_dump', extSell };
  }
  if (cfg.flowGateMaxLagSec > 0 && extSell.lagSec > cfg.flowGateMaxLagSec) {
    return { pass: false, reason: 'lag_too_slow', extSell };
  }
  return { pass: true, extSell };
}

/** Largest external pool sell on mint before leader buy (excludes leader wallet). */
export async function scanPriorPoolExtSell(args: {
  rpcUrl: string;
  pool: string;
  mint: string;
  leaderWallet: string;
  beforeSig: string;
  leaderTsSec: number;
  lookbackSec: number;
  minUsd: number;
  txCap: number;
}): Promise<PriorExtSellHit | null> {
  const lo = args.leaderTsSec - args.lookbackSec;
  let best: PriorExtSellHit | null = null;
  let before: string | undefined = args.beforeSig;
  let fetched = 0;

  for (let page = 0; page < 8 && fetched < args.txCap; page++) {
    const opts: { limit: number; before?: string } = { limit: 100 };
    if (before) opts.before = before;
    const chunk = await rpcCall<SignatureRow[]>(args.rpcUrl, 'getSignaturesForAddress', [args.pool, opts], 6);
    if (!chunk?.length) break;

    let stop = false;
    for (const row of chunk) {
      if (fetched >= args.txCap) break;
      const bt = row.blockTime ?? 0;
      if (bt < lo) {
        stop = true;
        break;
      }
      if (row.err || bt > args.leaderTsSec) continue;
      fetched += 1;
      const raw = await fetchParsedTransaction(args.rpcUrl, row.signature);
      if (!raw) continue;
      const swaps = decodeAllowlistedDexSwapInserts(raw as TxJsonParsed, PUMP_FUN_PROGRAM_ID, getSolUsd());
      for (const s of swaps) {
        if (s.baseMint !== args.mint || s.wallet === args.leaderWallet || s.dex !== 'pumpswap' || s.side !== 'sell') {
          continue;
        }
        if (s.amountUsd < args.minUsd) continue;
        const lagSec = args.leaderTsSec - bt;
        if (!best || s.amountUsd > best.usd) {
          best = { usd: s.amountUsd, lagSec, signature: row.signature };
        }
      }
      await sleep(45);
    }
    if (stop) break;
    before = chunk.at(-1)?.signature;
    if (chunk.length < 100) break;
    await sleep(50);
  }
  return best;
}

export async function checkFlowEntryGate(
  cfg: PumpswapComboFollowConfig,
  args: {
    pool: string | null | undefined;
    mint: string;
    leaderSignature: string;
    leaderTsSec: number | undefined;
  },
): Promise<FlowEntryGateVerdict> {
  if (cfg.entryGate !== 'flow') {
    return { pass: true, extSell: null };
  }
  const leaderTsSec = args.leaderTsSec ?? Math.floor(Date.now() / 1000);
  const extSell = args.pool
    ? await scanPriorPoolExtSell({
        rpcUrl: cfg.rpcUrl,
        pool: args.pool,
        mint: args.mint,
        leaderWallet: cfg.targetWallet,
        beforeSig: args.leaderSignature,
        leaderTsSec,
        lookbackSec: cfg.flowGateLookbackSec,
        minUsd: 1,
        txCap: cfg.flowGatePoolTxCap,
      })
    : null;
  return evaluateFlowEntryGate(cfg, args.pool, extSell);
}
