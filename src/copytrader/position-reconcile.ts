import { COPY_TRADER_RISKY_WALLET_PUBKEY, LIVE_OSCAR_MAIN_PUBKEY } from './isolation.js';
import type { CopyTraderConfig } from './config.js';
import { cancelPendingBuysForMint } from './pending-buy-retry.js';
import { cancelPendingSellsForMint } from './pending-sell-retry.js';
import { appendCopyEvent } from './executor.js';
import { fetchWalletMintBalanceRaw } from './rpc.js';
import { leaderPreBalanceRaw } from './leader-ledger.js';
import { readCopyTraderState } from './state.js';
import { COPY_LEADER_POSITION_SOURCE, type CopyPosition, type CopyTraderState } from './state.js';

/** SPL UI amount scale used across copy-trader journal/state. */
export const COPY_TRADER_TOKEN_UI_SCALE = 1_000_000;

/** Do not ghost-clear a position shortly after entry (RPC ATA indexing lag). */
export const COPY_TRADER_GHOST_RECONCILE_GRACE_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function executionWalletPubkey(cfg: CopyTraderConfig): string {
  if (cfg.sharedOscarWallet) return LIVE_OSCAR_MAIN_PUBKEY;
  return cfg.walletPubkeyExpected ?? COPY_TRADER_RISKY_WALLET_PUBKEY;
}

/** Copy-attributed token raw (never full wallet balance in shared mode). */
export function copyTrackedTokenRaw(pos: CopyPosition | undefined): bigint {
  if (!pos?.tokenRaw) return 0n;
  try {
    return BigInt(pos.tokenRaw);
  } catch {
    return 0n;
  }
}

export function accumulateCopyTokenRaw(pos: CopyPosition, addedRaw: bigint | string | undefined): void {
  if (addedRaw == null) return;
  const add = typeof addedRaw === 'string' ? BigInt(addedRaw) : addedRaw;
  if (add <= 0n) return;
  const prev = copyTrackedTokenRaw(pos);
  pos.tokenRaw = (prev + add).toString();
}

/** Mirror leader % off copy-attributed holdings (shared wallet) or wallet (legacy). */
export function syncPositionFromWallet(
  pos: CopyPosition,
  tokenRaw: bigint,
  priceUsd: number,
  cfg?: CopyTraderConfig,
): number {
  if (cfg?.sharedOscarWallet) {
    const tracked = copyTrackedTokenRaw(pos);
    pos.tokenRaw = tracked > 0n ? tracked.toString() : pos.tokenRaw;
    const notional = walletNotionalUsdFromRaw(tracked, priceUsd);
    if (priceUsd > 0) pos.sizeUsd = notional;
    return notional;
  }
  pos.tokenRaw = tokenRaw > 0n ? tokenRaw.toString() : undefined;
  const notional = walletNotionalUsdFromRaw(tokenRaw, priceUsd);
  // Only a known price may rewrite the notional; a price outage must not zero a
  // live position. A known price that values the balance at ~0 MUST rewrite it,
  // otherwise a swept position keeps reporting its last full size forever and
  // the exit policy keeps scheduling real sells against a phantom.
  if (priceUsd > 0) pos.sizeUsd = notional;
  return notional;
}

/**
 * Residue too small to exit: a sub-cent leftover leg, or an unroutable balance
 * a swap already swept. Left open, such a position keeps the exit policy firing
 * sells that no venue will quote.
 */
