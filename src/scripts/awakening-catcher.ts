/**
 * awakening-catcher — ISOLATED worker for dormant-low volume awakening.
 *
 * Ingress (default): in-process Alchemy `logsSubscribe` (zero Postgres).
 * Fallback: `AWAKENING_STREAM_SOURCE=pg` reads stream_events (legacy).
 * Trigger: vol5m ≥ threshold on previously quiet coin (DexScreener on-demand only).
 * Live: enqueues $10 intents for live-lera10 consumer (`AWAKENING_LIVE_ENTRY_ENABLED=1`).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { child } from '../core/logger.js';
import { startOpsHeartbeat, writeOpsFatal } from '../core/ops-heartbeat.js';
import { sendTagged } from '../core/telegram/sender.js';
import { MintActivityTracker } from './awakening/awakening-activity.js';
import { loadAwakeningConfig, type AwakeningConfig } from './awakening/awakening-config.js';
import { fetchAwakeningDexMarket } from './awakening/awakening-dex-pair.js';
import { fetchGeckoTrendingMints } from './awakening/awakening-gecko-trending.js';
import { enqueueAwakeningLiveEntry } from './awakening/awakening-live-entry-queue.js';
import { evaluateAwakeningSignal, awakeningEvalCooldownMs } from './awakening/awakening-signal.js';
import { formatAwakeningSignalTelegramHtml } from './awakening/awakening-telegram.js';
import { startAwakeningStreamWs } from './awakening/awakening-stream-ws.js';
import {
  loadStreamCursor,
  mintsFromStreamBatch,
  readAwakeningStreamBatch,
  saveStreamCursor,
} from './awakening/awakening-stream-reader.js';
import type { AwakeningCandidate } from './awakening/awakening-types.js';

const log = child('awakening-catcher');

let journalPathResolved: string | null = null;
const cooldownUntil = new Map<string, number>();
const signalCountByMint = new Map<string, number>();
let totalSignals = 0;
let totalDexChecks = 0;
let totalStreamRows = 0;
let totalWsMints = 0;
let lastGeckoPollAtMs = 0;

function appendJournal(cfg: AwakeningConfig, ev: Record<string, unknown>): void {
  try {
    if (!journalPathResolved) {
      const dir = path.dirname(cfg.journalPath);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      journalPathResolved = cfg.journalPath;
    }
    fs.appendFileSync(
      journalPathResolved,
      `${JSON.stringify({ ts: Date.now(), mode: cfg.mode, ...ev })}\n`,
      'utf8',
    );
  } catch (e) {
    log.debug({ err: (e as Error).message }, 'journal append failed');
  }
}

function notifyHtml(cfg: AwakeningConfig, html: string): void {
  if (!cfg.telegramEnabled) return;
  const subtag = cfg.mode === 'shadow' ? 'awakening_shadow' : 'awakening_live';
  const token =
    process.env.AWAKENING_TELEGRAM_BOT_TOKEN?.trim() ||
    process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat =
    process.env.AWAKENING_TELEGRAM_CHAT_ID?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim();
  void sendTagged('REPORT', subtag, html, {
    parseMode: 'HTML',
    skipQuietHours: true,
    ...(token && chat ? { telegramBotToken: token, telegramChatId: chat } : {}),
  }).catch(() => false);
}

function onCooldown(mint: string, nowMs: number): boolean {
  const until = cooldownUntil.get(mint) ?? 0;
  return until > nowMs;
}

function setCooldown(cfg: AwakeningConfig, mint: string, nowMs: number, ms?: number): void {
  cooldownUntil.set(mint, nowMs + (ms ?? cfg.candidateCooldownMs));
}

async function evaluateCandidate(
  cfg: AwakeningConfig,
  candidate: AwakeningCandidate,
  nowMs: number,
): Promise<void> {
  if (onCooldown(candidate.mint, nowMs)) return;

  totalDexChecks += 1;
  const market = await fetchAwakeningDexMarket(candidate.mint);
  if (!market) {
    appendJournal(cfg, {
      kind: 'awakening_dex_miss',
      mint: candidate.mint,
      source: candidate.source,
      streamSigCount5m: candidate.streamSigCount5m ?? null,
    });
    return;
  }

  const verdict = evaluateAwakeningSignal(cfg, market);
  appendJournal(cfg, {
    kind: 'awakening_eval',
    mint: candidate.mint,
    source: candidate.source,
    streamSigCount5m: candidate.streamSigCount5m ?? null,
    pass: verdict.pass,
    reasons: verdict.reasons,
    metrics: verdict.metrics,
    market: {
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCapUsd,
      liquidityUsd: market.liquidityUsd,
      volume5mUsd: market.volume5mUsd,
      volume1hUsd: market.volume1hUsd,
      volume6hUsd: market.volume6hUsd,
      buyRatio: verdict.metrics.buyRatio,
      dexId: market.dexId,
      pairAddress: market.pairAddress,
    },
  });

  setCooldown(cfg, candidate.mint, nowMs, awakeningEvalCooldownMs(cfg, verdict));

  if (!verdict.pass) return;

  totalSignals += 1;
  signalCountByMint.set(candidate.mint, (signalCountByMint.get(candidate.mint) ?? 0) + 1);

  appendJournal(cfg, {
    kind: 'awakening_signal',
    mint: candidate.mint,
    source: candidate.source,
    streamSigCount5m: candidate.streamSigCount5m ?? null,
    entryPath: verdict.metrics.entryPath ?? null,
    legUsd: cfg.legUsd,
    metrics: verdict.metrics,
    marketCapUsd: market.marketCapUsd,
    priceUsd: market.priceUsd,
    volume5mUsd: market.volume5mUsd,
  });

  if (cfg.mode === 'shadow') {
    appendJournal(cfg, {
      kind: 'shadow_entry',
      mint: candidate.mint,
      legUsd: cfg.legUsd,
      priceUsd: market.priceUsd,
      marketCapUsd: market.marketCapUsd,
      note: 'hypothetical lera10 dormant_awakening entry',
    });
  } else {
    enqueueAwakeningLiveEntry(cfg, {
      mint: candidate.mint,
      legUsd: cfg.legUsd,
      market,
      source: candidate.source,
      metrics: verdict.metrics as unknown as Record<string, unknown>,
    });
    appendJournal(cfg, {
      kind: 'live_entry_queued',
      mint: candidate.mint,
      legUsd: cfg.legUsd,
      queuePath: cfg.liveEntryQueuePath,
    });
  }

  notifyHtml(cfg, formatAwakeningSignalTelegramHtml(cfg, candidate, market, verdict));

  log.info(
    {
      mint: candidate.mint,
      source: candidate.source,
      entryPath: verdict.metrics.entryPath,
      vol5m: verdict.metrics.vol5mUsd,
      prior6h: verdict.metrics.priorVol6hUsd,
      mcap: market.marketCapUsd,
      mode: cfg.mode,
    },
    'awakening signal',
  );
}

async function collectCandidates(
  cfg: AwakeningConfig,
  activity: MintActivityTracker,
  nowMs: number,
): Promise<AwakeningCandidate[]> {
  const candidates: AwakeningCandidate[] = [];
  const seen = new Set<string>();

  const push = (c: AwakeningCandidate) => {
    if (!c.mint || seen.has(c.mint)) return;
    seen.add(c.mint);
    candidates.push(c);
  };

  for (const hot of activity.hotMints(cfg.streamMinSigs5m, nowMs)) {
    push({ mint: hot.mint, source: 'stream_pulse', streamSigCount5m: hot.sigs });
  }

  let warmAdded = 0;
  for (const warm of activity.warmMints(cfg.streamWarmMinSigs, cfg.streamWarmLookbackMs, nowMs)) {
    if (warmAdded >= cfg.streamWarmMaxPerTick) break;
    if (seen.has(warm.mint)) continue;
    push({ mint: warm.mint, source: 'stream_warm', streamSigCount5m: warm.sigs });
    warmAdded += 1;
  }

  if (cfg.geckoTrendingEnabled && nowMs - lastGeckoPollAtMs >= cfg.geckoTrendingPollMs) {
    lastGeckoPollAtMs = nowMs;
    try {
      const trending = await fetchGeckoTrendingMints({ pages: cfg.geckoTrendingPages });
      for (const t of trending) push(t);
      appendJournal(cfg, { kind: 'awakening_gecko_poll', count: trending.length });
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'gecko trending poll failed');
    }
  }

  return candidates.slice(0, cfg.maxCandidatesPerTick);
}

async function pollPgStream(
  cfg: AwakeningConfig,
  activity: MintActivityTracker,
  streamCursor: { value: bigint },
): Promise<void> {
  const rows = await readAwakeningStreamBatch({
    programIds: cfg.programIds,
    afterId: streamCursor.value,
    lookbackHours: cfg.streamLookbackHours,
    limit: cfg.streamBatchSize,
  });

  if (rows.length === 0) return;

  totalStreamRows += rows.length;
  const last = rows[rows.length - 1]!;
  streamCursor.value = last.id;
  saveStreamCursor(cfg.cursorPath, streamCursor.value);

  for (const mint of mintsFromStreamBatch(rows)) {
    activity.record(mint, last.receivedAt.getTime());
  }
}

async function tick(
  cfg: AwakeningConfig,
  activity: MintActivityTracker,
  streamCursor: { value: bigint },
): Promise<void> {
  const nowMs = Date.now();

  if (cfg.streamSource === 'pg') {
    await pollPgStream(cfg, activity, streamCursor);
  }

  activity.pruneAll(nowMs);
  const candidates = await collectCandidates(cfg, activity, nowMs);

  for (const candidate of candidates) {
    await evaluateCandidate(cfg, candidate, nowMs);
  }
}

export async function main(): Promise<void> {
  const cfg = loadAwakeningConfig();
  if (!cfg.enabled) {
    log.info('AWAKENING_CATCHER_ENABLED=0 — idle exit');
    return;
  }

  if (cfg.streamSource === 'ws' && !cfg.rpcWsUrl) {
    log.error('AWAKENING_STREAM_SOURCE=ws but no Alchemy/RPC WSS URL — set ALCHEMY_HTTP_URL or SA_RPC_WS_URL');
    process.exit(1);
  }

  log.info(
    {
      mode: cfg.mode,
      streamSource: cfg.streamSource,
      wsHost: cfg.rpcWsUrl ? safeHost(cfg.rpcWsUrl) : null,
      programs: cfg.programIds,
      vol5mMinUsd: cfg.vol5mMinUsd,
      vol5mSpikeMinMult: cfg.vol5mSpikeMinMult,
      vol5mSpikeVs1hMinMult: cfg.vol5mSpikeVs1hMinMult,
      minMcapUsd: cfg.minMcapUsd,
      legUsd: cfg.legUsd,
      streamMinSigs5m: cfg.streamMinSigs5m,
      geckoTrending: cfg.geckoTrendingEnabled,
      liveEntryQueue: cfg.mode === 'live' ? cfg.liveEntryQueuePath : null,
    },
    'awakening-catcher starting',
  );

  appendJournal(cfg, {
    kind: 'awakening_start',
    streamSource: cfg.streamSource,
    programs: cfg.programIds,
    vol5mMinUsd: cfg.vol5mMinUsd,
  });

  const activity = new MintActivityTracker(cfg.streamActivityWindowMs, cfg.streamWarmLookbackMs);

  startOpsHeartbeat({
    appName: 'awakening-catcher',
    stats: () => ({
      trackedMints: activity.size(),
      streamRows: totalStreamRows,
      wsMints: totalWsMints,
      dexChecks: totalDexChecks,
      signals: totalSignals,
      streamSource: cfg.streamSource,
    }),
  });
  const streamCursor = { value: loadStreamCursor(cfg.cursorPath) };

  let wsHandle: { stop: () => void } | null = null;
  if (cfg.streamSource === 'ws') {
    wsHandle = startAwakeningStreamWs({
      rpcWsUrl: cfg.rpcWsUrl,
      programIds: cfg.programIds,
      onMintActivity: (mint) => {
        totalWsMints += 1;
        activity.record(mint);
      },
    });
    process.on('SIGINT', () => wsHandle?.stop());
    process.on('SIGTERM', () => wsHandle?.stop());
  }

  setInterval(() => {
    log.info(
      {
        trackedMints: activity.size(),
        streamRows: totalStreamRows,
        wsMints: totalWsMints,
        dexChecks: totalDexChecks,
        signals: totalSignals,
        streamSource: cfg.streamSource,
        cursor: cfg.streamSource === 'pg' ? streamCursor.value.toString() : 'ws',
      },
      'awakening-catcher heartbeat',
    );
  }, 60_000).unref();

  setInterval(() => {
    notifyHtml(
      cfg,
      [
        `<b>Awakening summary</b> (${cfg.mode})`,
        `signals: ${totalSignals}`,
        `dex checks: ${totalDexChecks}`,
        `tracked mints: ${activity.size()}`,
        `src: ${cfg.streamSource}`,
      ].join('\n'),
    );
  }, cfg.summaryMs).unref();

  const loop = async () => {
    while (true) {
      try {
        await tick(cfg, activity, streamCursor);
      } catch (e) {
        log.error({ err: (e as Error).message }, 'awakening tick error');
      }
      await new Promise((r) => setTimeout(r, cfg.tickMs));
    }
  };

  await loop();
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('awakening-catcher.ts') ||
    process.argv[1].endsWith('awakening-catcher.js'));

if (isMain) {
  main().catch((e) => {
    writeOpsFatal('awakening-catcher', 'main', e);
    log.error({ err: (e as Error).message }, 'fatal');
    process.exit(1);
  });
}

export { loadAwakeningConfig, evaluateAwakeningSignal, MintActivityTracker };
