import fs from 'node:fs';
import path from 'node:path';

import type { HyperliquidMarketCache } from './hyperliquid-meta.js';
import { resolveTwapMarket } from './hyperliquid-meta.js';
import type { NormalizedTwapSignal, TwapSide } from './types.js';

export type HlTwapPaperOpen = {
  hash: string;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  entryTs: number;
  entryPx: number;
  notionalUsd: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
};

export type HlTwapPaperClose = HlTwapPaperOpen & {
  exitTs: number;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

type JournalOpen = {
  kind: 'open';
  ts: number;
  hash: string;
  coin: string;
  displaySymbol: string;
  side: TwapSide;
  entryPx: number;
  notionalUsd: number;
  impactPct: number | null;
  whaleUser: string;
  minutes: number;
};

type JournalClose = {
  kind: 'close';
  ts: number;
  hash: string;
  exitPx: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: string;
};

export function paperJournalPath(): string {
  return (
    process.env.HL_TWAP_PAPER_JSONL?.trim() ||
    path.join(process.cwd(), 'data', 'hl-twap', 'paper.jsonl')
  );
}

export function paperNotionalUsd(): number {
  const v = Number(process.env.HL_TWAP_PAPER_NOTIONAL_USD ?? 1000);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

export function loadPaperOpensFromJournal(filePath: string): Map<string, HlTwapPaperOpen> {
  const opens = new Map<string, HlTwapPaperOpen>();
  if (!fs.existsSync(filePath)) return opens;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const ln of text.split('\n')) {
    if (!ln.trim()) continue;
    let ev: JournalOpen | JournalClose;
    try {
      ev = JSON.parse(ln) as JournalOpen | JournalClose;
    } catch {
      continue;
    }
    if (ev.kind === 'open') {
      opens.set(ev.hash, {
        hash: ev.hash,
        coin: ev.coin,
        displaySymbol: ev.displaySymbol,
        side: ev.side,
        entryTs: ev.ts,
        entryPx: ev.entryPx,
        notionalUsd: ev.notionalUsd,
        impactPct: ev.impactPct,
        whaleUser: ev.whaleUser,
        minutes: ev.minutes,
      });
    } else if (ev.kind === 'close') {
      opens.delete(ev.hash);
    }
  }
  return opens;
}

export function appendPaperJournal(filePath: string, row: JournalOpen | JournalClose): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

export function openPaperTrade(sig: NormalizedTwapSignal): HlTwapPaperOpen | null {
  const filePath = paperJournalPath();
  const existing = loadPaperOpensFromJournal(filePath);
  if (existing.has(sig.hash)) return null;

  const notionalUsd = paperNotionalUsd();
  const entryPx = sig.midPx > 0 ? sig.midPx : 0;
  if (entryPx <= 0) return null;

  const open: HlTwapPaperOpen = {
    hash: sig.hash,
    coin: sig.coin,
    displaySymbol: sig.displaySymbol,
    side: sig.side,
    entryTs: Date.now(),
    entryPx,
    notionalUsd,
    impactPct: sig.volumeSharePct,
    whaleUser: sig.user,
    minutes: sig.minutes,
  };

  const row: JournalOpen = { kind: 'open', ts: open.entryTs, ...open };
  appendPaperJournal(filePath, row);
  return open;
}

export function closePaperTrade(
  sig: NormalizedTwapSignal,
  exitPx: number,
  exitReason: string,
): HlTwapPaperClose | null {
  const filePath = paperJournalPath();
  const opens = loadPaperOpensFromJournal(filePath);
  const pos = opens.get(sig.hash);
  if (!pos || exitPx <= 0) return null;

  const dir = pos.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((exitPx - pos.entryPx) / pos.entryPx) * 100;
  const pnlUsd = (pnlPct / 100) * pos.notionalUsd;

  appendPaperJournal(filePath, {
    kind: 'close',
    ts: Date.now(),
    hash: pos.hash,
    exitPx,
    pnlUsd,
    pnlPct,
    exitReason,
  });

  return { ...pos, exitTs: Date.now(), exitPx, pnlUsd, pnlPct, exitReason };
}

export function markPxForCoin(coin: string, cache: HyperliquidMarketCache): number {
  const direct = cache.mids.get(coin);
  if (direct != null && direct > 0) return direct;
  const stripped = coin.includes(':') ? coin.split(':').pop()! : coin.replace(/^@/, '');
  return cache.mids.get(stripped) ?? 0;
}

export function exitPxForOpen(open: HlTwapPaperOpen, cache: HyperliquidMarketCache): number {
  const fromMids = markPxForCoin(open.coin, cache);
  if (fromMids > 0) return fromMids;
  const market = resolveTwapMarket(
    open.coin.startsWith('asset:') ? Number(open.coin.split(':')[1]) : 0,
    cache,
  );
  return market.midPx > 0 ? market.midPx : open.entryPx;
}

export function unrealizedUsd(open: HlTwapPaperOpen, markPx: number): number {
  const dir = open.side === 'buy' ? 1 : -1;
  const pnlPct = dir * ((markPx - open.entryPx) / open.entryPx) * 100;
  return (pnlPct / 100) * open.notionalUsd;
}
