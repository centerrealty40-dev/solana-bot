import fs from 'node:fs';
import path from 'node:path';

import type { OscarOpenPosition } from './position-types.js';

export type OscarJournalRow =
  | {
      kind: 'open';
      ts: number;
      id: string;
      coin: string;
      displaySymbol: string;
      legIndex: number;
      signalPrice: number;
      fillPx: number;
      grossUsd: number;
      marginUsd: number;
      dipPct: number;
      impulsePct: number;
      windowMin: number;
      mode: 'dry_run' | 'live';
    }
  | {
      kind: 'add_leg';
      ts: number;
      id: string;
      coin: string;
      legIndex: number;
      fillPx: number;
      grossUsd: number;
      marginUsd: number;
      avgEntryPx: number;
      mode: 'dry_run' | 'live';
    }
  | {
      kind: 'partial_exit';
      ts: number;
      id: string;
      coin: string;
      reason: string;
      fraction: number;
      fillPx: number;
      notionalUsd: number;
      pnlUsd: number;
      remainingFraction: number;
      mode: 'dry_run' | 'live';
    }
  | {
      kind: 'close';
      ts: number;
      id: string;
      coin: string;
      reason: string;
      exitPx: number;
      pnlUsd: number;
      pnlPct: number;
      holdHours: number;
      mode: 'dry_run' | 'live';
    }
  | {
      kind: 'signal_skip';
      ts: number;
      coin: string;
      reason: string;
    }
  | {
      kind: 'heartbeat';
      ts: number;
      openCount: number;
      mode: 'dry_run' | 'live';
      universeSize: number;
    };

export function appendOscarJournal(journalPath: string, row: OscarJournalRow): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.appendFileSync(journalPath, `${JSON.stringify(row)}\n`, 'utf8');
}

export function loadOscarOpensFromJournal(journalPath: string): Map<string, OscarOpenPosition> {
  const opens = new Map<string, OscarOpenPosition>();
  if (!fs.existsSync(journalPath)) return opens;

  const lines = fs.readFileSync(journalPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = row.kind;
    const id = typeof row.id === 'string' ? row.id : null;
    if (!id) continue;

    if (kind === 'open') {
      const pos: OscarOpenPosition = {
        id,
        coin: String(row.coin),
        displaySymbol: String(row.displaySymbol ?? row.coin),
        entryTs: Number(row.ts),
        signalPrice: Number(row.signalPrice),
        signalBarTs: Number(row.ts),
        dipPct: Number(row.dipPct),
        impulsePct: Number(row.impulsePct),
        windowMin: Number(row.windowMin),
        legs: [
          {
            ts: Number(row.ts),
            grossUsd: Number(row.grossUsd),
            marginUsd: Number(row.marginUsd),
            fillPx: Number(row.fillPx),
            legIndex: 1,
          },
        ],
        avgEntryPx: Number(row.fillPx),
        totalGrossUsd: Number(row.grossUsd),
        remainingFraction: 1,
        realizedPnlUsd: 0,
        tpLevelsTaken: new Set(),
        trailLevelsTaken: new Set(),
        maxTpTaken: 0,
        peakPnlFrac: -Infinity,
        trailAnchor: 0,
        preArmReached: false,
        leg2Filled: false,
        leg3Filled: false,
      };
      opens.set(id, pos);
    } else if (kind === 'add_leg') {
      const pos = opens.get(id);
      if (!pos) continue;
      const legIndex = Number(row.legIndex) as 2 | 3;
      pos.legs.push({
        ts: Number(row.ts),
        grossUsd: Number(row.grossUsd),
        marginUsd: Number(row.marginUsd),
        fillPx: Number(row.fillPx),
        legIndex,
      });
      pos.avgEntryPx = Number(row.avgEntryPx);
      pos.totalGrossUsd = pos.legs.reduce((s, l) => s + l.grossUsd, 0);
      if (legIndex === 2) pos.leg2Filled = true;
      if (legIndex === 3) pos.leg3Filled = true;
    } else if (kind === 'partial_exit') {
      const pos = opens.get(id);
      if (!pos) continue;
      pos.remainingFraction = Number(row.remainingFraction);
      pos.realizedPnlUsd += Number(row.pnlUsd);
    } else if (kind === 'close') {
      opens.delete(id);
    }
  }
  return opens;
}

export function lastEntryBarTsByCoin(journalPath: string): Map<string, number> {
  const map = new Map<string, number>();
  if (!fs.existsSync(journalPath)) return map;
  const lines = fs.readFileSync(journalPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.kind === 'open' && typeof row.coin === 'string') {
        map.set(row.coin, Number(row.ts));
      }
    } catch {
      /* skip */
    }
  }
  return map;
}

export function writeHeartbeat(
  heartbeatPath: string,
  payload: { openCount: number; mode: 'dry_run' | 'live'; universeSize: number },
): void {
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.writeFileSync(
    heartbeatPath,
    `${JSON.stringify({ ts: Date.now(), ...payload })}\n`,
    'utf8',
  );
}
