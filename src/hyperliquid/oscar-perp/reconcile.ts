import type { HlTwapExchangeClient } from '../twap/live/exchange-client.js';
import type { OscarUniverseCoin } from './universe.js';
import type { HlOscarPerpConfig } from './config.js';
import { appendOscarJournal } from './journal.js';
import {
  countOpensByMode,
  loadCoinsFromJournalHistory,
  reconcileWithTracker,
  type OscarReconcileResult,
} from '../oscar-reconcile-core.js';
import type { OscarTraderState } from './trader.js';

export { countOpensByMode as countOscarOpensByMode };

function markPxMap(universe: OscarUniverseCoin[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of universe) m.set(c.coin, c.midPx);
  return m;
}

/** Startup + every-tick reconcile: HL clearinghouse is ground truth. */
export async function reconcileOscarWithHl(args: {
  cfg: HlOscarPerpConfig;
  client: HlTwapExchangeClient;
  state: OscarTraderState;
  universe: OscarUniverseCoin[];
  purgePaperOpens?: boolean;
}): Promise<OscarReconcileResult> {
  const { cfg, client, state, universe } = args;
  return reconcileWithTracker({
    logPrefix: '[hl-oscar-perp]',
    mode: cfg.mode,
    masterAddress: cfg.masterAddress,
    client,
    state,
    universeCoins: new Set(universe.map((c) => c.coin)),
    journalCoins: loadCoinsFromJournalHistory(cfg.journalPath),
    leverage: cfg.leverage,
    markPxByCoin: markPxMap(universe),
    appendJournal: (row) => appendOscarJournal(cfg.journalPath, row as never),
    purgePaperOpens: args.purgePaperOpens,
  });
}

/** @deprecated use reconcileOscarWithHl — kept for tests */
export async function reconcileOscarOpensForLiveMode(args: {
  cfg: HlOscarPerpConfig;
  state: OscarTraderState;
  client?: HlTwapExchangeClient;
  universe?: OscarUniverseCoin[];
}): Promise<{ paperClosed: number; exchangeOrphans: number }> {
  if (args.client && args.universe) {
    const r = await reconcileOscarWithHl({
      cfg: args.cfg,
      client: args.client,
      state: args.state,
      universe: args.universe,
      purgePaperOpens: true,
    });
    return { paperClosed: r.paperClosed, exchangeOrphans: r.exchangeOrphans };
  }
  const { reconcileWithTracker: core } = await import('../oscar-reconcile-core.js');
  const r = await core({
    logPrefix: '[hl-oscar-perp]',
    mode: args.cfg.mode,
    masterAddress: args.cfg.masterAddress,
    client: { mode: 'live', accountAddress: () => args.cfg.masterAddress } as HlTwapExchangeClient,
    state: args.state,
    universeCoins: new Set(),
    journalCoins: loadCoinsFromJournalHistory(args.cfg.journalPath),
    leverage: 2,
    markPxByCoin: new Map(),
    appendJournal: (row) => appendOscarJournal(args.cfg.journalPath, row as never),
    purgePaperOpens: true,
  });
  return { paperClosed: r.paperClosed, exchangeOrphans: r.exchangeOrphans };
}
