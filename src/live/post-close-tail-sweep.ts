/**
 * After a full live close (`live_position_close`), wait briefly and sell any SPL dust left on the wallet.
 * Retries a few times within ~2 minutes, then stops — no long-running periodic sweeps.
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

type PendingTailSweep = {
  timers: ReturnType<typeof setTimeout>[];
};

const pendingByMint = new Map<string, PendingTailSweep>();

function clearPendingTailSweep(pending: PendingTailSweep): void {
  for (const t of pending.timers) clearTimeout(t);
  pending.timers.length = 0;
}

/**
 * Сбрасывает отложенный post-close tail sweep для mint (например, новый вход по тому же mint
 * до срабатывания таймера — иначе `sell_full` снимет уже новую позицию целиком).
 */
export function cancelLivePostCloseTailSweepForMint(mint: string): void {
  const prev = pendingByMint.get(mint);
  if (prev === undefined) return;
  clearPendingTailSweep(prev);
  pendingByMint.delete(mint);
}

function scheduleTailSweepAttempt(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  symbol: string;
  decimals: number;
  hintPriceUsdPerToken: number;
  dexSource?: string;
  attempt: number;
  delayMs: number;
}): void {
  const { mint, attempt, delayMs } = args;
  let pending = pendingByMint.get(mint);
  if (!pending) {
    pending = { timers: [] };
    pendingByMint.set(mint, pending);
  }

  const handle = setTimeout(() => {
    const idx = pending!.timers.indexOf(handle);
    if (idx >= 0) pending!.timers.splice(idx, 1);
    void runLivePostCloseTailSweep({
      ...args,
      onDone: (shouldRetry) => {
        if (!shouldRetry) {
          if (pending && pending.timers.length === 0) pendingByMint.delete(mint);
          return;
        }
        const maxAttempts = args.liveCfg.livePostCloseTailSweepMaxAttempts;
        if (attempt >= maxAttempts) {
          if (pending && pending.timers.length === 0) pendingByMint.delete(mint);
          return;
        }
        const retryMs = args.liveCfg.livePostCloseTailSweepRetryMs;
        if (!(retryMs > 0)) {
          if (pending && pending.timers.length === 0) pendingByMint.delete(mint);
          return;
        }
        scheduleTailSweepAttempt({
          ...args,
          attempt: attempt + 1,
          delayMs: retryMs,
        });
      },
    });
  }, delayMs);
  pending.timers.push(handle);
}

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
  if (!(liveCfg.livePostCloseTailSweepMaxAttempts > 0)) return;

  const mint = args.mint;
  cancelLivePostCloseTailSweepForMint(mint);

  scheduleTailSweepAttempt({
    liveCfg,
    mint,
    symbol: args.symbol,
    decimals: args.decimals,
    hintPriceUsdPerToken: args.priceUsdPerToken,
    dexSource: args.dexSource,
    attempt: 1,
    delayMs,
  });
}

async function runLivePostCloseTailSweep(args: {
  liveCfg: LiveOscarConfig;
  mint: string;
  symbol: string;
  decimals: number;
  hintPriceUsdPerToken: number;
  dexSource?: string;
  attempt: number;
  onDone: (shouldRetry: boolean) => void;
}): Promise<void> {
  const { liveCfg, mint, symbol, attempt } = args;
  const dec = Math.min(24, Math.max(0, Math.floor(args.decimals)));

  try {
    const chain = await fetchLiveWalletSplBalancesByMint(liveCfg);
    if (!chain) {
      appendLiveJsonlEvent({
        kind: 'live_post_close_tail',
        mint,
        ok: false,
        note: `spl_balance_rpc_null attempt=${attempt}`,
      });
      args.onDone(true);
      return;
    }
    const raw = chain.get(mint) ?? 0n;
    if (raw === 0n) {
      appendLiveJsonlEvent({
        kind: 'live_post_close_tail',
        mint,
        ok: true,
        note: `zero_balance attempt=${attempt}`,
      });
      args.onDone(false);
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
        note: `no_price attempt=${attempt}`,
        rawAtoms: raw.toString(),
      });
      args.onDone(true);
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
      note: res.ok ? `sweep_ok attempt=${attempt}` : `sweep_failed attempt=${attempt}`,
      rawAtoms: raw.toString(),
      estUsd: +estUsd.toFixed(8),
    });
    args.onDone(true);
  } catch (e) {
    appendLiveJsonlEvent({
      kind: 'live_post_close_tail',
      mint,
      ok: false,
      note: `${(e as Error)?.message?.slice(0, 180) ?? 'tail_err'} attempt=${attempt}`,
    });
    args.onDone(true);
  }
}
