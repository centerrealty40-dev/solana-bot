/**
 * Startup / periodic sweep: reclaim unmanaged mild-dip leftovers not in
 * `state.open`.
 *
 * 1. *pump mints — try Jupiter sell first (may recover USDC).
 * 2. On unsellable routes (dead/rug) or non-pump orphans — burn + close ATA
 *    to reclaim rent (~0.002 SOL each).
 */
import { executeCopySell } from '../copytrader/executor.js';
import type { MildDipConfig } from './config.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import {
  burnAndCloseOrphanAta,
  isOrphanSellBurnFallbackReason,
  listOrphanTokenAccounts,
  type OrphanAtaRow,
} from './orphan-janitor.js';
import { appendMildDipJournal, type MildDipState } from './state.js';
import { isMildDipOrphanMint } from './sell-settle.js';
import { HOLDING_DUST_RAW } from './sell-empty-guard.js';

export type OrphanSweepResult = {
  candidates: number;
  sold: number;
  burned: number;
  failed: number;
  skipped: number;
  reclaimedLamports: number;
};

function isSweepableRow(row: OrphanAtaRow): boolean {
  return /^\d+$/.test(row.amountRaw) && BigInt(row.amountRaw) > HOLDING_DUST_RAW;
}

async function tryBurnOrphan(args: {
  cfg: MildDipConfig;
  row: OrphanAtaRow;
  reason: string;
}): Promise<{ ok: boolean; signature?: string; reclaimedLamports: number; error?: string }> {
  const secret = args.cfg.walletSecret?.trim();
  if (!secret) {
    return { ok: false, reclaimedLamports: 0, error: 'wallet_secret_missing' };
  }
  const symbol = args.row.mint.slice(0, 6);
  appendMildDipJournal(args.cfg.journalPath, {
    kind: 'mild_dip_orphan_burn_attempt',
    mint: args.row.mint,
    symbol,
    tokenRaw: args.row.amountRaw,
    reason: args.reason,
  });
  const burned = await burnAndCloseOrphanAta({
    rpcUrl: args.cfg.rpcUrl,
    walletSecret: secret,
    row: args.row,
  });
  appendMildDipJournal(args.cfg.journalPath, {
    kind: 'mild_dip_orphan_burn_result',
    mint: args.row.mint,
    symbol,
    ok: burned.ok,
    reason: burned.error ?? null,
    signature: burned.signature ?? null,
    reclaimedLamports: burned.reclaimedLamports,
    reclaimedSol: +(burned.reclaimedLamports / 1e9).toFixed(6),
  });
  if (burned.ok) {
    console.log(
      `[mild-dip] ORPHAN_BURN ${symbol} mint=${args.row.mint.slice(0, 8)}… ` +
        `reclaimed=${(burned.reclaimedLamports / 1e9).toFixed(4)} SOL ` +
        `sig=${burned.signature?.slice(0, 12) ?? 'n/a'}`,
    );
  } else {
    console.warn(
      `[mild-dip] ORPHAN_BURN fail ${symbol} mint=${args.row.mint.slice(0, 8)}… ` +
        `${burned.error ?? 'unknown'}`,
    );
  }
  return burned;
}

export async function sweepUnmanagedPumpOrphans(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  /** Max Jupiter sells this pass. */
  maxSells?: number;
  /** Max burn+close this pass (non-pump + unsellable pump). */
  maxBurns?: number;
}): Promise<OrphanSweepResult> {
  const { cfg, state } = args;
  const maxSells = args.maxSells && args.maxSells > 0 ? args.maxSells : 25;
  const maxBurns =
    args.maxBurns && args.maxBurns > 0
      ? args.maxBurns
      : cfg.orphanJanitorMaxClose > 0
        ? cfg.orphanJanitorMaxClose
        : 25;
  const owner = cfg.walletPubkeyExpected?.trim();
  if (!owner) {
    return { candidates: 0, sold: 0, burned: 0, failed: 0, skipped: 0, reclaimedLamports: 0 };
  }

  const protect = new Set(Object.keys(state.open ?? {}));
  const rows = await listOrphanTokenAccounts({
    rpcUrl: cfg.rpcUrl,
    owner,
    protectMints: protect,
  });
  const candidates = rows.filter(isSweepableRow);
  const pumpRows = candidates.filter((r) => isMildDipOrphanMint(r.mint));

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  let sold = 0;
  let burned = 0;
  let failed = 0;
  let skipped = 0;
  let reclaimedLamports = 0;
  const burnedPubkeys = new Set<string>();
  const pendingBurn: OrphanAtaRow[] = candidates.filter((r) => !isMildDipOrphanMint(r.mint));

  // Phase 1 — sell *pump orphans when Jupiter may still route.
  for (const row of pumpRows) {
    if (state.open[row.mint]) {
      skipped += 1;
      continue;
    }
    if (sold >= maxSells) {
      pendingBurn.push(row);
      skipped += 1;
      continue;
    }
    const symbol = row.mint.slice(0, 6);
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_orphan_sweep_attempt',
      mint: row.mint,
      symbol,
      tokenRaw: row.amountRaw,
      reason: 'unmanaged_pump_not_in_open',
    });
    const res = await executeCopySell({
      cfg: copyCfg,
      mint: row.mint,
      symbol,
      entryPriceUsd: 0,
      exitPriceUsd: 0,
      sizeUsd: 0,
      fraction: 1,
      leaderSignature: `milddip_orphan_sweep_${Date.now()}`,
      sellDelayMs: 0,
      tokenRawBase: row.amountRaw,
    });
    appendMildDipJournal(cfg.journalPath, {
      kind: 'mild_dip_orphan_sweep_result',
      mint: row.mint,
      symbol,
      ok: res.ok,
      reason: res.reason ?? null,
      signature: res.signature ?? null,
      priceUsd: res.priceUsd ?? null,
    });
    if (res.ok) {
      sold += 1;
      console.log(
        `[mild-dip] ORPHAN_SWEEP sold ${symbol} mint=${row.mint.slice(0, 8)}… ` +
          `sig=${res.signature?.slice(0, 12) ?? 'n/a'}`,
      );
      continue;
    }
    console.warn(
      `[mild-dip] ORPHAN_SWEEP fail ${symbol} mint=${row.mint.slice(0, 8)}… ` +
        `${res.reason ?? 'unknown'}`,
    );
    if (
      cfg.orphanBurnFallbackEnabled &&
      cfg.executionMode === 'live' &&
      isOrphanSellBurnFallbackReason(res.reason)
    ) {
      pendingBurn.push(row);
    } else {
      failed += 1;
    }
  }

  // Phase 2 — burn+close dead / migrated orphans to reclaim rent.
  if (cfg.orphanBurnFallbackEnabled && cfg.executionMode === 'live') {
    const seen = new Set<string>();
    for (const row of pendingBurn) {
      if (seen.has(row.pubkey)) continue;
      seen.add(row.pubkey);
      if (burnedPubkeys.has(row.pubkey) || state.open[row.mint]) continue;
      if (burned >= maxBurns) {
        skipped += 1;
        continue;
      }
      const burn = await tryBurnOrphan({
        cfg,
        row,
        reason: isMildDipOrphanMint(row.mint) ? 'unsellable_pump_orphan' : 'non_pump_orphan',
      });
      if (burn.ok) {
        burned += 1;
        burnedPubkeys.add(row.pubkey);
        reclaimedLamports += burn.reclaimedLamports;
      } else {
        failed += 1;
      }
    }
  }

  return {
    candidates: candidates.length,
    sold,
    burned,
    failed,
    skipped,
    reclaimedLamports,
  };
}
