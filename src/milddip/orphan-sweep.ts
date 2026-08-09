/**
 * Startup / periodic sweep: sell unmanaged mild-dip pump leftovers that are
 * not in `state.open` (true orphans). Prevention is settle-after-sell; this
 * is the safety net for bags created before the fix or any future hole.
 */
import { executeCopySell } from '../copytrader/executor.js';
import type { MildDipConfig } from './config.js';
import { mildDipToCopyTraderConfig } from './exec-bridge.js';
import { listOrphanTokenAccounts } from './orphan-janitor.js';
import { appendMildDipJournal, type MildDipState } from './state.js';
import { isMildDipOrphanMint } from './sell-settle.js';
import { HOLDING_DUST_RAW } from './sell-empty-guard.js';

export type OrphanSweepResult = {
  candidates: number;
  sold: number;
  failed: number;
  skipped: number;
};

export async function sweepUnmanagedPumpOrphans(args: {
  cfg: MildDipConfig;
  state: MildDipState;
  /** Max sells this pass (startup must stay bounded). */
  maxSells?: number;
}): Promise<OrphanSweepResult> {
  const { cfg, state } = args;
  const maxSells = args.maxSells && args.maxSells > 0 ? args.maxSells : 25;
  const owner = cfg.walletPubkeyExpected?.trim();
  if (!owner) {
    return { candidates: 0, sold: 0, failed: 0, skipped: 0 };
  }

  const protect = new Set(Object.keys(state.open ?? {}));
  const rows = await listOrphanTokenAccounts({
    rpcUrl: cfg.rpcUrl,
    owner,
    protectMints: protect,
  });
  const pump = rows.filter(
    (r) =>
      isMildDipOrphanMint(r.mint) &&
      /^\d+$/.test(r.amountRaw) &&
      BigInt(r.amountRaw) > HOLDING_DUST_RAW,
  );

  const copyCfg = mildDipToCopyTraderConfig(cfg);
  let sold = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of pump) {
    if (sold + failed >= maxSells) {
      skipped += 1;
      continue;
    }
    // Re-check protection — open may have gained the mint mid-sweep.
    if (state.open[row.mint]) {
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
    } else {
      failed += 1;
      console.warn(
        `[mild-dip] ORPHAN_SWEEP fail ${symbol} mint=${row.mint.slice(0, 8)}… ` +
          `${res.reason ?? 'unknown'}`,
      );
    }
  }

  return { candidates: pump.length, sold, failed, skipped };
}
