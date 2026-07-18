import fs from 'node:fs';
import path from 'node:path';
import type { LiveOscarConfig } from './config.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { makeOpenTradeFromEntry, snapshotSourceToDex } from '../papertrader/executor/open.js';
import { stampLiveOscarExitPolicyOnOpen } from '../papertrader/executor/exit-policy-wave-b.js';
import type { LiveOscarPhase4Discovery } from './phase4-types.js';
import type { EvalDecision } from '../papertrader/discovery/dip-clones.js';
import type { OpenTrade, SnapshotCandidateRow, SnapshotFeatures, Lane } from '../papertrader/types.js';
import { isMintPermanentlyDeniedLiveOscar } from './mint-permanent-denylist.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { child } from '../core/logger.js';
import {
  awakeningLiveEntryEnabled,
  awakeningLiveEntryQueuePathFromEnv,
  awakeningLiveEntryStrategyId,
  type AwakeningLiveEntryIntent,
} from '../scripts/awakening/awakening-live-entry-queue.js';
import {
  countOpenDormantAwakeningPositions,
  dormantAwakeningMintAlreadyOpen,
  dormantAwakeningOpenMapKey,
  stampDormantAwakeningOnOpen,
} from '../papertrader/live-oscar-dormant-awakening.js';

const log = child('awakening-live-entry');

type ConsumerCursor = { byteOffset: number; updatedAtMs: number };

function cursorPath(queuePath: string): string {
  return `${queuePath}.consumer-cursor.json`;
}

function loadCursor(queuePath: string): number {
  try {
    const raw = fs.readFileSync(cursorPath(queuePath), 'utf8');
    const j = JSON.parse(raw) as ConsumerCursor;
    return typeof j.byteOffset === 'number' && j.byteOffset >= 0 ? j.byteOffset : 0;
  } catch {
    return 0;
  }
}

function saveCursor(queuePath: string, byteOffset: number): void {
  const p = cursorPath(queuePath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    `${JSON.stringify({ byteOffset, updatedAtMs: Date.now() })}\n`,
    'utf8',
  );
}

function readPendingIntents(queuePath: string): {
  intents: AwakeningLiveEntryIntent[];
  lineEndOffsets: number[];
  startOffset: number;
} {
  if (!fs.existsSync(queuePath)) {
    return { intents: [], lineEndOffsets: [], startOffset: loadCursor(queuePath) };
  }
  const startOffset = loadCursor(queuePath);
  const buf = fs.readFileSync(queuePath);
  if (startOffset >= buf.length) {
    return { intents: [], lineEndOffsets: [], startOffset };
  }
  const intents: AwakeningLiveEntryIntent[] = [];
  const lineEndOffsets: number[] = [];
  let pos = startOffset;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    const lineEnd = nl === -1 ? buf.length : nl + 1;
    const raw = buf.subarray(pos, nl === -1 ? buf.length : nl).toString('utf8').trim();
    if (raw.length > 0) {
      try {
        intents.push(JSON.parse(raw) as AwakeningLiveEntryIntent);
        lineEndOffsets.push(lineEnd);
      } catch {
        lineEndOffsets.push(lineEnd);
      }
    }
    pos = lineEnd;
  }
  return { intents, lineEndOffsets, startOffset };
}

function journalAwakeningSkip(args: {
  intent: AwakeningLiveEntryIntent;
  reason: string;
  skipped: string[];
  journalLiveStrategy?: (body: Record<string, unknown>) => void;
}): void {
  const tag = `${args.intent.mint}:${args.reason}`;
  args.skipped.push(tag);
  appendLiveJsonlEvent({
    kind: 'awakening_entry_skip',
    mint: args.intent.mint,
    reason: args.reason,
    legUsd: args.intent.legUsd,
  });
  args.journalLiveStrategy?.({
    kind: 'awakening_entry_skip',
    mint: args.intent.mint,
    reason: args.reason,
    legUsd: args.intent.legUsd,
    entryPath: 'dormant_awakening',
  });
}

