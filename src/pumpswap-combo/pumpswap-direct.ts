import BN from 'bn.js';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  sellBaseInput as calcSellBaseInput,
} from '@pump-fun/pump-swap-sdk';
import { NATIVE_MINT } from '@solana/spl-token';
import { getSolUsd } from '../papertrader/pricing.js';
import type { SwapSolanaState } from '@pump-fun/pump-swap-sdk';

let connCache: { url: string; conn: Connection } | null = null;

function connectionForRpc(rpcUrl: string): Connection {
  if (connCache?.url === rpcUrl) return connCache.conn;
  const conn = new Connection(rpcUrl, 'confirmed');
  connCache = { url: rpcUrl, conn };
  return conn;
}

export function slippagePctFromBps(bps: number): number {
  return Math.max(0, bps) / 100;
}

export function isWsolQuotedPool(state: SwapSolanaState): boolean {
  return state.pool.quoteMint.equals(NATIVE_MINT);
}

export async function loadPumpSwapState(args: {
  rpcUrl: string;
  poolAddress: string;
  user: PublicKey;
}) {
  const conn = connectionForRpc(args.rpcUrl);
  const online = new OnlinePumpAmmSdk(conn);
  return online.swapSolanaState(new PublicKey(args.poolAddress), args.user);
}

export async function quotePumpSwapExitPriceUsd(args: {
  rpcUrl: string;
  poolAddress: string;
  tokenRaw: bigint;
  user: PublicKey;
}): Promise<{ priceUsd: number | null; decimals: number }> {
  if (args.tokenRaw <= 0n) return { priceUsd: null, decimals: 6 };
  try {
    const state = await loadPumpSwapState({
      rpcUrl: args.rpcUrl,
      poolAddress: args.poolAddress,
      user: args.user,
    });
    if (!isWsolQuotedPool(state)) return { priceUsd: null, decimals: 6 };
    const { uiQuote } = calcSellBaseInput({
      base: new BN(args.tokenRaw.toString()),
      slippage: 0,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
    });
    const solUsd = getSolUsd();
    const decimals = state.baseMintAccount.decimals;
    if (!(solUsd > 0)) return { priceUsd: null, decimals };
    const tokens = Number(args.tokenRaw) / 10 ** decimals;
    if (!(tokens > 0)) return { priceUsd: null, decimals };
    const proceedsUsd = (uiQuote.toNumber() / 1e9) * solUsd;
    return { priceUsd: proceedsUsd / tokens, decimals };
  } catch {
    return { priceUsd: null, decimals: 6 };
  }
}

async function buildSignedTxB64(args: {
  connection: Connection;
  payer: Keypair;
  instructions: TransactionInstruction[];
  priorityMaxLamports: number;
}): Promise<string> {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
  ];
  if (args.priorityMaxLamports > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: args.priorityMaxLamports }),
    );
  }
  ixs.push(...args.instructions);
  const { blockhash } = await args.connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: args.payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  vtx.sign([args.payer]);
  return Buffer.from(vtx.serialize()).toString('base64');
}

export async function buildPumpSwapBuyTx(args: {
  rpcUrl: string;
  poolAddress: string;
  payer: Keypair;
  legUsd: number;
  slippageBps: number;
  priorityMaxLamports: number;
}): Promise<{ signedB64: string; quoteLamports: BN; decimals: number } | null> {
  const solUsd = getSolUsd();
  if (!(solUsd > 0) || !(args.legUsd > 0)) return null;

  const quoteLamports = new BN(Math.floor((args.legUsd / solUsd) * 1e9));
  if (quoteLamports.lte(new BN(0))) return null;

  const conn = connectionForRpc(args.rpcUrl);
  const state = await loadPumpSwapState({
    rpcUrl: args.rpcUrl,
    poolAddress: args.poolAddress,
    user: args.payer.publicKey,
  });
  if (!isWsolQuotedPool(state)) return null;

  const slippage = slippagePctFromBps(args.slippageBps);
  const swapIxs = await PUMP_AMM_SDK.buyQuoteInput(state, quoteLamports, slippage);
  const signedB64 = await buildSignedTxB64({
    connection: conn,
    payer: args.payer,
    instructions: swapIxs,
    priorityMaxLamports: args.priorityMaxLamports,
  });
  return { signedB64, quoteLamports, decimals: state.baseMintAccount.decimals };
}

export async function buildPumpSwapSellTx(args: {
  rpcUrl: string;
  poolAddress: string;
  payer: Keypair;
  baseAmountRaw: bigint;
  slippageBps: number;
  priorityMaxLamports: number;
}): Promise<{ signedB64: string; baseAmount: BN } | null> {
  if (args.baseAmountRaw <= 0n) return null;

  const baseAmount = new BN(args.baseAmountRaw.toString());
  const conn = connectionForRpc(args.rpcUrl);
  const state = await loadPumpSwapState({
    rpcUrl: args.rpcUrl,
    poolAddress: args.poolAddress,
    user: args.payer.publicKey,
  });
  if (!isWsolQuotedPool(state)) return null;

  const slippage = slippagePctFromBps(args.slippageBps);
  const swapIxs = await PUMP_AMM_SDK.sellBaseInput(state, baseAmount, slippage);
  const signedB64 = await buildSignedTxB64({
    connection: conn,
    payer: args.payer,
    instructions: swapIxs,
    priorityMaxLamports: args.priorityMaxLamports,
  });
  return { signedB64, baseAmount };
}

export function fillPriceUsdFromTokenDelta(args: {
  legUsd: number;
  tokenBefore: bigint;
  tokenAfter: bigint;
  decimals: number;
  fallbackPriceUsd: number;
}): number {
  const received = args.tokenAfter - args.tokenBefore;
  if (received <= 0n) return args.fallbackPriceUsd;
  const tokens = Number(received) / 10 ** args.decimals;
  if (!(tokens > 0)) return args.fallbackPriceUsd;
  return args.legUsd / tokens;
}
