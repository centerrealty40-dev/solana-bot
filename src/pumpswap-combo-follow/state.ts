import fs from 'node:fs';
import path from 'node:path';
import type { ComboState } from '../pumpswap-combo/state.js';
import type { PumpswapComboFollowConfig } from './config.js';
import type { FollowPosition, LeaderMintLedger, PendingFollowBuy } from './types.js';

export type FollowState = {
  positions: FollowPosition[];
  realizedPnlUsd: number;
  halted: boolean;
  haltReason?: string;
  haltedAt?: number;
  lossCooldownUntilByMint: Record<string, number>;
  lastSignature?: string;
  seenSignatures: Record<string, number>;
  leaderLedger: Record<string, LeaderMintLedger>;
  pendingBuys: PendingFollowBuy[];
  /** Last observed leader sell per mint (for exit timing audit). */
  lastLeaderSellByMint: Record<string, import('./types.js').LeaderSellRef>;
  updatedAt: number;
};

function emptyState(): FollowState {
  return {
    positions: [],
    realizedPnlUsd: 0,
    halted: false,
    lossCooldownUntilByMint: {},
    seenSignatures: {},
    leaderLedger: {},
    pendingBuys: [],
    lastLeaderSellByMint: {},
    updatedAt: Date.now(),
  };
}

export function readFollowState(cfg: PumpswapComboFollowConfig): FollowState {
  try {
    const raw = fs.readFileSync(cfg.statePath, 'utf8');
    const j = JSON.parse(raw) as Partial<FollowState>;
    return {
      positions: Array.isArray(j.positions)
        ? j.positions.map((p) => ({
            ...p,
            rungsTaken: Array.isArray(p.rungsTaken) ? p.rungsTaken : [],
            remainingFrac:
              typeof p.remainingFrac === 'number' && p.remainingFrac >= 0 ? p.remainingFrac : 1,
          }))
        : [],
      realizedPnlUsd: Number(j.realizedPnlUsd ?? 0),
      halted: Boolean(j.halted),
      haltReason: typeof j.haltReason === 'string' ? j.haltReason : undefined,
      haltedAt: typeof j.haltedAt === 'number' ? j.haltedAt : undefined,
      lossCooldownUntilByMint:
        j.lossCooldownUntilByMint && typeof j.lossCooldownUntilByMint === 'object'
          ? j.lossCooldownUntilByMint
          : {},
      lastSignature: typeof j.lastSignature === 'string' ? j.lastSignature : undefined,
      seenSignatures:
        j.seenSignatures && typeof j.seenSignatures === 'object' ? j.seenSignatures : {},
      leaderLedger:
        j.leaderLedger && typeof j.leaderLedger === 'object' ? j.leaderLedger : {},
      pendingBuys: Array.isArray(j.pendingBuys) ? j.pendingBuys : [],
      lastLeaderSellByMint:
        j.lastLeaderSellByMint && typeof j.lastLeaderSellByMint === 'object'
          ? j.lastLeaderSellByMint
          : {},
      updatedAt: Number(j.updatedAt ?? Date.now()),
    };
  } catch {
    return emptyState();
  }
}

export function writeFollowState(cfg: PumpswapComboFollowConfig, state: FollowState): void {
  const dir = path.dirname(cfg.statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfg.statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf8');
  fs.renameSync(tmp, cfg.statePath);
}

export function findFollowPosition(state: FollowState, mint: string): FollowPosition | undefined {
  return state.positions.find((p) => p.mint === mint);
}

/** Leader sell that happened while this bag is open — ignores stale refs from prior rounds. */
export function leaderSellSinceOpen(
  state: FollowState,
  mint: string,
  openedAt: number,
): import('./types.js').LeaderSellRef | undefined {
  const ref = state.lastLeaderSellByMint[mint];
  if (!ref || ref.ts < openedAt) return undefined;
  return ref;
}

export function openFollowPositionsCount(state: FollowState): number {
  return state.positions.length;
}

export function newFollowId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function pruneFollowCooldowns(state: FollowState, nowMs: number): void {
  for (const [m, until] of Object.entries(state.lossCooldownUntilByMint)) {
    if (until <= nowMs) delete state.lossCooldownUntilByMint[m];
  }
}

export function isFollowLossCooldownActive(state: FollowState, mint: string, nowMs: number): boolean {
  return (state.lossCooldownUntilByMint[mint] ?? 0) > nowMs;
}

export function setFollowLossCooldown(
  cfg: PumpswapComboFollowConfig,
  state: FollowState,
  mint: string,
  nowMs: number,
): void {
  state.lossCooldownUntilByMint[mint] = nowMs + cfg.lossCooldownMs;
}

export function gcFollowSeenSignatures(state: FollowState, nowMs: number, maxAgeMs = 86_400_000): void {
  for (const [sig, at] of Object.entries(state.seenSignatures)) {
    if (nowMs - at > maxAgeMs) delete state.seenSignatures[sig];
  }
}

/** Bridge for pumpswap-combo risk/pricing helpers (ComboPosition requires tp1Taken). */
export function followStateAsCombo(state: FollowState): ComboState {
  return {
    positions: state.positions.map((p) => ({
      mint: p.mint,
      symbol: p.symbol,
      poolAddress: p.poolAddress,
      openedAt: p.openedAt,
      legs: p.legs,
      botPeakUsd: p.botPeakUsd,
      tp1Taken: p.rungsTaken.length > 0,
    })),
    realizedPnlUsd: state.realizedPnlUsd,
    halted: state.halted,
    haltReason: state.haltReason,
    haltedAt: state.haltedAt,
    lossCooldownUntilByMint: state.lossCooldownUntilByMint,
    updatedAt: state.updatedAt,
  };
}
