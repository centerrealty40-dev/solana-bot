import fs from 'node:fs';
import path from 'node:path';

export type CopyPosition = {
  mint: string;
  symbol: string;
  entryTs: number;
  /** Volume-weighted average entry price. */
  entryPriceUsd: number;
  /** Total notional deployed (entry + adds). */
  sizeUsd: number;
  addCount: number;
  leaderWallet: string;
  leaderEntrySig: string;
  ourEntrySig?: string;
};

export type PendingBuy = {
  id: string;
  mint: string;
  symbol: string;
  kind: 'entry' | 'add';
  sizeUsd: number;
  leaderSignature: string;
  leaderPriceUsd: number;
  leaderBuyUsd: number;
  leaderBuyTs: number;
  dueTs: number;
};

export type PendingSell = {
  id: string;
  mint: string;
  symbol: string;
  leaderSignature: string;
  leaderSellTs: number;
  dueTs: number;
  /** Fraction of position to close (1 = full). */
  fraction: number;
};

export type CopyTraderState = {
  lastSignature?: string;
  seenSignatures: Record<string, number>;
  pendingBuys: PendingBuy[];
  pendingSells: PendingSell[];
  positions: Record<string, CopyPosition>;
};

export function emptyCopyTraderState(): CopyTraderState {
  return {
    seenSignatures: {},
    pendingBuys: [],
    pendingSells: [],
    positions: {},
  };
}

export function readCopyTraderState(statePath: string): CopyTraderState {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as CopyTraderState;
    const positions: Record<string, CopyPosition> = {};
    for (const [mint, pos] of Object.entries(parsed.positions ?? {})) {
      positions[mint] = {
        ...pos,
        addCount: typeof pos.addCount === 'number' ? pos.addCount : 0,
      };
    }
    const pendingBuys: PendingBuy[] = (Array.isArray(parsed.pendingBuys) ? parsed.pendingBuys : []).map(
      (p): PendingBuy => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        kind: p.kind === 'add' ? 'add' : 'entry',
        sizeUsd: typeof p.sizeUsd === 'number' && p.sizeUsd > 0 ? p.sizeUsd : 0,
        leaderSignature: p.leaderSignature,
        leaderPriceUsd: p.leaderPriceUsd,
        leaderBuyUsd: p.leaderBuyUsd,
        leaderBuyTs: p.leaderBuyTs,
        dueTs: p.dueTs,
      }),
    );
    return {
      lastSignature: parsed.lastSignature,
      seenSignatures: parsed.seenSignatures ?? {},
      pendingBuys,
      pendingSells: Array.isArray(parsed.pendingSells) ? parsed.pendingSells : [],
      positions,
    };
  } catch {
    return emptyCopyTraderState();
  }
}

export function writeCopyTraderState(statePath: string, state: CopyTraderState): void {
  const dir = path.dirname(statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, statePath);
}

export function gcSeenSignatures(state: CopyTraderState, ttlMs: number): void {
  const cutoff = Date.now() - ttlMs;
  for (const [sig, ts] of Object.entries(state.seenSignatures)) {
    if (!Number.isFinite(ts) || ts < cutoff) delete state.seenSignatures[sig];
  }
}

export function openPositionsCount(state: CopyTraderState): number {
  return Object.keys(state.positions).length;
}

export function hasPendingBuyForMint(state: CopyTraderState, mint: string): boolean {
  return state.pendingBuys.some((p) => p.mint === mint);
}

export function hasPendingSellForMint(state: CopyTraderState, mint: string): boolean {
  return state.pendingSells.some((p) => p.mint === mint);
}

export function positionRoomUsd(cfg: { maxPositionUsd: number }, pos: CopyPosition): number {
  return Math.max(0, cfg.maxPositionUsd - pos.sizeUsd);
}

export function canScheduleAdd(
  cfg: { addPositionUsd: number; maxPositionUsd: number; maxAddsPerMint: number },
  pos: CopyPosition,
): boolean {
  if (pos.addCount >= cfg.maxAddsPerMint) return false;
  return positionRoomUsd(cfg, pos) >= cfg.addPositionUsd;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
