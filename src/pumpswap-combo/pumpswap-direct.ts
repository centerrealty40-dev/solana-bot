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
import { QUOTE_MINTS } from '../core/constants.js';
import { getSolUsd } from '../papertrader/pricing.js';
import type { SwapSolanaState } from '@pump-fun/pump-swap-sdk';

/** Read-only PumpSwap state probe user (no signing). */
const POOL_PROBE_USER = new PublicKey('11111111111111111111111111111111');

let connCache: { url: string; conn: Connection } | null = null;

let comboRpcHook: { beforeCall?: () => Promise<void> } | null = null;

export function setComboRpcHook(hook: { beforeCall?: () => Promise<void> } | null): void {
  comboRpcHook = hook;
}

async function beforeComboRpc(): Promise<void> {
  await comboRpcHook?.beforeCall?.();
}

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

export function isUsdcQuotedPool(state: SwapSolanaState): boolean {
  return state.pool.quoteMint.toBase58() === QUOTE_MINTS.USDC;
}

/** Pools the direct PumpSwap executor can buy/sell (WSOL or USDC quote). */
export function isTradablePumpPool(state: SwapSolanaState): boolean {
  return isWsolQuotedPool(state) || isUsdcQuotedPool(state);
}

export async function loadPumpSwapState(args: {
  rpcUrl: string;
  poolAddress: string;
  user: PublicKey;
}) {
  await beforeComboRpc();
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
    if (!isTradablePumpPool(state)) return { priceUsd: null, decimals: 6 };
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
    const decimals = state.baseMintAccount.decimals;
    const tokens = Number(args.tokenRaw) / 10 ** decimals;
    if (!(tokens > 0)) return { priceUsd: null, decimals };
    const proceedsUsd = isUsdcQuotedPool(state)
      ? uiQuote.toNumber() / 1e6
      : (uiQuote.toNumber() / 1e9) * (getSolUsd() || 0);
    if (!(proceedsUsd > 0)) return { priceUsd: null, decimals };
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
  await beforeComboRpc();
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
}): Promise<{ swapIxs: TransactionInstruction[]; quoteLamports: BN; decimals: number; solUsd: number } | null> {
  if (!(args.legUsd > 0)) return null;

  const state = await loadPumpSwapState({
    rpcUrl: args.rpcUrl,
    poolAddress: args.poolAddress,
    user: args.payer.publicKey,
  });
  if (!isTradablePumpPool(state)) return null;

  const solUsd = getSolUsd();
  const slippage = slippagePctFromBps(args.slippageBps);
  const quoteAmount = isUsdcQuotedPool(state)
    ? quoteUsdcMicroForLegUsd(args.legUsd)
    : quoteLamportsForLegUsd(args.legUsd);
  if (!quoteAmount || quoteAmount.lte(new BN(0))) return null;
  if (!isUsdcQuotedPool(state) && !(solUsd > 0)) return null;

  const swapIxs = await PUMP_AMM_SDK.buyQuoteInput(state, quoteAmount, slippage);
  return {
    swapIxs,
    quoteLamports: quoteAmount,
    decimals: state.baseMintAccount.decimals,
    solUsd: solUsd || 0,
  };
}

export async function buildPumpSwapSellTx(args: {
  rpcUrl: string;
  poolAddress: string;
  payer: Keypair;
  baseAmountRaw: bigint;
  slippageBps: number;
}): Promise<{ swapIxs: TransactionInstruction[]; baseAmount: BN } | null> {
  if (args.baseAmountRaw <= 0n) return null;

  const baseAmount = new BN(args.baseAmountRaw.toString());
  const state = await loadPumpSwapState({
    rpcUrl: args.rpcUrl,
    poolAddress: args.poolAddress,
    user: args.payer.publicKey,
  });
  if (!isTradablePumpPool(state)) return null;

  const slippage = slippagePctFromBps(args.slippageBps);
  const swapIxs = await PUMP_AMM_SDK.sellBaseInput(state, baseAmount, slippage);
  return { swapIxs, baseAmount };
}

export async function signPumpSwapInstructions(args: {
  rpcUrl: string;
  payer: Keypair;
  instructions: TransactionInstruction[];
  priorityMaxLamports: number;
}): Promise<string> {
  const conn = connectionForRpc(args.rpcUrl);
  return buildSignedTxB64({
    connection: conn,
    payer: args.payer,
    instructions: args.instructions,
    priorityMaxLamports: args.priorityMaxLamports,
  });
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

/** USDC micro-units (6 dp) for a USD leg. */
export function quoteUsdcMicroForLegUsd(legUsd: number): BN | null {
  if (!(legUsd > 0)) return null;
  const micro = Math.floor(legUsd * 1e6);
  if (micro <= 0) return null;
  return new BN(micro);
}

/** Lamports of WSOL quote for a USD leg at current getSolUsd(). */
export function quoteLamportsForLegUsd(legUsd: number): BN | null {
  const solUsd = getSolUsd();
  if (!(solUsd > 0) || !(legUsd > 0)) return null;
  const lamports = Math.floor((legUsd / solUsd) * 1e9);
  if (lamports <= 0) return null;
  return new BN(lamports);
}

/** Spot from pool reserves (no wallet balance required). */
export async function quotePumpSwapSpotPriceUsd(args: {
  rpcUrl: string;
  poolAddress: string;
}): Promise<number | null> {
  try {
    const state = await loadPumpSwapState({
      rpcUrl: args.rpcUrl,
      poolAddress: args.poolAddress,
      user: POOL_PROBE_USER,
    });
    if (!isTradablePumpPool(state)) return null;
    const solUsd = getSolUsd();
    const baseRaw = state.poolBaseAmount.toNumber();
    const quoteRaw = state.poolQuoteAmount.toNumber();
    if (!(baseRaw > 0) || !(quoteRaw > 0)) return null;
    const decimals = state.baseMintAccount.decimals;
    const tokens = baseRaw / 10 ** decimals;
    if (!(tokens > 0)) return null;
    const quoteUsd = isUsdcQuotedPool(state) ? quoteRaw / 1e6 : (quoteRaw / 1e9) * (solUsd || 0);
    if (!(quoteUsd > 0)) return null;
    return quoteUsd / tokens;
  } catch {
    return null;
  }
}
