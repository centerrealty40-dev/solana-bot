import { COPY_TRADER_RISKY_WALLET_PUBKEY } from './isolation.js';
import type { CopyTraderConfig } from './config.js';
import { cancelPendingBuysForMint } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import { appendCopyEvent } from './executor.js';
import { fetchWalletMintBalanceRaw } from './rpc.js';
import type { CopyPosition, CopyTraderState } from './state.js';

/** SPL UI amount scale used across copy-trader journal/state. */
export const COPY_TRADER_TOKEN_UI_SCALE = 1_000_000;

/** Do not ghost-clear a position shortly after entry (RPC ATA indexing lag). */
export const COPY_TRADER_GHOST_RECONCILE_GRACE_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function executionWalletPubkey(cfg: CopyTraderConfig): string {
  return cfg.walletPubkeyExpected ?? COPY_TRADER_RISKY_WALLET_PUBKEY;
}

export async function fetchExecutionWalletBalanceRaw(cfg: CopyTraderConfig, mint: string): Promise<bigint> {
  return fetchWalletMintBalanceRaw(cfg.rpcUrl, executionWalletPubkey(cfg), mint);
}

/** Retry zero reads — Helius/RPC often lags right after a confirmed buy. */
export async function fetchExecutionWalletBalanceRawRetry(
  cfg: CopyTraderConfig,
  mint: string,
  opts?: { attempts?: number; delayMs?: number },
): Promise<bigint> {
  const attempts = opts?.attempts ?? 3;
  const delayMs = opts?.delayMs ?? 2000;
  let last = 0n;
  for (let i = 0; i < attempts; i++) {
    last = await fetchExecutionWalletBalanceRaw(cfg, mint);
    if (last > 0n) return last;
    if (i < attempts - 1) await sleep(delayMs);
  }
  return last;
}

/** USD notional for raw SPL balance at a given token price. */
export function walletNotionalUsdFromRaw(tokenRaw: bigint, priceUsd: number): number {
  if (tokenRaw <= 0n || !(priceUsd > 0)) return 0;
  const tokens = Number(tokenRaw) / COPY_TRADER_TOKEN_UI_SCALE;
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.round(tokens * priceUsd * 100) / 100;
}

/** Mirror leader % off actual wallet holdings (manual buys/sells included). */
export function syncPositionFromWallet(pos: CopyPosition, tokenRaw: bigint, priceUsd: number): number {
  pos.tokenRaw = tokenRaw > 0n ? tokenRaw.toString() : undefined;
  const notional = walletNotionalUsdFromRaw(tokenRaw, priceUsd);
  if (notional > 0) pos.sizeUsd = notional;
  return notional;
}

export function ensurePositionFromWallet(
  state: CopyTraderState,
  args: {
    mint: string;
    symbol: string;
    tokenRaw: bigint;
    priceUsd: number;
    leaderWallet: string;
  },
): CopyPosition {
  const { mint, symbol, tokenRaw, priceUsd, leaderWallet } = args;
  const existing = state.positions[mint];
  if (existing) {
    syncPositionFromWallet(existing, tokenRaw, priceUsd);
    return existing;
  }
  const sizeUsd = walletNotionalUsdFromRaw(tokenRaw, priceUsd);
  const pos: CopyPosition = {
    mint,
    symbol,
    entryTs: Date.now(),
    entryPriceUsd: priceUsd > 0 ? priceUsd : 0,
    sizeUsd,
    tokenRaw: tokenRaw > 0n ? tokenRaw.toString() : undefined,
    addCount: 0,
    leaderWallet,
    leaderEntrySig: '',
  };
  state.positions[mint] = pos;
  return pos;
}

/** After any trade: align state to on-chain wallet (source of truth). */
export async function refreshPositionFromWallet(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  mint: string,
  priceUsd: number,
): Promise<bigint> {
  const bal = await fetchExecutionWalletBalanceRawRetry(cfg, mint);
  const pos = state.positions[mint];
  if (bal === 0n) {
    if (pos) {
      delete state.positions[mint];
      cancelPendingBuysForMint(state, mint, 'any');
      cancelPendingSellsForMint(state, mint);
    }
    return 0n;
  }
  if (pos) syncPositionFromWallet(pos, bal, priceUsd);
  return bal;
}

/** Drop state row when execution wallet holds no tokens (manual exit / drift). */
export async function reconcileGhostPositions(cfg: CopyTraderConfig, state: CopyTraderState): Promise<number> {
  const wallet = executionWalletPubkey(cfg);
  const now = Date.now();
  let cleared = 0;
  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    if (now - pos.entryTs < COPY_TRADER_GHOST_RECONCILE_GRACE_MS) continue;

    const stateRaw = pos.tokenRaw ? BigInt(pos.tokenRaw) : 0n;
    const bal =
      stateRaw > 0n
        ? await fetchExecutionWalletBalanceRawRetry(cfg, mint, { attempts: 3, delayMs: 2000 })
        : await fetchWalletMintBalanceRaw(cfg.rpcUrl, wallet, mint);

    if (bal !== 0n) {
      syncPositionFromWallet(pos, bal, pos.entryPriceUsd);
      continue;
    }

    delete state.positions[mint];
    cancelPendingBuysForMint(state, mint, 'any');
    cancelPendingSellsForMint(state, mint);
    cleared += 1;
    appendCopyEvent(cfg, {
      kind: 'position_closed_wallet_empty',
      mint,
      symbol: pos.symbol,
      reason: 'wallet_balance_zero',
    });
  }
  return cleared;
}

export function closePositionForMint(
  cfg: CopyTraderConfig,
  state: CopyTraderState,
  mint: string,
  reason: string,
): boolean {
  const pos = state.positions[mint];
  if (!pos) return false;
  delete state.positions[mint];
  cancelPendingBuysForMint(state, mint, 'any');
  cancelPendingSellsForMint(state, mint);
  appendCopyEvent(cfg, {
    kind: 'position_closed_wallet_empty',
    mint,
    symbol: pos.symbol,
    reason,
  });
  return true;
}
