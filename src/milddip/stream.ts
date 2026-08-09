/**
 * Helius (or any Solana RPC) logsSubscribe on pump.fun / PumpSwap → hot mint universe
 * + optional signature enqueue for stream price sampling.
 *
 * When logs show Instruction: Buy but omit the mint (PumpSwap common),
 * resolve via getTransaction (capped): mint + price + SOL notional in ONE getTx.
 */
import { resolveLeaderStreamWsUrl } from '../copytrader/leader-stream-ws.js';
import { PUMP_FUN_PROGRAM_ID } from '../parser/pumpfun.js';
import { PUMP_SWAP_AMM_PROGRAM_ID } from '../parser/allowlisted-dex-swap.js';
import { extractMintCandidatesFromLogs } from '../scripts/awakening/awakening-mint-from-logs.js';
import type { StreamConfig } from '../stream/config.js';
import { LogsWsClient } from '../stream/rpc-ws.js';
import {
  createBuyMintResolver,
  logsIndicateBuyOrSell,
  needsBuyMintResolve,
  type BuyMintResolver,
} from './buy-mint-resolve.js';
import { mildDipHotMints } from './hot-mints.js';
import {
  bumpWsClosed,
  bumpWsOpen,
  bumpWsReconnectBackoff,
} from './runtime-metrics.js';
import type { StreamPriceSampler } from './stream-price-sampler.js';

export type MildDipStreamHandle = {
  stop: () => void;
  stats: () => {
    resolve: ReturnType<BuyMintResolver['stats']> | null;
    priceSampler: ReturnType<StreamPriceSampler['stats']> | null;
  };
};

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

function volumeImpulseMinSol(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.MILD_DIP_VOLUME_IMPULSE_MIN_SOL ?? env.VOL_GREEN_VOLUME_IMPULSE_MIN_SOL ?? 2);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function startMildDipHotMintStream(opts?: {
  wsUrl?: string | null;
  programIds?: string[];
  onMint?: (mint: string, tsMs: number) => void;
  /** When set, enqueue signature→price decode for mints already in logs. */
  priceSampler?: StreamPriceSampler | null;
  rpcUrl?: string | null;
  buyMintResolveMaxPerMin?: number;
  buyMintResolveQueueMax?: number;
  buyMintResolveConcurrency?: number;
}): MildDipStreamHandle | null {
  const wsUrl = (opts?.wsUrl ?? resolveMildDipStreamWsUrl())?.trim() || '';
  if (!wsUrl) {
    console.warn('[mild-dip] stream enabled but no WS URL (set HELIUS_API_KEY or MILD_DIP_STREAM_WS_URL)');
    return null;
  }
  const programIds = opts?.programIds?.length ? opts.programIds : mildDipStreamProgramIds();
  if (programIds.length === 0) return null;

  const cfg: StreamConfig = {
    rpcHttpUrl: 'https://placeholder.local',
    rpcWsUrl: wsUrl,
    programIds,
    commitment: 'confirmed',
    batchSize: 50,
    batchMs: 1000,
    reconnectMinMs: 2000,
    reconnectMaxMs: 60_000,
    logEveryN: 2000,
  };

  const resolveMax = Math.max(0, opts?.buyMintResolveMaxPerMin ?? 0);
  const rpcUrl = (opts?.rpcUrl ?? '').trim();
  const volMin = volumeImpulseMinSol();
  let resolver: BuyMintResolver | null = null;
  if (resolveMax > 0 && rpcUrl) {
    const conc = opts?.buyMintResolveConcurrency ?? 4;
    const qMax =
      opts?.buyMintResolveQueueMax ??
      Math.min(300, Math.max(120, resolveMax));
    resolver = createBuyMintResolver({
      rpcUrl,
      maxPerMin: resolveMax,
      concurrency: conc,
      queueMax: qMax,
      staleJobMs: 45_000,
      volumeImpulseMinSol: volMin,
      onResolved: (result) => {
        // Price already seeded inside resolver from the same getTx.
        opts?.onMint?.(result.mint, result.tsMs);
        if (result.solNotional >= volMin && volMin > 0) {
          console.log(
            `[mild-dip] volume-impulse mint=${result.mint.slice(0, 8)}… ` +
              `sol=${result.solNotional.toFixed(2)} usd=${result.amountUsd.toFixed(0)} ` +
              `px=${result.priceUsd.toExponential(3)}`,
          );
        }
      },
    });
    console.log(
      `[mild-dip] buy-mint-resolve ON buyOnly newestFirst maxPerMin=${resolveMax} ` +
        `conc=${conc} queueMax=${qMax} oneGetTx=1 ` +
        `volumeMinSol=${volMin}`,
    );
  }

  const client = new LogsWsClient(
    cfg,
    (n) => {
      const tsMs = Date.now();
      if (n.err) return;
      const mints = extractMintCandidatesFromLogs(n.logs);
      for (const mint of mints) {
        const buySell = logsIndicateBuyOrSell(n.logs);
        mildDipHotMints.note(mint, tsMs, buySell ? 8 : 1);
        if (buySell) mildDipHotMints.markBuyForce(mint, tsMs);
        opts?.onMint?.(mint, tsMs);
        // Mint already in logs — still need getTx for price (sampler).
        if (opts?.priceSampler && n.signature && buySell) {
          opts.priceSampler.enqueue(mint, n.signature, tsMs);
        }
      }
      if (resolver && n.signature && needsBuyMintResolve(n.logs, mints)) {
        resolver.enqueue(n.signature, tsMs);
      }
    },
    {
      onOpen: () => bumpWsOpen(),
      onClosed: (code) => bumpWsClosed(code),
      onReconnectBackoff: () => bumpWsReconnectBackoff(),
    },
  );

  client.start();
  console.log(
    `[mild-dip] Helius/RPC logsSubscribe started programs=${programIds.length} host=${safeHost(wsUrl)}`,
  );
  return {
    stop: () => {
      client.stop();
      resolver?.stop();
      opts?.priceSampler?.stop();
    },
    stats: () => ({
      resolve: resolver?.stats() ?? null,
      priceSampler: opts?.priceSampler?.stats() ?? null,
    }),
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}