function rowFromIntent(intent: AwakeningLiveEntryIntent): SnapshotCandidateRow {
  const now = new Date(intent.ts);
  return {
    mint: intent.mint,
    symbol: intent.mint.slice(0, 8),
    ts: now,
    launch_ts: null,
    age_min: 0,
    price_usd: intent.priceUsd ?? 0,
    liquidity_usd: intent.liquidityUsd ?? 0,
    volume_5m: intent.volume5mUsd ?? 0,
    volume_1h: 0,
    buys_5m: 0,
    sells_5m: 0,
    market_cap_usd: intent.marketCapUsd ?? 0,
    holder_count: 0,
    token_age_min: 0,
    pair_address: intent.pairAddress ?? '',
    source: 'pumpswap',
  };
}

function featuresFromIntent(intent: AwakeningLiveEntryIntent, row: SnapshotCandidateRow): SnapshotFeatures {
  const buys = Number(row.buys_5m ?? 0);
  const sells = Number(row.sells_5m ?? 0);
  const total = buys + sells;
  return {
    price_usd: Number(row.price_usd ?? intent.priceUsd ?? 0),
    liq_usd: Number(row.liquidity_usd ?? intent.liquidityUsd ?? 0),
    pair_address: row.pair_address || intent.pairAddress,
    vol5m_usd: Number(row.volume_5m ?? intent.volume5mUsd ?? 0),
    vol1h_usd: Number(row.volume_1h ?? 0),
    buys5m: buys,
    sells5m: sells,
    buy_sell_ratio_5m: total > 0 ? buys / total : null,
    holders: 0,
    token_age_min: Number(row.token_age_min ?? 0),
    dip_pct: null,
    impulse_pct: null,
    dip_lookback_min: null,
    market_cap_usd: intent.marketCapUsd,
  };
}

function decisionFromIntent(intent: AwakeningLiveEntryIntent, row: SnapshotCandidateRow): EvalDecision {
  return {
    lane: 'post_migration' as Lane,
    source: row.source,
    mint: intent.mint,
    symbol: row.symbol,
    ageMin: Number(row.age_min ?? 0),
    pass: true,
    reasons: ['awakening_signal'],
    features: featuresFromIntent(intent, row),
    whale: null,
    entryPath: 'dormant_awakening',
    liveOscarTradeLane: 'dormant_awakening',
  };
}

/**
 * Consume awakening entry intents queued by awakening-catcher (live mode).
 */
