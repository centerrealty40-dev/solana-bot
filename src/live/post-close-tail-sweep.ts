/**
 * After a full live close (`live_position_close`), optionally wait and sell any SPL dust left on the wallet.
 */
import {
  fetchJupiterTokenUsdPrice,
  fetchLatestSnapshotPrice,
} from '../papertrader/pricing.js';
import type { DexSource } from '../papertrader/types.js';
import { executeLiveTokenToSolPipeline } from './phase4-execution.js';
import type { LiveOscarConfig } from './config.js';
import { fetchLiveWalletSplBalancesByMint } from './reconcile-live.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';

const pendingByMint = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleLivePostCloseTailSweep(args: {
  liveCfg: LiveOscarConfig | undefined;
  mint: string;
  symbol: string;
  decimals: number;
  /** Last known USD/token at close (fallback if fresh price missing). */
  priceUsdPerToken: number;
  dexSource?: string;
}): void {
  const liveCfg = args.liveCfg;
  if (!liveCfg) return;
  const delayMs = liveCfg.livePostCloseTailSweepDelayMs;
  if (!(delayMs > 0)) return;
  if (!liveCfg.strategyEnabled || liveCfg.executionMode !== 'live') return;

  const mint = args.mint;
  const prev = pendingByMint.get(mint);
  if (prev !== undefined) clearTimeout(prev);

  const handle = setTimeout(() => {
    pendingByMint.delete(mint);
    void runLivePostCloseTailSweep({
      liveCfg,
      mint,
      symbol: args.symbol,
      decimals: args.decimals,
      hintPriceUsdPerToken: args.priceUsdPerToken,
      dexSource: args.dexSource,
    });
  }, delayMs);
  pendingByMint.set(mint, handle);
}

async function runLivePostCloseTailSweep(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  symbol: string;
  decimals: number;
  hintPriceUsdPerToken: number;
  dexSource?: string;
}): Promise<void> {
  const { liveCfg, mint, symbol } = args;
  const dec = Math.min(24, Math.max(0, Math.floor(args.decimals)));

  try {
    const chain = await fetchLiveWalletSplBalancesByMint(liveCfg);
    if (!chain) {
      appendLiveJsonlEvent({
        kind: 'live_post_close_tail',
        mint,
        ok: false,
        note: 'spl_balance_rpc_null',
      });
      return;
    }
    const raw = chain.get(mint) ?? 0n;
    if (raw === 0n) {
      appendLiveJsonlEvent({
        kind: 'live_post_close_tail',
        mint,
        ok: true,
        note: 'zero_balance',
      });
      return;
    }

    const src = args.dexSource as DexSource | undefined;
    const dex =
      src && ['raydium', 'meteora', 'orca', 'moonshot', 'pumpswap'].includes(src)
        ? (src as 'raydium' | 'meteora' | 'orca' | 'moonshot' | 'pumpswap')
        : undefined;
    let px = await fetchLatestSnapshotPrice(mint, dex);
    if (px == null || !(px > 0)) {
      px = await fetchJupiterTokenUsdPrice(mint);
    }
    if (px == null || !(px > 0)) {
      px = args.hintPriceUsdPerToken > 0 ? args.hintPriceUsdPerToken : null;
    }
    if (px == null || !(px > 0)) {
      appendLiveJsonlEvent({
        kind: 'live_post_close_tail',
        mint,
        ok: false,
        note: 'no_price',
        rawAtoms: raw.toString(),
      });
      return;
    }

    const tokens = Number(raw) / 10 ** dec;
    const estUsd = Number.isFinite(tokens) && tokens > 0 ? tokens * px : 0;
    const floorUsd = liveCfg.livePostCloseTailSweepMinUsd;
    const usdNotional = Math.max(estUsd, floorUsd);

    const res = await executeLiveTokenToSolPipeline(liveCfg, {
      mint,
      symbol,
      usdNotional,
      priceUsdPerToken: px,
      decimals: dec,
      intentKind: 'sell_full',
    });

    appendLiveJsonlEvent({
      kind: 'live_post_close_tail',
      mint,
      ok: res.ok,
      note: res.ok ? 'sweep_ok' : 'sweep_failed',
      rawAtoms: raw.toString(),
      estUsd: +estUsd.toFixed(8),
    });
  } catch (e) {
    appendLiveJsonlEvent({
      kind: 'live_post_close_tail',
      mint,
      ok: false,
      note: (e as Error)?.message?.slice(0, 200) ?? 'tail_err',
    });
  }
}
