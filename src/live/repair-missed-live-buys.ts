/**
 * Boot-time repair: journal shows failed SOL→token buy but tx landed (e.g. confirm_timeout).
 * Replays chain fill into live_position_open / live_position_dca so dashboard + tracker match wallet.
 */
import fs from 'node:fs';
import { qnCall } from '../core/rpc/qn-client.js';
import type { PaperTraderConfig } from '../papertrader/config.js';
import { applyEntryCosts } from '../papertrader/costs.js';
import { restoreOpenTradeFromJson } from '../papertrader/executor/store-restore.js';
import type { DexId, Metrics, OpenTrade, PositionLeg } from '../papertrader/types.js';
import { serializeOpenTrade } from './strategy-snapshot.js';
import type { LiveOscarConfig } from './config.js';
import { appendLiveJsonlEvent } from './store-jsonl.js';
import { readLiveJournalLinesBounded } from './replay-strategy-journal.js';

function envBool(v: unknown, defaultVal: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultVal;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

function lineMatchesChannel(row: Record<string, unknown>): boolean {
  const ch = row.channel;
  return ch === undefined || ch === null || ch === 'live';
}

type TokenBalRow = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    uiAmount?: number;
    uiAmountString?: string;
    decimals?: number;
  };
};

function uiAmountFromRow(r: TokenBalRow): number {
  const uis = r.uiTokenAmount?.uiAmountString;
  if (uis != null && uis !== '') {
    const n = Number(uis);
    if (Number.isFinite(n)) return n;
  }
  const ui = r.uiTokenAmount?.uiAmount;
  if (typeof ui === 'number' && Number.isFinite(ui)) return ui;
  return 0;
}

function decimalsFromRow(r: TokenBalRow): number | null {
  const d = r.uiTokenAmount?.decimals;
  if (typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= 24) return Math.floor(d);
  return null;
}

/** Sum UI token amount for rows owned by `owner` and mint `mint`. */
function sumTokenUiForOwnerMint(rows: TokenBalRow[], mint: string, owner: string): { ui: number; decimals: number | null } {
  let ui = 0;
  let decimals: number | null = null;
  for (const r of rows) {
    if (r.mint !== mint || r.owner !== owner) continue;
    ui += uiAmountFromRow(r);
    const d = decimalsFromRow(r);
    if (d != null) decimals = d;
  }
  return { ui, decimals };
}

function tokenReceiveDeltaUi(meta: Record<string, unknown>, outputMint: string, walletPk: string): { deltaUi: number; decimals: number | null } | null {
  const pre = (meta.preTokenBalances ?? []) as TokenBalRow[];
  const post = (meta.postTokenBalances ?? []) as TokenBalRow[];
  const preSum = sumTokenUiForOwnerMint(pre, outputMint, walletPk);
  const postSum = sumTokenUiForOwnerMint(post, outputMint, walletPk);
  const delta = postSum.ui - preSum.ui;
  const decimals = postSum.decimals ?? preSum.decimals;
  if (!(delta > 1e-12)) return null;
  return { deltaUi: delta, decimals };
}

function liveRpcBase(cfg: LiveOscarConfig) {
  return {
    feature: 'live_send' as const,
    creditsPerCall: cfg.liveSendCreditsPerCall,
    timeoutMs: Math.min(25_000, Math.max(5000, cfg.liveSendRpcTimeoutMs)),
    httpUrl: cfg.liveRpcHttpUrl,
  };
}

async function fetchTransactionOk(
  cfg: LiveOscarConfig,
  signature: string,
): Promise<{ meta: Record<string, unknown>; blockTimeMs: number } | null> {
  const res = await qnCall<unknown>(
    'getTransaction',
    [
      signature,
      {
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
        commitment: cfg.liveConfirmCommitment,
      },
    ],
    liveRpcBase(cfg),
  );
  if (!res.ok) return null;
  const tx = res.value as {
    meta?: Record<string, unknown>;
    blockTime?: number | null;
  } | null;
  if (tx == null || typeof tx !== 'object') return null;
  const err = tx.meta?.err;
  if (err != null && err !== false) return null;
  if (!tx.meta || typeof tx.meta !== 'object') return null;
  const bt = tx.blockTime;
  const blockTimeMs = typeof bt === 'number' && Number.isFinite(bt) ? bt * 1000 : Date.now();
  return { meta: tx.meta, blockTimeMs };
}

