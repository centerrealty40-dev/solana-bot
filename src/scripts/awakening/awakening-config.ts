import path from 'node:path';
import { resolveSolanaRpcWsUrl } from '../../core/rpc/resolve-solana-rpc-url.js';
import { PUMP_FUN_PROGRAM_ID } from '../../parser/pumpfun.js';
import { PUMP_SWAP_AMM_PROGRAM_ID } from '../../parser/allowlisted-dex-swap.js';

export type AwakeningStreamSource = 'ws' | 'pg';

export interface AwakeningConfig {
  enabled: boolean;
  mode: 'shadow' | 'live';
  /** `ws` = in-process Alchemy logsSubscribe (no PG). `pg` = read stream_events (legacy). */
  streamSource: AwakeningStreamSource;
  journalPath: string;
  cursorPath: string;
  liveEntryQueuePath: string;
  liveEntryEnabled: boolean;
  maxOpenPositions: number;
  rpcWsUrl: string;
  programIds: string[];
  tickMs: number;
  streamBatchSize: number;
  streamLookbackHours: number;
  /** Min signatures in rolling window before DexScreener check (cheap pre-filter). */
  streamMinSigs5m: number;
  streamActivityWindowMs: number;
  maxCandidatesPerTick: number;
  candidateCooldownMs: number;
  geckoTrendingEnabled: boolean;
  geckoTrendingPollMs: number;
  geckoTrendingPages: number;
  vol5mMinUsd: number;
  minVol1hUsd: number;
  minVol5mToVol1hRatio: number;
  maxVol24hUsd: number;
  minPoolAgeMin: number;
  quietPriorVol6hMaxUsd: number;
  quietVol1hMaxUsd: number;
  volVelocityMin: number;
  minMcapUsd: number;
  minLiqUsd: number;
  minBuyRatio: number;
  maxPriceChangeH24Pct: number;
  maxPriceChangeH6Pct: number;
  minPriceChangeM5Pct: number;
  /** Block entries on multi-hour downtrends (negative h24/h6/h1). */
  minPriceChangeH24Pct: number;
  minPriceChangeH6Pct: number;
  minPriceChangeH1Pct: number;
  /** Block when hourly vol is rolling off after a burst (vol1h << vol6h). */
  minVol1hToVol6hRatio: number;
  /** Wash/cluster proxy: cap on hourly turnover vol1h/mcap (organic rarely > ~1x/h). */
  maxVol1hPerMcap: number;
  legUsd: number;
  telegramEnabled: boolean;
  summaryMs: number;
}

function envBool(v: unknown, def: boolean): boolean {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
}

