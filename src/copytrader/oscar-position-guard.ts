/**
 * When Oscar holds a mint on the shared wallet, copy-trader fully ignores the leader
 * (no mirror buy/sell, no tail sweep). Aligns with live-oscar open snapshot + handoff.
 */
import path from 'node:path';
import { readLiveOpenSnapshot } from '../live/open-snapshot.js';
import {
  isCopyLeaderPromotedToOscar,
  oscarWalletMintUsdExcludingCopyLeader,
} from '../live/copy-leader-attribution.js';
import type { CopyTraderConfig } from './config.js';
import { walletNotionalUsdFromRaw } from './position-reconcile.js';
import type { CopyPosition } from './state.js';

export type CopyLeaderIgnoreReason = 'oscar_position_open' | 'oscar_promoted_handoff';

export type CopyLeaderIgnoreVerdict =
  | { ignore: false }
  | { ignore: true; reason: CopyLeaderIgnoreReason };

export type CopyBuyOscarDupGuardReason =
  | 'already_in_oscar_position'
  | 'wallet_holds_mint_over_usd_cap'
  | 'oscar_promoted_handoff';

export type CopyBuyOscarDupGuardVerdict =
  | { skip: false }
  | { skip: true; reason: CopyBuyOscarDupGuardReason; estUsd?: number; minUsd?: number };

function envNum(name: string, def: number): number {
  const s = process.env[name]?.trim();
  if (!s) return def;
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

export function oscarOpenSnapshotPathForCopyTrader(): string {
  const p = process.env.LIVE_OPEN_SNAPSHOT_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  const trades =
    process.env.LIVE_TRADES_PATH?.trim() ||
    path.join('data', 'live', 'pt1-oscar-live.jsonl');
  const absTrades = path.isAbsolute(trades) ? trades : path.resolve(process.cwd(), trades);
  return path.resolve(path.dirname(absTrades), 'live-oscar-open-snapshot.json');
}

export function oscarPresetCOpenSnapshotPathForCopyTrader(): string {
  const p =
    process.env.COPY_TRADER_PRESET_C_OPEN_SNAPSHOT_PATH?.trim() ||
    process.env.LIVE_OSCAR_PRESET_C_OPEN_SNAPSHOT_PATH?.trim();
  if (p) return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return path.resolve(process.cwd(), 'data/live/live-oscar-preset-c-open-snapshot.json');
}

/** True when copy-trader execution wallet is the same as live-oscar-preset-c. */
export function copyTraderSharesPresetCWallet(cfg: CopyTraderConfig): boolean {
  const copyPk =
    cfg.walletPubkeyExpected?.trim() || process.env.COPY_TRADER_WALLET_PUBKEY?.trim();
  const presetPk =
    process.env.COPY_TRADER_PRESET_C_WALLET_PUBKEY?.trim() ||
    process.env.LIVE_OSCAR_PRESET_C_WALLET_PUBKEY?.trim();
  if (!copyPk || !presetPk) return false;
  return copyPk === presetPk;
}

export function oscarHasOpenPositionOnMint(mint: string, snapshotPath?: string): boolean {
  const snap = readLiveOpenSnapshot(snapshotPath ?? oscarOpenSnapshotPathForCopyTrader());
  if (!snap) return false;
  return snap.positions.some((p) => p.mint === mint);
}

function oscarHasOpenPositionOnAnySharedSnapshot(
  mint: string,
  cfg: CopyTraderConfig,
  primarySnapshotPath?: string,
): boolean {
  if (oscarHasOpenPositionOnMint(mint, primarySnapshotPath)) return true;
  if (copyTraderSharesPresetCWallet(cfg)) {
    return oscarHasOpenPositionOnMint(mint, oscarPresetCOpenSnapshotPathForCopyTrader());
  }
  return false;
}

export function skipBuyOpenWalletMintMinUsd(): number {
  return envNum('LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD', 0);
}

/**
 * Fully ignore leader actions for `mint` when Oscar already manages it or holds it open.
 */
export function shouldIgnoreLeaderForMint(args: {
  cfg: CopyTraderConfig;
  mint: string;
  copyPosition?: CopyPosition | null;
  statePath?: string;
  snapshotPath?: string;
}): CopyLeaderIgnoreVerdict {
  if (!args.cfg.sharedOscarWallet) {
    return { ignore: false };
  }

  const mint = args.mint.trim();
  const statePath = args.statePath ?? args.cfg.statePath;

  if (args.copyPosition?.oscarPromotedAt) {
    return { ignore: true, reason: 'oscar_promoted_handoff' };
  }
  if (isCopyLeaderPromotedToOscar(mint, statePath)) {
    return { ignore: true, reason: 'oscar_promoted_handoff' };
  }

  if (oscarHasOpenPositionOnAnySharedSnapshot(mint, args.cfg, args.snapshotPath)) {
    return { ignore: true, reason: 'oscar_position_open' };
  }

  return { ignore: false };
}

function leaderIgnoreToBuySkipReason(
  reason: CopyLeaderIgnoreReason,
): CopyBuyOscarDupGuardReason {
  return reason === 'oscar_position_open' ? 'already_in_oscar_position' : 'oscar_promoted_handoff';
}

/** Buy-only: wallet-hold USD cap when snapshot is stale (Oscar leg on shared wallet). */
export function checkCopyBuyWalletCapGuard(args: {
  cfg: CopyTraderConfig;
  mint: string;
  walletMintRaw?: bigint;
  priceUsd?: number;
  statePath?: string;
}): CopyBuyOscarDupGuardVerdict {
  if (!args.cfg.sharedOscarWallet) {
    return { skip: false };
  }

  const mint = args.mint.trim();
  const statePath = args.statePath ?? args.cfg.statePath;
  const minUsd = skipBuyOpenWalletMintMinUsd();
  if (minUsd > 0 && args.walletMintRaw != null && args.walletMintRaw > 0n) {
    const price = args.priceUsd ?? 0;
    if (price > 0) {
      const gross = walletNotionalUsdFromRaw(args.walletMintRaw, price);
      const est = oscarWalletMintUsdExcludingCopyLeader({
        walletMintUsd: gross,
        mint,
        statePath,
      });
      if (est >= minUsd) {
        return { skip: true, reason: 'wallet_holds_mint_over_usd_cap', estUsd: est, minUsd };
      }
    }
  }

  return { skip: false };
}

/**
 * When `COPY_TRADER_SHARED_OSCAR_WALLET=1`, block mirror buys that would duplicate Oscar's leg.
 */
export function checkCopyBuyOscarDupGuard(args: {
  cfg: CopyTraderConfig;
  mint: string;
  copyPosition?: CopyPosition | null;
  walletMintRaw?: bigint;
  priceUsd?: number;
  statePath?: string;
  snapshotPath?: string;
}): CopyBuyOscarDupGuardVerdict {
  const leaderIgnore = shouldIgnoreLeaderForMint(args);
  if (leaderIgnore.ignore) {
    return { skip: true, reason: leaderIgnoreToBuySkipReason(leaderIgnore.reason) };
  }
  return checkCopyBuyWalletCapGuard(args);
}