const EMPTY_METRICS: Metrics = {
  uniqueBuyers: 0,
  uniqueSellers: 0,
  sumBuySol: 0,
  sumSellSol: 0,
  topBuyerShare: 0,
  bcProgress: 0,
};

function inferDex(mint: string): DexId {
  return mint.toLowerCase().endsWith('pump') ? 'pumpswap' : 'raydium';
}

function cloneOpenTrade(ot: OpenTrade): OpenTrade {
  const raw = serializeOpenTrade(ot);
  const restored = restoreOpenTradeFromJson(raw as Partial<OpenTrade> & { mint: string });
  if (!restored) throw new Error('repair: cloneOpenTrade failed');
  return restored;
}

function emptyMetrics(): Metrics {
  return { ...EMPTY_METRICS };
}

function buildOpenFromBuyRepair(args: {
  mint: string;
  symbol: string;
  dex: DexId;
  cfg: PaperTraderConfig;
  investedUsd: number;
  tokenUi: number;
  decimals: number;
  blockTimeMs: number;
}): OpenTrade {
  const marketPrice = args.investedUsd / args.tokenUi;
  const { effectivePrice } = applyEntryCosts(args.cfg, marketPrice, args.dex, args.investedUsd, null);
  const leg: PositionLeg = {
    ts: args.blockTimeMs,
    price: effectivePrice,
    marketPrice,
    sizeUsd: args.investedUsd,
    reason: 'open',
  };
  return {
    mint: args.mint,
    symbol: args.symbol,
    lane: 'post_migration',
    metricType: 'price',
    dex: args.dex,
    entryTs: args.blockTimeMs,
    entryMcUsd: marketPrice,
    entryMetrics: emptyMetrics(),
    peakMcUsd: marketPrice,
    peakPnlPct: 0,
    trailingArmed: false,
    legs: [leg],
    partialSells: [],
    totalInvestedUsd: args.investedUsd,
    avgEntry: effectivePrice,
    avgEntryMarket: marketPrice,
    remainingFraction: 1,
    dcaUsedLevels: new Set(),
    dcaUsedIndices: new Set(),
    ladderUsedLevels: new Set(),
    ladderUsedIndices: new Set(),
    pairAddress: null,
    entryLiqUsd: null,
    tokenDecimals: args.decimals,
  };
}

function mergeDcaLeg(ot: OpenTrade, args: { addUsd: number; marketBuy: number; effectiveBuy: number; ts: number }): void {
  ot.legs.push({
    ts: args.ts,
    price: args.effectiveBuy,
    marketPrice: args.marketBuy,
    sizeUsd: args.addUsd,
    reason: 'dca',
  });
  ot.totalInvestedUsd += args.addUsd;
  const num = ot.legs.reduce((s, l) => s + l.sizeUsd * l.price, 0);
  ot.avgEntry = num / ot.totalInvestedUsd;
  const numM = ot.legs.reduce((s, l) => s + l.sizeUsd * (l.marketPrice ?? l.price), 0);
  ot.avgEntryMarket = numM / ot.totalInvestedUsd;
  ot.remainingFraction = 1;
}

function collectRepairedBuySignatures(lines: string[], strategyId: string): Set<string> {
  const out = new Set<string>();
  for (const ln of lines) {
    if (!ln.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(row.strategyId ?? '') !== strategyId) continue;
    if (!lineMatchesChannel(row)) continue;
    const kind = String(row.kind ?? '');
    if (kind !== 'live_position_open' && kind !== 'live_position_dca') continue;
    const otRaw = row.openTrade;
    if (typeof otRaw !== 'object' || otRaw === null) continue;
    const o = otRaw as Record<string, unknown>;
    const primary = o.repairedFromTxSignature;
    if (typeof primary === 'string' && primary.length > 8) out.add(primary);
    const legs = o.repairedLegSignatures;
    if (Array.isArray(legs)) {
      for (const x of legs) {
        if (typeof x === 'string' && x.length > 8) out.add(x);
      }
    }
  }
  return out;
}