function envNum(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envNumSigned(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function parseProgramIds(raw: string | undefined): string[] {
  const fallback = [PUMP_FUN_PROGRAM_ID, PUMP_SWAP_AMM_PROGRAM_ID];
  if (!raw?.trim()) return fallback;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 32);
  return ids.length > 0 ? ids : fallback;
}

export function loadAwakeningConfig(env: NodeJS.ProcessEnv = process.env): AwakeningConfig {
  const streamRaw = String(env.AWAKENING_STREAM_SOURCE ?? 'ws').trim().toLowerCase();
  const streamSource: AwakeningStreamSource = streamRaw === 'pg' ? 'pg' : 'ws';
  const wsUrl =
    env.AWAKENING_RPC_WS_URL?.trim() ||
    (() => {
      const resolved = resolveSolanaRpcWsUrl(env);
      if (/quiknode\.pro/i.test(resolved)) {
        const alchemyHttp = env.ALCHEMY_HTTP_URL?.trim() || env.SA_RPC_HTTP_URL?.trim();
        if (alchemyHttp?.startsWith('https://')) return `wss://${alchemyHttp.slice('https://'.length)}`;
      }
      return resolved;
    })();
  return {
    enabled: envBool(env.AWAKENING_CATCHER_ENABLED, false),
    mode: String(env.AWAKENING_MODE ?? 'shadow').trim().toLowerCase() === 'live' ? 'live' : 'shadow',
    streamSource,
    journalPath:
      env.AWAKENING_CATCHER_JOURNAL_PATH?.trim() ||
      path.join('data', 'awakening-catcher', 'awakening-catcher.jsonl'),
    cursorPath:
      env.AWAKENING_CURSOR_PATH?.trim() ||
      path.join('data', 'awakening-catcher', 'stream-cursor.json'),
    liveEntryQueuePath:
      env.AWAKENING_LIVE_ENTRY_QUEUE_PATH?.trim() ||
      path.join('data', 'live', 'awakening-entry-queue.jsonl'),
    liveEntryEnabled: envBool(env.AWAKENING_LIVE_ENTRY_ENABLED, false),
    maxOpenPositions: Math.min(10, Math.round(envNum(env.AWAKENING_MAX_OPEN_POSITIONS, 3))),
    rpcWsUrl: wsUrl,
    programIds: parseProgramIds(env.AWAKENING_STREAM_PROGRAM_IDS),
    tickMs: Math.round(envNum(env.AWAKENING_TICK_MS, 10_000)),
    streamBatchSize: Math.min(100, Math.round(envNum(env.AWAKENING_STREAM_BATCH_SIZE, 50))),
    streamLookbackHours: Math.round(envNum(env.AWAKENING_STREAM_LOOKBACK_HOURS, 2)),
    streamMinSigs5m: Math.round(envNum(env.AWAKENING_STREAM_MIN_SIGS_5M, 2)),
    streamActivityWindowMs: Math.round(envNum(env.AWAKENING_STREAM_ACTIVITY_WINDOW_SEC, 300) * 1000),
    maxCandidatesPerTick: Math.min(20, Math.round(envNum(env.AWAKENING_MAX_CANDIDATES_PER_TICK, 8))),
    candidateCooldownMs: Math.round(envNum(env.AWAKENING_CANDIDATE_COOLDOWN_SEC, 900) * 1000),
    geckoTrendingEnabled: envBool(env.AWAKENING_GECKO_TRENDING_ENABLED, true),
    geckoTrendingPollMs: Math.round(envNum(env.AWAKENING_GECKO_TRENDING_POLL_SEC, 60) * 1000),
    geckoTrendingPages: Math.min(3, Math.round(envNum(env.AWAKENING_GECKO_TRENDING_PAGES, 2))),
    vol5mMinUsd: envNum(env.AWAKENING_VOL5M_MIN_USD, 3_000),
    minVol1hUsd: envNum(env.AWAKENING_MIN_VOL1H_USD, 10_000),
    minVol5mToVol1hRatio: envNum(env.AWAKENING_MIN_VOL5M_TO_VOL1H_RATIO, 0.05),
    maxVol24hUsd: envNum(env.AWAKENING_MAX_VOL24H_USD, 800_000),
    minPoolAgeMin: Math.round(envNum(env.AWAKENING_MIN_POOL_AGE_HOURS, 24) * 60),
    quietPriorVol6hMaxUsd: envNum(env.AWAKENING_QUIET_PRIOR_VOL6H_MAX_USD, 1_500),
    quietVol1hMaxUsd: envNum(env.AWAKENING_QUIET_VOL1H_MAX_USD, 2_000),
    volVelocityMin: envNum(env.AWAKENING_VOL_VELOCITY_MIN, 0.15),
    minMcapUsd: envNum(env.AWAKENING_MIN_MCAP_USD, 150_000),
    minLiqUsd: envNum(env.AWAKENING_MIN_LIQ_USD, 15_000),
    minBuyRatio: envNum(env.AWAKENING_MIN_BUY_RATIO, 0.42),
    maxPriceChangeH24Pct: envNum(env.AWAKENING_MAX_PRICE_CHANGE_H24_PCT, 120),
    maxPriceChangeH6Pct: envNum(env.AWAKENING_MAX_PRICE_CHANGE_H6_PCT, 80),
    minPriceChangeM5Pct: envNum(env.AWAKENING_MIN_PRICE_CHANGE_M5_PCT, 1),
    minPriceChangeH24Pct: envNumSigned(env.AWAKENING_MIN_PRICE_CHANGE_H24_PCT, 0),
    minPriceChangeH6Pct: envNumSigned(env.AWAKENING_MIN_PRICE_CHANGE_H6_PCT, -5),
    minPriceChangeH1Pct: envNumSigned(env.AWAKENING_MIN_PRICE_CHANGE_H1_PCT, -5),
    minVol1hToVol6hRatio: envNum(env.AWAKENING_MIN_VOL1H_TO_VOL6H_RATIO, 0.25),
    maxVol1hPerMcap: envNum(env.AWAKENING_MAX_VOL1H_PER_MCAP, 3.0),
    legUsd: envNum(env.AWAKENING_LEG_USD, 10),
    telegramEnabled: envBool(env.AWAKENING_TELEGRAM_ENABLED, true),
    summaryMs: Math.round(envNum(env.AWAKENING_SUMMARY_MIN, 30) * 60_000),
  };
}
