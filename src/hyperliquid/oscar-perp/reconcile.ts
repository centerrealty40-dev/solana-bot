import { fetchHlClearinghousePositions } from '../twap/hyperliquid-meta.js';
import type { HlOscarPerpConfig } from './config.js';
import { appendOscarJournal } from './journal.js';
import type { OscarOpenPosition } from './position-types.js';
import type { OscarTraderState } from './trader.js';

function closePhantomJournalOpen(args: {
  cfg: HlOscarPerpConfig;
  state: OscarTraderState;
  pos: OscarOpenPosition;
  reason: 'PAPER_STALE' | 'EXCHANGE_ORPHAN';
}): void {
  const { cfg, state, pos, reason } = args;
  const holdHours = (Date.now() - pos.entryTs) / 3_600_000;
  appendOscarJournal(cfg.journalPath, {
    kind: 'close',
    ts: Date.now(),
    id: pos.id,
    coin: pos.coin,
    reason,
    exitPx: pos.avgEntryPx,
    pnlUsd: 0,
    pnlPct: 0,
    holdHours,
    mode: 'live',
  });
  state.opens.delete(pos.id);
  state.openByCoin.delete(pos.coin);
  state.openModes.delete(pos.id);
}

/**
 * On live startup: drop paper journal opens and journal-only live opens with no HL position.
 * Prevents dashboard / trader from treating dry_run fills as real exposure.
 */
export async function reconcileOscarOpensForLiveMode(args: {
  cfg: HlOscarPerpConfig;
  state: OscarTraderState;
}): Promise<{ paperClosed: number; exchangeOrphans: number }> {
  const { cfg, state } = args;
  if (cfg.mode !== 'live') return { paperClosed: 0, exchangeOrphans: 0 };

  let paperClosed = 0;
  for (const [id, pos] of [...state.opens.entries()]) {
    if (state.openModes.get(id) !== 'dry_run') continue;
    closePhantomJournalOpen({ cfg, state, pos, reason: 'PAPER_STALE' });
    paperClosed += 1;
    console.warn(
      `[hl-oscar-perp:reconcile] closed paper journal open ${pos.coin} (${id.slice(0, 8)}) — not on exchange`,
    );
  }

  let exchangeOrphans = 0;
  if (state.opens.size > 0) {
    const onExchange = new Set(
      (await fetchHlClearinghousePositions(cfg.masterAddress)).map((p) => p.coin),
    );
    for (const [id, pos] of [...state.opens.entries()]) {
      if (state.openModes.get(id) !== 'live') continue;
      if (onExchange.has(pos.coin)) continue;
      closePhantomJournalOpen({ cfg, state, pos, reason: 'EXCHANGE_ORPHAN' });
      exchangeOrphans += 1;
      console.warn(
        `[hl-oscar-perp:reconcile] closed journal orphan ${pos.coin} (${id.slice(0, 8)}) — missing on HL`,
      );
    }
  }

  if (paperClosed > 0 || exchangeOrphans > 0) {
    console.log(
      `[hl-oscar-perp:reconcile] paperClosed=${paperClosed} exchangeOrphans=${exchangeOrphans} remaining=${state.opens.size}`,
    );
  }

  return { paperClosed, exchangeOrphans };
}

export function countOscarOpensByMode(state: OscarTraderState): {
  live: number;
  paper: number;
} {
  let live = 0;
  let paper = 0;
  for (const id of state.opens.keys()) {
    if (state.openModes.get(id) === 'live') live += 1;
    else paper += 1;
  }
  return { live, paper };
}
