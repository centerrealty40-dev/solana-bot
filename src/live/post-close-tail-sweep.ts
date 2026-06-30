/**
 * After a full live close (`live_position_close`), optionally wait and sell any SPL dust left on the wallet.
 */
import type { ExitReason } from '../papertrader/types.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { runLiveWalletTailFlushIfNeeded } from './wallet-tail-flush.js';

const pendingByMint = new Map<string, ReturnType<typeof setTimeout>>();

/** Cap applies only after killstop-class exits (may re-enter same mint before timer fires). */
export function livePostCloseTailSweepCapApplies(exitReason?: ExitReason): boolean {
  return exitReason === 'KILLSTOP' || exitReason === 'FLASH_CRASH_KILL';
}

/**
 * Сбрасывает отложенный post-close tail sweep для mint (например, новый вход по тому же mint
 * до срабатывания таймера — иначе `sell_full` снимет уже новую позицию целиком).
 */
export function cancelLivePostCloseTailSweepForMint(mint: string): void {
  const prev = pendingByMint.get(mint);
  if (prev === undefined) return;
  clearTimeout(prev);
  pendingByMint.delete(mint);
}

export function scheduleLivePostCloseTailSweep(args: {
  liveCfg: LiveOscarConfig | undefined;
  mint: string;
  symbol: string;
  decimals: number;
  /** Last known USD/token at close (fallback if fresh price missing). */
  priceUsdPerToken: number;
  dexSource?: string;
  /** When set, `LIVE_POST_CLOSE_TAIL_SWEEP_MAX_USD` applies only for killstop-class exits. */
  exitReason?: ExitReason;
}): void {
  const liveCfg = args.liveCfg;
  if (!liveCfg) return;
  const delayMs = liveCfg.livePostCloseTailSweepDelayMs;
  if (!(delayMs > 0)) return;
  if (!liveCfg.strategyEnabled || liveCfg.executionMode !== 'live') return;

  const mint = args.mint;
  const prev = pendingByMint.get(mint);
  if (prev !== undefined) clearTimeout(prev);

  appendLiveJsonlEvent({
    kind: 'live_post_close_tail',
    mint,
    ok: true,
    note: 'scheduled',
    exitReason: args.exitReason,
    delayMs,
    thresholdUsd: liveCfg.liveTailFlushThresholdUsd,
  });

  const handle = setTimeout(() => {
    pendingByMint.delete(mint);
    void runLivePostCloseTailSweep({
      liveCfg,
      mint,
      symbol: args.symbol,
      decimals: args.decimals,
      hintPriceUsdPerToken: args.priceUsdPerToken,
      dexSource: args.dexSource,
      exitReason: args.exitReason,
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
  exitReason?: ExitReason;
}): Promise<void> {
  const { liveCfg, mint } = args;
  const result = await runLiveWalletTailFlushIfNeeded({
    liveCfg,
    mint,
    symbol: args.symbol,
    decimals: args.decimals,
    hintPriceUsdPerToken: args.hintPriceUsdPerToken,
    dexSource: args.dexSource,
    context: 'post_close',
    postCloseKillstopCapMaxUsd: liveCfg.livePostCloseTailSweepMaxUsd,
    postCloseKillstopCapApplies: livePostCloseTailSweepCapApplies(args.exitReason),
  });

  appendLiveJsonlEvent({
    kind: 'live_post_close_tail',
    mint,
    ok: result.note !== 'spl_balance_rpc_null' && result.note !== 'no_price' && result.note !== 'tail_flush_err',
    note: result.flushed ? 'sweep_ok' : result.note,
    thresholdUsd: liveCfg.liveTailFlushThresholdUsd,
    exitReason: args.exitReason,
  });
}

/** After partial TP/sell: flush wallet remainder when below threshold (no delay). */
export function runLivePartialExitTailFlush(args: {
  liveCfg: LiveOscarConfig | undefined;
  mint: string;
  symbol: string;
  decimals: number;
  hintPriceUsdPerToken: number;
  dexSource?: string;
}): void {
  const liveCfg = args.liveCfg;
  if (!liveCfg?.strategyEnabled || liveCfg.executionMode !== 'live') return;
  void runLiveWalletTailFlushIfNeeded({
    liveCfg,
    mint: args.mint,
    symbol: args.symbol,
    decimals: args.decimals,
    hintPriceUsdPerToken: args.hintPriceUsdPerToken,
    dexSource: args.dexSource,
    context: 'partial_exit',
  });
}
