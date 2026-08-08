/**
 * Cheap Helius watch: logsSubscribe on a few leader wallets only
 * (not the full pump/pumpswap firehose). On Instruction: Buy → getTx mint
 * resolve → **leader highlight** → buyForce so our gates (triple_green) can
 * evaluate. Not a blind copy — we still require our entry thresholds.
 *
 * Credit cost ≈ 2 wallet subscriptions + sparse getTx vs millions of program logs.
 */
import { resolveLeaderStreamWsUrl } from '../copytrader/leader-stream-ws.js';
import { extractMintCandidatesFromLogs } from '../scripts/awakening/awakening-mint-from-logs.js';
import type { StreamConfig } from '../stream/config.js';
import { LogsWsClient } from '../stream/rpc-ws.js';
import {
  createBuyMintResolver,
  logsIndicateBuy,
  needsBuyMintResolve,
  type BuyMintResolver,
} from './buy-mint-resolve.js';
import { mildDipHotMints } from './hot-mints.js';
import {
  bumpWsClosed,
  bumpWsOpen,
  bumpWsReconnectBackoff,
} from './runtime-metrics.js';

export type LeaderWatchHandle = { stop: () => void };

const DEFAULT_LEADERS = [
  '7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5',
  '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ',
];

export function parseLeaderWatchWallets(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.VOL_GREEN_LEADER_WATCH_WALLETS?.trim() || env.MILD_DIP_LEADER_WATCH_WALLETS?.trim();
  if (raw) {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length >= 32);
  }
  const on = (env.VOL_GREEN_LEADER_WATCH ?? env.MILD_DIP_LEADER_WATCH ?? '').trim().toLowerCase();
  if (on === '1' || on === 'true' || on === 'yes') return [...DEFAULT_LEADERS];
  return [];
}

export function startLeaderWalletWatch(opts: {
  wallets: string[];
  rpcUrl: string;
  wsUrl?: string | null;
  /** Cap getTx for leader buys without mint in logs. */
  resolveMaxPerMin?: number;
  resolveConcurrency?: number;
}): LeaderWatchHandle | null {
  const wallets = opts.wallets.filter((w) => w.length >= 32);
  if (wallets.length === 0) return null;
  const wsUrl =
    (opts.wsUrl ?? resolveLeaderStreamWsUrl())?.trim() || '';
  if (!wsUrl) {
    console.warn('[mild-dip] leader-watch: no WS URL (HELIUS_API_KEY / MILD_DIP_STREAM_WS_URL)');
    return null;
  }
  const rpcUrl = opts.rpcUrl?.trim();
  if (!rpcUrl) return null;

  const cfg: StreamConfig = {
    rpcHttpUrl: 'https://placeholder.local',
    rpcWsUrl: wsUrl,
    programIds: wallets, // logsSubscribe mentions — wallets, not programs
    commitment: 'confirmed',
    batchSize: 50,
    batchMs: 500,
    reconnectMinMs: 2000,
    reconnectMaxMs: 60_000,
    logEveryN: 500,
  };

  const resolveMax = Math.max(0, opts.resolveMaxPerMin ?? 20);
  let resolver: BuyMintResolver | null = null;
  if (resolveMax > 0) {
    resolver = createBuyMintResolver({
      rpcUrl,
      maxPerMin: resolveMax,
      concurrency: opts.resolveConcurrency ?? 2,
      queueMax: Math.max(10, resolveMax),
      staleJobMs: 25_000,
      onResolved: (mint) => {
        mildDipHotMints.markLeaderHighlight(mint, Date.now());
        console.log(
          `[mild-dip] leader-highlight mint=${mint.slice(0, 8)}… (resolved) → force eval`,
        );
      },
    });
  }

  const client = new LogsWsClient(
    cfg,
    (n) => {
      const tsMs = Date.now();
      if (n.err) return;
      if (!logsIndicateBuy(n.logs)) return;
      const mints = extractMintCandidatesFromLogs(n.logs);
      for (const mint of mints) {
        mildDipHotMints.markLeaderHighlight(mint, tsMs);
        console.log(
          `[mild-dip] leader-highlight mint=${mint.slice(0, 8)}… sig=${n.signature.slice(0, 8)}… → force eval`,
        );
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
    `[mild-dip] leader-watch ON wallets=${wallets.length} resolveMaxPerMin=${resolveMax} ` +
      `hosts=${wallets.map((w) => w.slice(0, 6)).join(',')}`,
  );
  return {
    stop: () => {
      client.stop();
      resolver?.stop();
    },
  };
}