export async function processAwakeningLiveEntryQueue(args: {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  open: Map<string, OpenTrade>;
  discovery: LiveOscarPhase4Discovery;
  journalLiveStrategy?: (body: Record<string, unknown>) => void;
  maxOpenPositions?: number;
}): Promise<{ attempted: number; opened: number; skipped: string[] }> {
  const skipped: string[] = [];
  if (!awakeningLiveEntryEnabled()) {
    return { attempted: 0, opened: 0, skipped };
  }
  const targetStrategyId = awakeningLiveEntryStrategyId();
  if (args.liveCfg.strategyId !== targetStrategyId) {
    return { attempted: 0, opened: 0, skipped };
  }
  if (args.liveCfg.executionMode !== 'live' || !args.liveCfg.strategyEnabled) {
    return { attempted: 0, opened: 0, skipped };
  }

  const queuePath = awakeningLiveEntryQueuePathFromEnv();
  const pending = readPendingIntents(queuePath);
  if (pending.intents.length === 0) return { attempted: 0, opened: 0, skipped };

  const maxOpen = Math.max(1, args.maxOpenPositions ?? 3);
  let opened = 0;
  let cursorAdvanceTo = pending.startOffset;

  for (let i = 0; i < pending.intents.length; i++) {
    const intent = pending.intents[i]!;
    const lineEnd = pending.lineEndOffsets[i] ?? pending.startOffset;
    const permanentSkip = (reason: string) => {
      journalAwakeningSkip({ intent, reason, skipped, journalLiveStrategy: args.journalLiveStrategy });
      cursorAdvanceTo = lineEnd;
    };

    if (countOpenDormantAwakeningPositions(args.open) >= maxOpen) {
      permanentSkip('max_open');
      continue;
    }
    if (dormantAwakeningMintAlreadyOpen(args.open, intent.mint)) {
      permanentSkip('already_open');
      continue;
    }
    if (isMintPermanentlyDeniedLiveOscar(args.liveCfg, intent.mint)) {
      permanentSkip('denylist');
      continue;
    }
    if (!(intent.legUsd > 0) || !(intent.priceUsd != null && intent.priceUsd > 0)) {
      permanentSkip('bad_quote');
      continue;
    }

    const row = rowFromIntent(intent);
    const dex = snapshotSourceToDex(row.source);
    const ot = makeOpenTradeFromEntry({
      cfg: args.paperCfg,
      row,
      lane: 'post_migration' as Lane,
      dex,
      liquidityUsd: row.liquidity_usd,
      firstLegUsdOverride: intent.legUsd,
    });
    stampDormantAwakeningOnOpen(ot);
    stampLiveOscarExitPolicyOnOpen(ot, args.paperCfg);
    if (intent.marketCapUsd != null && intent.marketCapUsd >= 300_000) {
      ot.liveOscarMcapTier = intent.marketCapUsd < 3_000_000 ? 'low' : 'prod';
    }

    const snapshotEntryPriceUsd = intent.priceUsd;
    const decision = decisionFromIntent(intent, row);
    const openedRes = await args.discovery.tryExecuteBuyOpen({
      liveCfg: args.liveCfg,
      paperCfg: args.paperCfg,
      ot,
      decision,
      snapshotEntryPriceUsd,
      tokenDecimals: null,
    });

    if (!openedRes.ok) {
      journalAwakeningSkip({
        intent,
        reason: openedRes.terminalMessage ?? 'buy_fail',
        skipped,
        journalLiveStrategy: args.journalLiveStrategy,
      });
      break;
    }

    args.open.set(dormantAwakeningOpenMapKey(intent.mint), ot);
    opened += 1;
    cursorAdvanceTo = lineEnd;
    args.journalLiveStrategy?.({
      kind: 'live_position_open',
      mint: intent.mint,
      entryPath: 'dormant_awakening',
      legUsd: intent.legUsd,
      awakeningSource: intent.source,
      openTrade: { mint: ot.mint, symbol: ot.symbol, avgEntry: ot.avgEntry, legs: ot.legs.length },
    });
    log.info(
      { mint: intent.mint, legUsd: intent.legUsd, mcap: intent.marketCapUsd },
      'awakening live entry opened',
    );
  }

  if (cursorAdvanceTo > pending.startOffset) {
    saveCursor(queuePath, cursorAdvanceTo);
  }

  if (skipped.length > 0 || opened > 0) {
    log.info(
      { skipped, opened, attempted: pending.intents.length, cursorAdvanceTo },
      'awakening live entries consumed',
    );
  }

  return { attempted: pending.intents.length, opened, skipped };
}

function awakeningLiveEntryFastPollMs(): number {
  const raw = process.env.AWAKENING_LIVE_ENTRY_FAST_POLL_MS?.trim();
  if (!raw) return 3_000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(30_000, Math.max(1_000, n));
}

/** Poll awakening queue outside heavy discovery tick (CHANCE 97m queue stall class). */
export function startAwakeningLiveEntryFastPoll(args: {
  paperCfg: PaperTraderConfig;
  liveCfg: LiveOscarConfig;
  getOpen: () => Map<string, OpenTrade>;
  getDiscovery: () => LiveOscarPhase4Discovery;
  journalLiveStrategy?: (body: Record<string, unknown>) => void;
}): NodeJS.Timeout | null {
  const intervalMs = awakeningLiveEntryFastPollMs();
  if (!(intervalMs > 0)) return null;
  if (!awakeningLiveEntryEnabled()) return null;
  if (args.liveCfg.strategyId !== awakeningLiveEntryStrategyId()) return null;
  if (args.liveCfg.executionMode !== 'live' || !args.liveCfg.strategyEnabled) return null;

  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void processAwakeningLiveEntryQueue({
      liveCfg: args.liveCfg,
      paperCfg: args.paperCfg,
      open: args.getOpen(),
      discovery: args.getDiscovery(),
      journalLiveStrategy: args.journalLiveStrategy,
      maxOpenPositions: Number(process.env.AWAKENING_MAX_OPEN_POSITIONS ?? 3),
    })
      .catch((e) => {
        log.warn({ err: (e as Error)?.message }, 'awakening fast poll failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
