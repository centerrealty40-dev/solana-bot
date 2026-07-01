/**
 * Skip copy-trader buys when live-oscar (or wallet) already holds the mint on the shared wallet.
 * Aligns with live-oscar `LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD` dup guard + open snapshot sidecar.
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

export function oscarHasOpenPositionOnMint(mint: string, snapshotPath?: string): boolean {
  const snap = readLiveOpenSnapshot(snapshotPath ?? oscarOpenSnapshotPathForCopyTrader());
  if (!snap) return false;
  return snap.positions.some((p) => p.mint === mint);
}

export function skipBuyOpenWalletMintMinUsd(): number {
  return envNum('LIVE_SKIP_BUY_OPEN_WALLET_MINT_MIN_USD', 0);
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
  if (!args.cfg.sharedOscarWallet) {
    return { skip: false };
  }

  const mint = args.mint.trim();
  const statePath = args.statePath ?? args.cfg.statePath;

  if (args.copyPosition?.oscarPromotedAt) {
    return { skip: true, reason: 'oscar_promoted_handoff' };
  }
  if (isCopyLeaderPromotedToOscar(mint, statePath)) {
    return { skip: true, reason: 'oscar_promoted_handoff' };
  }

  if (oscarHasOpenPositionOnMint(mint, args.snapshotPath)) {
    return { skip: true, reason: 'already_in_oscar_position' };
  }

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
