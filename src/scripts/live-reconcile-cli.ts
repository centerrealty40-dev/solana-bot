/**
 * One-shot replay + reconcile (+ optional tx anchor sample). Exits 1 on SPL mismatch, RPC fail, or missing tx anchor.
 */
import { loadLiveOscarConfig } from '../live/config.js';
import { reconcileLiveWalletVsReplay } from '../live/reconcile-live.js';
import {
  collectRecentConfirmedTxSignatures,
  verifyTxAnchorSample,
} from '../live/reconcile-tx-anchor-sample.js';
import { replayLiveStrategyJournal } from '../live/replay-strategy-journal.js';

async function run(): Promise<void> {
  const liveCfg = loadLiveOscarConfig();
  const replay = replayLiveStrategyJournal({
    storePath: liveCfg.liveTradesPath,
    strategyId: liveCfg.strategyId,
    tailLines: liveCfg.liveReplayTailLines,
    sinceTs: liveCfg.liveReplaySinceTs,
    maxFileBytes: liveCfg.liveReplayMaxFileBytes,
  });

  let rec = await reconcileLiveWalletVsReplay({
    liveCfg,
    open: replay.open,
    toleranceAtoms: BigInt(liveCfg.liveReconcileToleranceAtoms),
    mode: liveCfg.liveReconcileMode,
  });

  let txAnchor = undefined;
  if (liveCfg.liveReconcileTxSampleN > 0) {
    const sigs = collectRecentConfirmedTxSignatures({
      storePath: liveCfg.liveTradesPath,
      strategyId: liveCfg.strategyId,
      limit: liveCfg.liveReconcileTxSampleN,
      maxFileBytes: liveCfg.liveReplayMaxFileBytes,
    });
    txAnchor = await verifyTxAnchorSample(liveCfg, sigs);
  }

  const payload = {
    replayOpenMints: replay.open.size,
    journalReplayTruncated: Boolean(replay.journalTruncated),
    reconcile: rec,
    txAnchorSample: txAnchor,
  };
  console.log(JSON.stringify(payload, null, 2));

  const rpcFail = rec.mismatches.some((m) => m.mint === '_rpc_');
  const splBad = rpcFail || !rec.ok;
  const anchorBad =
    txAnchor != null && (txAnchor.notFound.length > 0 || txAnchor.rpcErrors > 0);
  process.exit(splBad || anchorBad ? 1 : 0);
}

run().catch((err) => {
  console.error('live-reconcile fatal', err);
  process.exit(1);
});
