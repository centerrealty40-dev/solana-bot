/**
 * Helius (or any Solana RPC) logsSubscribe on pump.fun / PumpSwap → hot mint universe
 * + optional signature enqueue for stream price sampling.
 *
 * DexScreener remains the liq/mcap/pc5m source; stream prices fill the trough
 * during cooldown so we can refuse bounce re-entries.
 */
import { resolveLeaderStreamWsUrl } from '../copytrader/leader-stream-ws.js';
import { resolveSolanaRpcUrl } from '../core/rpc/resolve-solana-rpc-url.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { PUMP_SWAP_AMM_PROGRAM_ID } from '../parser/allowlisted-dex-swap.js';
import { extractMintCandidatesFromLogs } from '../scripts/awakening/awakening-mint-from-logs.js';
import type { StreamConfig } from '../stream/config.js';
import { LogsWsClient } from '../stream/rpc-ws.js';
import { mildDipHotMints } from './hot-mints.js';
import { PoolMintResolver } from './pool-mint-resolver.js';
import { appendMildDipJournal } from './state.js';
import { parseStreamEvents } from './stream-events.js';
import type { StreamPriceSampler } from './stream-price-sampler.js';

export type MildDipStreamHandle = { stop: () => void };

export function resolveMildDipStreamWsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.MILD_DIP_STREAM_WS_URL?.trim() || '';
  if (explicit) return explicit;
  return resolveLeaderStreamWsUrl(env);
}

export function mildDipStreamProgramIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MILD_DIP_STREAM_PROGRAM_IDS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 32);
  }
  return [PUMP_FUN_PROGRAM_ID, PUMP_SWAP_AMM_PROGRAM_ID];
}

export function startMildDipHotMintStream(opts?: {
  wsUrl?: string | null;
  programIds?: string[];
  onMint?: (mint: string, tsMs: number, signature?: string) => void;
  /** When set, enqueue signature→price decode for watched mints. */
  priceSampler?: StreamPriceSampler | null;
  rpcHttpUrl?: string;
  journalPath?: string;
  eventDecodeEnabled?: boolean;
  poolResolveEnabled?: boolean;
  poolBatchSize?: number;
  poolBatchMs?: number;
  poolMaxQueue?: number;
}): MildDipStreamHandle | null {
  const wsUrl = (opts?.wsUrl ?? resolveMildDipStreamWsUrl())?.trim() || '';
  if (!wsUrl) {
    console.warn('[mild-dip] stream enabled but no WS URL (set HELIUS_API_KEY or MILD_DIP_STREAM_WS_URL)');
    return null;
  }
  const programIds = opts?.programIds?.length ? opts.programIds : mildDipStreamProgramIds();
  if (programIds.length === 0) return null;

  const cfg: StreamConfig = {
    rpcHttpUrl: opts?.rpcHttpUrl || resolveSolanaRpcUrl() || 'https://placeholder.local',
    rpcWsUrl: wsUrl,
    programIds,
    commitment: 'confirmed',
    batchSize: 50,
    batchMs: 1000,
    reconnectMinMs: 2000,
    reconnectMaxMs: 60_000,
    logEveryN: 2000,
  };

  const handleMint = (mint: string, tsMs: number, signature?: string, failed = false) => {
    mildDipHotMints.note(mint, tsMs);
    opts?.onMint?.(mint, tsMs, signature);
    if (!failed && opts?.priceSampler && signature) {
      opts.priceSampler.enqueue(mint, signature, tsMs);
    }
  };
  const resolver =
    opts?.poolResolveEnabled === false
      ? null
      : new PoolMintResolver({
          rpcHttpUrl: cfg.rpcHttpUrl,
          batchSize: opts?.poolBatchSize,
          batchIntervalMs: opts?.poolBatchMs,
          maxQueue: opts?.poolMaxQueue,
          onMint: (mint, tsMs, signature) => handleMint(mint, tsMs, signature),
        });
  const statsTimer =
    opts?.journalPath && resolver
      ? setInterval(() => {
          appendMildDipJournal(opts.journalPath!, {
            kind: 'stream_pool_resolver_stats',
            ...resolver.stats(),
          });
        }, 300_000)
      : null;
  statsTimer?.unref?.();

  const client = new LogsWsClient(cfg, (n) => {
    const tsMs = Date.now();
    // 1.11.795 — still harvest mints from failed txs (mention logs). Skipping
    // the whole notification on `err` starved hot-mints / fast-path while the
    // open book was non-empty (buys only ran on stream when opens > 0).
    const mints = extractMintCandidatesFromLogs(n.logs);
    const decoded = opts?.eventDecodeEnabled === false ? { mints: [], pools: [] } : parseStreamEvents(n.logs);
    const allMints = new Set([...mints, ...decoded.mints]);
    for (const mint of allMints) {
      handleMint(mint, tsMs, n.signature, Boolean(n.err));
    }
    if (!n.err && resolver) {
      for (const pool of decoded.pools) {
        resolver.enqueue(pool, tsMs, n.signature);
      }
    }
  });

  client.start();
  console.log(
    `[mild-dip] Helius/RPC logsSubscribe started programs=${programIds.length} host=${safeHost(wsUrl)}`,
  );
  return {
    stop: () => {
      client.stop();
      statsTimer && clearInterval(statsTimer);
      resolver?.stop();
      opts?.priceSampler?.stop();
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