export function copyPositionIsDust(
  cfg: CopyTraderConfig,
  tokenRaw: bigint,
  priceUsd: number,
): boolean {
  if (tokenRaw <= 0n) return true;
  if (cfg.dustMinTokenRaw > 0 && tokenRaw < BigInt(cfg.dustMinTokenRaw)) return true;
  if (cfg.dustMinUsd > 0 && priceUsd > 0) {
    const tokens = Number(tokenRaw) / COPY_TRADER_TOKEN_UI_SCALE;
    if (Number.isFinite(tokens) && tokens * priceUsd < cfg.dustMinUsd) return true;
  }
  return false;
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

export async function fetchExecutionWalletBalanceRaw(cfg: CopyTraderConfig, mint: string): Promise<bigint> {
  return fetchWalletMintBalanceRaw(cfg.rpcUrl, executionWalletPubkey(cfg), mint);
}

/** Balance copy-trader may sell (tracked leg only when sharing oscar wallet). */
export function copySellableTokenRaw(cfg: CopyTraderConfig, pos: CopyPosition | undefined): bigint {
  if (cfg.sharedOscarWallet) return copyTrackedTokenRaw(pos);
  if (pos?.tokenRaw) return copyTrackedTokenRaw(pos);
  return 0n;
}

/** USD notional for raw SPL balance at a given token price. */
export function walletNotionalUsdFromRaw(tokenRaw: bigint, priceUsd: number): number {
  if (tokenRaw <= 0n || !(priceUsd > 0)) return 0;
  const tokens = Number(tokenRaw) / COPY_TRADER_TOKEN_UI_SCALE;
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.round(tokens * priceUsd * 100) / 100;
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
  cfg?: CopyTraderConfig,
): CopyPosition {
  const { mint, symbol, tokenRaw, priceUsd, leaderWallet } = args;
  const existing = state.positions[mint];
  if (existing) {
    syncPositionFromWallet(existing, tokenRaw, priceUsd, cfg);
    return existing;
  }
  const trackedRaw = cfg?.sharedOscarWallet ? 0n : tokenRaw;
  const sizeUsd = walletNotionalUsdFromRaw(trackedRaw, priceUsd);
  const pos: CopyPosition = {
    mint,
    symbol,
    positionSource: COPY_LEADER_POSITION_SOURCE,
    entryTs: Date.now(),
    entryPriceUsd: priceUsd > 0 ? priceUsd : 0,
    sizeUsd,
    tokenRaw: trackedRaw > 0n ? trackedRaw.toString() : undefined,
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
  const pos = state.positions[mint];
  if (cfg.sharedOscarWallet) {
    if (pos?.oscarPromotedAt) return copyTrackedTokenRaw(pos);
    const tracked = copyTrackedTokenRaw(pos);
    if (copyPositionIsDust(cfg, tracked, priceUsd)) {
      if (pos) {
        delete state.positions[mint];
        cancelPendingBuysForMint(state, mint, 'any');
        cancelPendingSellsForMint(state, mint);
      }
      return 0n;
    }
    if (pos) syncPositionFromWallet(pos, tracked, priceUsd, cfg);
    return tracked;
  }

  const bal = await fetchExecutionWalletBalanceRawRetry(cfg, mint);
  if (copyPositionIsDust(cfg, bal, priceUsd)) {
    if (pos) {
      delete state.positions[mint];
      cancelPendingBuysForMint(state, mint, 'any');
      cancelPendingSellsForMint(state, mint);
    }
    return 0n;
  }
  if (pos) syncPositionFromWallet(pos, bal, priceUsd, cfg);
  return bal;
}

/** Drop in-memory promoted rows Oscar cleared on disk (avoid clobbering external state writes). */
export function reconcileOscarHandoffClosedFromDisk(cfg: CopyTraderConfig, state: CopyTraderState): number {
  let disk: CopyTraderState;
  try {
    disk = readCopyTraderState(cfg.statePath);
  } catch {
    return 0;
  }
  let cleared = 0;
  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    if (!pos.oscarPromotedAt) continue;
    if (disk.positions[mint]) continue;
    delete state.positions[mint];
    cancelPendingBuysForMint(state, mint, 'any');
    cancelPendingSellsForMint(state, mint);
    cleared += 1;
    appendCopyEvent(cfg, {
      kind: 'position_closed_wallet_empty',
      mint,
      symbol: pos.symbol,
      reason: 'oscar_handoff_closed',
    });
  }
  return cleared;
}

/** Oscar-managed handoff: clear when leader flat and copy leg is zero (DdPrHY stale state). */
async function reconcileOscarPromotedFlat(cfg: CopyTraderConfig, state: CopyTraderState): Promise<number> {
  let cleared = 0;
  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    if (!pos.oscarPromotedAt) continue;
    const tracked = copyTrackedTokenRaw(pos);
    const leaderRaw = leaderPreBalanceRaw(state, mint);
    if (tracked > 0n || leaderRaw > 0n) continue;

    if (cfg.sharedOscarWallet) {
      delete state.positions[mint];
      cancelPendingBuysForMint(state, mint, 'any');
      cancelPendingSellsForMint(state, mint);
      cleared += 1;
      appendCopyEvent(cfg, {
        kind: 'position_closed_wallet_empty',
        mint,
        symbol: pos.symbol,
        reason: 'oscar_handoff_leader_flat',
      });
      continue;
    }

    const bal = await fetchExecutionWalletBalanceRawRetry(cfg, mint, { attempts: 2, delayMs: 1500 });
    if (bal !== 0n) continue;

    delete state.positions[mint];
    cancelPendingBuysForMint(state, mint, 'any');
    cancelPendingSellsForMint(state, mint);
    cleared += 1;
    appendCopyEvent(cfg, {
      kind: 'position_closed_wallet_empty',
      mint,
      symbol: pos.symbol,
      reason: 'oscar_handoff_wallet_empty',
    });
  }
  return cleared;
}

/** Drop state row when execution wallet holds no tokens (manual exit / drift). */
export async function reconcileGhostPositions(cfg: CopyTraderConfig, state: CopyTraderState): Promise<number> {
  let cleared = reconcileOscarHandoffClosedFromDisk(cfg, state);
  cleared += await reconcileOscarPromotedFlat(cfg, state);

  const wallet = executionWalletPubkey(cfg);
  const now = Date.now();
  for (const [mint, pos] of Object.entries({ ...state.positions })) {
    if (pos.oscarPromotedAt) continue;
    if (now - pos.entryTs < COPY_TRADER_GHOST_RECONCILE_GRACE_MS) continue;

    const stateRaw = pos.tokenRaw ? BigInt(pos.tokenRaw) : 0n;
    const bal =
      stateRaw > 0n
        ? await fetchExecutionWalletBalanceRawRetry(cfg, mint, { attempts: 3, delayMs: 2000 })
        : await fetchWalletMintBalanceRaw(cfg.rpcUrl, wallet, mint);

    const dust = copyPositionIsDust(cfg, bal, pos.entryPriceUsd);
    if (!dust) {
      syncPositionFromWallet(pos, bal, pos.entryPriceUsd, cfg);
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
      reason: bal === 0n ? 'wallet_balance_zero' : 'wallet_balance_dust',
      tokenRaw: bal.toString(),
      staleSizeUsd: pos.sizeUsd,
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
