/**
 * Execute wallet tail flush (sell_full) when remainder USD is below threshold or after full close.
 */
import {
  fetchJupiterTokenUsdPrice,
  fetchLatestSnapshotPrice,
} from '../papertrader/pricing.js';
import type { DexSource } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import { executeLiveTokenToSolPipeline } from './phase4-execution.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import {
  liveTailFlushSkipNote,
  type LiveTailFlushContext,
} from './tail-flush.js';

function resolveDexSource(dexSource?: string): DexSource | undefined {
  const src = dexSource as DexSource | undefined;
  if (src && ['raydium', 'meteora', 'orca', 'moonshot', 'pumpswap'].includes(src)) {
    return src as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap';
  }
  return undefined;
}

async function resolveSpotUsdPerToken(mint: string, dexSource?: string): Promise<number | null> {
  const dex = resolveDexSource(dexSource);
  let px = await fetchLatestSnapshotPrice(
    mint,
    dex as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap' | undefined,
  );
  if (px == null || !(px > 0)) {
    px = await fetchJupiterTokenUsdPrice(mint);
  }
  return px != null && px > 0 && Number.isFinite(px) ? px : null;
}

function appendTailFlushEvent(args: {
  mint: string;
  context: LiveTailFlushContext;
  ok: boolean;
  note?: string;
  estUsd?: number;
  thresholdUsd?: number;
  rawAtoms?: string;
  flushed?: boolean;
}): void {
  appendLiveJsonlEvent({
    kind: 'live_tail_flush',
    mint: args.mint,
    context: args.context,
    ok: args.ok,
    note: args.note,
    estUsd: args.estUsd != null ? +args.estUsd.toFixed(8) : undefined,
    thresholdUsd: args.thresholdUsd,
    rawAtoms: args.rawAtoms,
    flushed: args.flushed,
  });
}

export async function runLiveWalletTailFlushIfNeeded(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  symbol: string;
  decimals: number;
  hintPriceUsdPerToken: number;
  dexSource?: string;
  context: LiveTailFlushContext;
  /** post_close killstop cap — skip when balance est exceeds maxUsd (fresh re-entry guard). */
  postCloseKillstopCapMaxUsd?: number;
  postCloseKillstopCapApplies?: boolean;
  /** periodic_heal: skip balances below this USD (dust spam guard). */
  periodicMinUsd?: number;
}): Promise<{ flushed: boolean; note: string }> {
  const { liveCfg, mint, symbol, context } = args;
  const thresholdUsd = liveCfg.liveTailFlushThresholdUsd;
  const dec = Math.min(24, Math.max(0, Math.floor(args.decimals)));

  try {
    const chain = await fetchLiveWalletSplBalancesByMint(liveCfg);
    if (!chain) {
      appendTailFlushEvent({ mint, context, ok: false, note: 'spl_balance_rpc_null', thresholdUsd });
      return { flushed: false, note: 'spl_balance_rpc_null' };
    }
    const raw = chain.get(mint) ?? 0n;
    if (raw === 0n) {
      appendTailFlushEvent({ mint, context, ok: true, note: 'zero_balance', thresholdUsd });
      return { flushed: false, note: 'zero_balance' };
    }

    let px = await resolveSpotUsdPerToken(mint, args.dexSource);
    if (px == null) {
      px = args.hintPriceUsdPerToken > 0 ? args.hintPriceUsdPerToken : null;
    }
    if (px == null || !(px > 0)) {
      appendTailFlushEvent({
        mint,
        context,
        ok: false,
        note: 'no_price',
        rawAtoms: raw.toString(),
        thresholdUsd,
      });
      return { flushed: false, note: 'no_price' };
    }

    const tokens = Number(raw) / 10 ** dec;
    const estUsd = Number.isFinite(tokens) && tokens > 0 ? tokens * px : 0;

    if (context === 'periodic_heal') {
      const minUsd = args.periodicMinUsd ?? liveCfg.livePeriodicSweepMinUsd;
      if (!(estUsd >= minUsd)) {
        appendTailFlushEvent({
          mint,
          context,
          ok: true,
          note: 'below_periodic_min',
          estUsd,
          thresholdUsd,
          rawAtoms: raw.toString(),
          flushed: false,
        });
        return { flushed: false, note: 'below_periodic_min' };
      }
    }

    if (
      context === 'post_close' &&
      args.postCloseKillstopCapApplies &&
      (args.postCloseKillstopCapMaxUsd ?? 0) > 0 &&
      estUsd > (args.postCloseKillstopCapMaxUsd ?? 0)
    ) {
      appendTailFlushEvent({
        mint,
        context,
        ok: true,
        note: 'balance_above_tail_cap',
        estUsd,
        thresholdUsd,
        rawAtoms: raw.toString(),
        flushed: false,
      });
      return { flushed: false, note: 'balance_above_tail_cap' };
    }

    const skipNote = liveTailFlushSkipNote({ estUsd, thresholdUsd, context });
    if (skipNote === 'above_threshold') {
      appendTailFlushEvent({
        mint,
        context,
        ok: true,
        note: skipNote,
        estUsd,
        thresholdUsd,
        rawAtoms: raw.toString(),
        flushed: false,
      });
      return { flushed: false, note: skipNote };
    }

    const floorUsd =
      context === 'post_close'
        ? liveCfg.livePostCloseTailSweepMinUsd
        : Math.max(liveCfg.livePostCloseTailSweepMinUsd, liveCfg.livePeriodicSweepMinUsd);
    const usdNotional = Math.max(estUsd, floorUsd);

    const res = await executeLiveTokenToSolPipeline(liveCfg, {
      mint,
      symbol,
      usdNotional,
      priceUsdPerToken: px,
      decimals: dec,
      intentKind: 'sell_full',
    });

    appendTailFlushEvent({
      mint,
      context,
      ok: res.ok,
      note: res.ok ? 'flush_ok' : 'flush_failed',
      estUsd,
      thresholdUsd,
      rawAtoms: raw.toString(),
      flushed: res.ok,
    });
    return { flushed: res.ok, note: res.ok ? 'flush_ok' : 'flush_failed' };
  } catch (e) {
    const msg = (e as Error)?.message?.slice(0, 200) ?? 'tail_flush_err';
    appendTailFlushEvent({ mint, context, ok: false, note: msg, thresholdUsd });
    return { flushed: false, note: msg };
  }
}