function normalizeJournalLines(
  storePath: string,
  tailLines: number | undefined,
  sinceTs: number | undefined,
  maxFileBytes: number,
): string[] {
  if (!storePath?.trim() || !fs.existsSync(storePath)) return [];
  const maxB = maxFileBytes >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : maxFileBytes;
  const { lines: rawLines } =
    maxB >= Number.MAX_SAFE_INTEGER
      ? { lines: fs.readFileSync(storePath, 'utf-8').split('\n') }
      : readLiveJournalLinesBounded(storePath, maxB);

  let lines = rawLines.filter((ln) => ln.trim().length > 0);
  if (tailLines != null && tailLines > 0 && lines.length > tailLines) {
    lines = lines.slice(-tailLines);
  }

  if (sinceTs != null && Number.isFinite(sinceTs)) {
    const filtered: string[] = [];
    for (const ln of lines) {
      try {
        const row = JSON.parse(ln) as Record<string, unknown>;
        const ts = row.ts;
        if (typeof ts === 'number' && Number.isFinite(ts) && ts < sinceTs) continue;
      } catch {
        continue;
      }
      filtered.push(ln);
    }
    lines = filtered;
  }
  return lines;
}

interface BuyRepairCandidate {
  intentId: string;
  mint: string;
  attemptTs: number;
  intendedUsd: number;
  signature: string;
  quoteSnapshot: Record<string, unknown>;
}

