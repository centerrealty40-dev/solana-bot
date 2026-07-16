import fs from 'node:fs';
import path from 'node:path';
import type { AwakeningConfig } from './awakening-config.js';
import type { AwakeningCandidate, AwakeningDexMarket } from './awakening-types.js';

export interface AwakeningLiveEntryIntent {
  ts: number;
  mint: string;
  legUsd: number;
  priceUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume5mUsd: number | null;
  pairAddress: string | null;
  dexId: string | null;
  source: AwakeningCandidate['source'];
  metrics: Record<string, unknown>;
}

export function enqueueAwakeningLiveEntry(
  cfg: Pick<AwakeningConfig, 'liveEntryQueuePath' | 'mode'>,
  args: {
    mint: string;
    legUsd: number;
    market: AwakeningDexMarket;
    source: AwakeningCandidate['source'];
    metrics: Record<string, unknown>;
  },
): void {
  if (cfg.mode !== 'live') return;
  const intent: AwakeningLiveEntryIntent = {
    ts: Date.now(),
    mint: args.mint,
    legUsd: args.legUsd,
    priceUsd: args.market.priceUsd,
    marketCapUsd: args.market.marketCapUsd,
    liquidityUsd: args.market.liquidityUsd,
    volume5mUsd: args.market.volume5mUsd,
    pairAddress: args.market.pairAddress,
    dexId: args.market.dexId,
    source: args.source,
    metrics: args.metrics,
  };
  const qPath = cfg.liveEntryQueuePath;
  const dir = path.dirname(qPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(qPath, `${JSON.stringify(intent)}\n`, 'utf8');
}

export function awakeningLiveEntryQueuePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.AWAKENING_LIVE_ENTRY_QUEUE_PATH?.trim() ||
    path.join('data', 'live', 'awakening-entry-queue.jsonl')
  );
}

export function awakeningLiveEntryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AWAKENING_LIVE_ENTRY_ENABLED?.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** PM2 consumer strategy — default live-lera10; catcher uses live-catcher-awakening. */
export function awakeningLiveEntryStrategyId(env: NodeJS.ProcessEnv = process.env): string {
  return env.AWAKENING_LIVE_ENTRY_STRATEGY_ID?.trim() || 'live-lera10';
}
