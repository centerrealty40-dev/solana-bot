/**
 * Copy handoff lifecycle: Oscar owns exit after `copy_oscar_exit_handoff`.
 * Guards against ghost adopt → PERIODIC_HEAL close loops on empty wallets.
 */
import type { ClosedTrade, OpenTrade } from '../papertrader/types.js';
import {
  finalizeCopyLeaderOscarHandoffClose,
  isOscarHandoffClosedMint,
  readCopyLeaderMintAttribution,
} from './copy-leader-attribution.js';

/** SPL dust — below this raw balance, treat wallet as empty for handoff adopt. */
export const COPY_HANDOFF_WALLET_DUST_RAW = 1n;

export function shouldSkipCopyLeaderExitAdopt(args: {
  mint: string;
  statePath?: string;
  chainRaw?: bigint;
  closedTrades?: readonly ClosedTrade[];
  open?: ReadonlyMap<string, OpenTrade>;
}): string | null {
  const mint = args.mint.trim();
  if (!mint) return 'empty_mint';

  const attr = readCopyLeaderMintAttribution(mint, args.statePath);
  if (!attr?.oscarPromotedAt) return 'not_promoted';

  if (isOscarHandoffClosedMint(mint, { promotedAt: attr.oscarPromotedAt })) {
    return 'oscar_handoff_closed_session';
  }

  if (args.chainRaw != null && args.chainRaw <= COPY_HANDOFF_WALLET_DUST_RAW) {
    return 'wallet_spl_zero';
  }

  if (args.closedTrades?.length) {
    for (let i = args.closedTrades.length - 1; i >= 0; i--) {
      const ct = args.closedTrades[i];
      if (ct?.mint !== mint) continue;
      if (ct.exitTs >= (attr.oscarPromotedAt ?? 0)) return 'oscar_already_closed';
      break;
    }
  }

  if (args.open) {
    const ot = args.open.get(mint);
    if (ot?.copyToOscarPromoted && (ot.remainingFraction ?? 1) <= 1e-6) {
      return 'open_remaining_zero';
    }
  }

  return null;
}

/** Notify copy-trader sidecar state after Oscar full close on a promoted handoff mint. */
export function onOscarFullCloseCopyHandoffMint(args: {
  mint: string;
  openTrade?: OpenTrade;
  statePath?: string;
}): boolean {
  if (!args.openTrade?.copyToOscarPromoted) {
    const attr = readCopyLeaderMintAttribution(args.mint, args.statePath);
    if (!attr?.oscarPromotedAt) return false;
  }
  return finalizeCopyLeaderOscarHandoffClose({
    mint: args.mint,
    statePath: args.statePath,
  });
}