export async function repairMissedLiveBuysFromJournal(args: {
  liveCfg: LiveOscarConfig;
  paperCfg: PaperTraderConfig;
  /** Replay open map before repair (not mutated). */
  initialOpen: Map<string, OpenTrade>;
  walletPubkey: string;
}): Promise<{ appended: number; scanned: number }> {
  const { liveCfg, paperCfg, initialOpen, walletPubkey } = args;

  if (!envBool(process.env.LIVE_REPAIR_MISSED_OPENS, true)) {
    return { appended: 0, scanned: 0 };
  }

  const maxAgeMsRaw = process.env.LIVE_REPAIR_MISSED_OPEN_MAX_AGE_MS?.trim();
  const maxAgeMs =
    maxAgeMsRaw != null && maxAgeMsRaw !== ''
      ? Math.max(60_000, Number.parseInt(maxAgeMsRaw, 10) || 7 * 24 * 3600 * 1000)
      : 7 * 24 * 3600 * 1000;

  const now = Date.now();
  const lines = normalizeJournalLines(
    liveCfg.liveTradesPath,
    liveCfg.liveReplayTailLines,
    liveCfg.liveReplaySinceTs,
    liveCfg.liveReplayMaxFileBytes,
  );

  const repairedSigs = collectRepairedBuySignatures(lines, liveCfg.strategyId);

  const byIntent = new Map<string, { attempt?: Record<string, unknown>; result?: Record<string, unknown> }>();

  for (const ln of lines) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(row.strategyId ?? '') !== liveCfg.strategyId) continue;
    if (!lineMatchesChannel(row)) continue;

    const kind = String(row.kind ?? '');
    const intentId = row.intentId != null ? String(row.intentId) : '';
    if (!intentId) continue;

    const cur = byIntent.get(intentId) ?? {};
    if (kind === 'execution_attempt') {
      cur.attempt = row;
      byIntent.set(intentId, cur);
    } else if (kind === 'execution_result') {
      cur.result = row;
      byIntent.set(intentId, cur);
    }
  }

  const candidates: BuyRepairCandidate[] = [];

  for (const [intentId, pair] of byIntent) {
    const att = pair.attempt;
    const res = pair.result;
    if (!att || !res) continue;
    if (String(att.side ?? '') !== 'buy') continue;
    if (String(res.status ?? '') !== 'failed') continue;
    const sigRaw = res.txSignature;
    const signature = typeof sigRaw === 'string' && sigRaw.length > 8 ? sigRaw : '';
    if (!signature) continue;

    const mint = String(att.mint ?? '');
    if (!mint) continue;

    const attemptTs = typeof att.ts === 'number' && Number.isFinite(att.ts) ? att.ts : now;
    if (now - attemptTs > maxAgeMs) continue;

    let intendedUsd = typeof att.intendedUsd === 'number' && Number.isFinite(att.intendedUsd) ? att.intendedUsd : 0;
    if (!(intendedUsd > 0)) intendedUsd = paperCfg.positionUsd;

    const quoteSnapshot =
      att.quoteSnapshot && typeof att.quoteSnapshot === 'object'
        ? (att.quoteSnapshot as Record<string, unknown>)
        : {};

    candidates.push({
      intentId,
      mint,
      attemptTs,
      intendedUsd,
      signature,
      quoteSnapshot,
    });
  }

  candidates.sort((a, b) => a.attemptTs - b.attemptTs || a.intentId.localeCompare(b.intentId));

  const byMint = new Map<string, BuyRepairCandidate[]>();
  for (const c of candidates) {
    if (repairedSigs.has(c.signature)) continue;
    const arr = byMint.get(c.mint) ?? [];
    arr.push(c);
    byMint.set(c.mint, arr);
  }

  const working = new Map<string, OpenTrade>();
  for (const [m, ot] of initialOpen) {
    working.set(m, cloneOpenTrade(ot));
  }

  let appended = 0;

  for (const [, group] of byMint) {
    group.sort((a, b) => a.attemptTs - b.attemptTs);
    for (const c of group) {
      if (repairedSigs.has(c.signature)) continue;

      const tx = await fetchTransactionOk(liveCfg, c.signature);
      if (!tx) continue;

      const delta = tokenReceiveDeltaUi(tx.meta, c.mint, walletPubkey);
      if (!delta) continue;

      const decimals = delta.decimals ?? 6;
      const dex = inferDex(c.mint);
      const symbol =
        typeof c.quoteSnapshot.symbol === 'string' && c.quoteSnapshot.symbol.trim()
          ? String(c.quoteSnapshot.symbol).trim().slice(0, 32)
          : '?';

      const hadJournalOpen = initialOpen.has(c.mint);
      let ot = working.get(c.mint);

      if (!ot) {
        const otNew = buildOpenFromBuyRepair({
          mint: c.mint,
          symbol,
          dex,
          cfg: paperCfg,
          investedUsd: c.intendedUsd,
          tokenUi: delta.deltaUi,
          decimals,
          blockTimeMs: tx.blockTimeMs,
        });
        const snap = serializeOpenTrade(otNew);
        snap.repairedFromTxSignature = c.signature;
        snap.repairedLegSignatures = [c.signature];
        appendLiveJsonlEvent({
          kind: 'live_position_open',
          mint: c.mint,
          openTrade: snap,
        });
        working.set(c.mint, otNew);
        repairedSigs.add(c.signature);
        appended++;
        continue;
      }

      if (hadJournalOpen && c.attemptTs < ot.entryTs - 120_000) {
        continue;
      }

      const marketBuy = c.intendedUsd / delta.deltaUi;
      const { effectivePrice: effectiveBuy } = applyEntryCosts(paperCfg, marketBuy, ot.dex, c.intendedUsd, null);
      mergeDcaLeg(ot, {
        addUsd: c.intendedUsd,
        marketBuy,
        effectiveBuy,
        ts: tx.blockTimeMs,
      });
      ot.tokenDecimals = ot.tokenDecimals ?? decimals;

      const snap = serializeOpenTrade(ot);
      const prev = Array.isArray(snap.repairedLegSignatures)
        ? ([...(snap.repairedLegSignatures as unknown[])] as string[])
        : [];
      prev.push(c.signature);
      snap.repairedLegSignatures = prev;

      appendLiveJsonlEvent({
        kind: 'live_position_dca',
        mint: c.mint,
        openTrade: snap,
      });
      working.set(c.mint, ot);
      repairedSigs.add(c.signature);
      appended++;
    }
  }

  return { appended, scanned: candidates.length };
}
