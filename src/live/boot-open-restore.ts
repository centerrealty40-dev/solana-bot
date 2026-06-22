/**
 * Boot recovery: wallet SPL holdings without tracker open state after truncated journal replay.
 */
import type { OpenTrade } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import { replayLiveStrategyJournalForMints } from './replay-strategy-journal.js';

/** Ignore dust SPL tails below this raw atom count on boot wallet orphan scan. */
const BOOT_WALLET_ORPHAN_MIN_RAW_ATOMS = 10_000n;

export type BootWalletOrphanRestoreResult = {
  open: Map<string, OpenTrade>;
  restoredMints: string[];
  walletMintsScanned: string[];
};

/**
 * When tail replay truncates, scan the full journal for wallet SPL mints missing from `open`.
 */
export async function restoreWalletOrphanOpensOnBoot(
  liveCfg: LiveOscarConfig,
  open: Map<string, OpenTrade>,
  opts: { journalTruncated: boolean },
): Promise<BootWalletOrphanRestoreResult> {
  const outOpen = new Map(open);
  const restoredMints: string[] = [];
  const walletMintsScanned: string[] = [];

  if (
    !opts.journalTruncated ||
    !liveCfg.strategyEnabled ||
    (liveCfg.executionMode !== 'live' && liveCfg.executionMode !== 'simulate') ||
    !liveCfg.walletSecret?.trim()
  ) {
    return { open: outOpen, restoredMints, walletMintsScanned };
  }

  const chainMap = await fetchLiveWalletSplBalancesByMint(liveCfg);
  if (!chainMap) {
    return { open: outOpen, restoredMints, walletMintsScanned };
  }

  const orphanMints: string[] = [];
  for (const [mint, atoms] of chainMap) {
    if (atoms < BOOT_WALLET_ORPHAN_MIN_RAW_ATOMS) continue;
    if (outOpen.has(mint)) continue;
    orphanMints.push(mint);
  }

  if (!orphanMints.length) {
    return { open: outOpen, restoredMints, walletMintsScanned };
  }

  walletMintsScanned.push(...orphanMints);
  const fullReplay = await replayLiveStrategyJournalForMints(
    {
      storePath: liveCfg.liveTradesPath,
      strategyId: liveCfg.strategyId,
      trustGhostPositions: liveCfg.liveReplayTrustGhostPositions,
    },
    orphanMints,
  );

  for (const mint of orphanMints) {
    const ot = fullReplay.open.get(mint);
    if (!ot) continue;
    outOpen.set(mint, ot);
    restoredMints.push(mint);
  }

  return { open: outOpen, restoredMints, walletMintsScanned };
}
