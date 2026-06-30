import fs from 'node:fs';
import path from 'node:path';

export const COPY_LEADER_POSITION_SOURCE = 'copy_leader' as const;

export type CopyPosition = {
  mint: string;
  symbol: string;
  /** Parallel leg vs live-oscar — never counted in oscar open map. */
  positionSource?: typeof COPY_LEADER_POSITION_SOURCE;
  entryTs: number;
  /** Volume-weighted average entry price. */
  entryPriceUsd: number;
  /** Total notional deployed (entry + adds). */
  sizeUsd: number;
  /** Cumulative USD spent on entry legs (probe + dip); not mark-to-market. */
  entryDeployedCostUsd?: number;
  /** Staged entry target ($1000 full tier or $600 mid mcap tier). */
  entryTargetUsd?: number;
  /** Dex mcap at entry signal (for tier sizing / adds mirror). */
  entryMcapUsd?: number;
  /** Token balance raw string (live fills / paper estimate). */
  tokenRaw?: string;
  addCount: number;
  leaderWallet: string;
  leaderEntrySig: string;
  ourEntrySig?: string;
  /** Leader sold before probe+dip filled — never schedule/fill the dip leg. */
  entryDipAbandoned?: boolean;
  /** Last successful sell execution timestamp (ms) — min-interval throttle. */
  lastSellTs?: number;
};

export type LeaderMintLedger = {
  /** Estimated leader token balance from observed swaps (+ RPC bootstrap). */
  tokenRaw: string;
};

export type EntryLeg = 'probe' | 'dip';

export type PendingBuy = {
  id: string;
  mint: string;
  symbol: string;
  kind: 'entry' | 'add';
  /** Entry split: probe (+premium) then dip (−discount from leader). */
  entryLeg?: EntryLeg;
  sizeUsd: number;
  /** Staged entry target when kind=entry (full $1000 or mid $600). */
  entryTargetUsd?: number;
  entryMcapUsd?: number;
  /** Leader add size / pre-buy holdings when kind=add. */
  leaderAddFraction?: number;
  leaderSignature: string;
  leaderPriceUsd: number;
  leaderBuyUsd: number;
  leaderBuyTs: number;
  dueTs: number;
  /** Leader token balance right after the signal buy (detect later sells). */
  leaderHoldingsRawAtSignal?: string;
  /** Keep retrying eval/exec until this ts (after dueTs). */
  retryUntilTs: number;
  lastDeferLogTs?: number;
  /** Consecutive dip-gate passes (Jupiter quote + discount) before fill. */
  dipPassStreak?: number;
  /** Cached Jupiter dip eval quote (eval-only; not used for execution sizing). */
  lastDipQuoteTs?: number;
  lastDipQuotePriceUsd?: number;
};

export type PendingSell = {
  id: string;
  mint: string;
  symbol: string;
  leaderSignature: string;
  leaderSellTs: number;
  dueTs: number;
  /** Fraction of our position to close (1 = full). */
  fraction: number;
  leaderSellFraction?: number;
  /** Keep retrying slippage-class sell errors until this ts. */
  retryUntilTs: number;
  lastDeferLogTs?: number;
};

export type CopyTraderState = {
  lastSignature?: string;
  seenSignatures: Record<string, number>;
  pendingBuys: PendingBuy[];
  pendingSells: PendingSell[];
  positions: Record<string, CopyPosition>;
  leaderLedger: Record<string, LeaderMintLedger>;
};

export function emptyCopyTraderState(): CopyTraderState {
  return {
    seenSignatures: {},
    pendingBuys: [],
    pendingSells: [],
    positions: {},
    leaderLedger: {},
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
        positionSource: pos.positionSource ?? COPY_LEADER_POSITION_SOURCE,
        addCount: typeof pos.addCount === 'number' ? pos.addCount : 0,
        entryDipAbandoned: pos.entryDipAbandoned === true,
        entryDeployedCostUsd:
          typeof pos.entryDeployedCostUsd === 'number' && pos.entryDeployedCostUsd > 0
            ? pos.entryDeployedCostUsd
            : undefined,
        entryTargetUsd:
          typeof pos.entryTargetUsd === 'number' && pos.entryTargetUsd > 0 ? pos.entryTargetUsd : undefined,
        entryMcapUsd:
          typeof pos.entryMcapUsd === 'number' && pos.entryMcapUsd > 0 ? pos.entryMcapUsd : undefined,
      };
    }
    const pendingBuys: PendingBuy[] = (Array.isArray(parsed.pendingBuys) ? parsed.pendingBuys : []).map(
      (p): PendingBuy => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        kind: p.kind === 'add' ? 'add' : 'entry',
        entryLeg: p.entryLeg === 'probe' || p.entryLeg === 'dip' ? p.entryLeg : undefined,
        sizeUsd: typeof p.sizeUsd === 'number' && p.sizeUsd > 0 ? p.sizeUsd : 0,
        entryTargetUsd:
          typeof p.entryTargetUsd === 'number' && p.entryTargetUsd > 0 ? p.entryTargetUsd : undefined,
        entryMcapUsd:
          typeof p.entryMcapUsd === 'number' && p.entryMcapUsd > 0 ? p.entryMcapUsd : undefined,
        leaderAddFraction:
          typeof p.leaderAddFraction === 'number' && p.leaderAddFraction > 0 ? p.leaderAddFraction : undefined,
        leaderSignature: p.leaderSignature,
        leaderPriceUsd: p.leaderPriceUsd,
        leaderBuyUsd: p.leaderBuyUsd,
        leaderBuyTs: p.leaderBuyTs,
        dueTs: p.dueTs,
        leaderHoldingsRawAtSignal:
          typeof p.leaderHoldingsRawAtSignal === 'string' ? p.leaderHoldingsRawAtSignal : undefined,
        retryUntilTs:
          typeof p.retryUntilTs === 'number' && p.retryUntilTs > 0
            ? p.retryUntilTs
            : p.dueTs + 3_600_000,
        lastDeferLogTs: typeof p.lastDeferLogTs === 'number' ? p.lastDeferLogTs : undefined,
        dipPassStreak:
          typeof p.dipPassStreak === 'number' && p.dipPassStreak >= 0 ? p.dipPassStreak : undefined,
      }),
    );
    const pendingSells: PendingSell[] = (Array.isArray(parsed.pendingSells) ? parsed.pendingSells : []).map(
      (p): PendingSell => ({
        id: p.id,
        mint: p.mint,
        symbol: p.symbol,
        leaderSignature: p.leaderSignature,
        leaderSellTs: p.leaderSellTs,
        dueTs: p.dueTs,
        fraction: typeof p.fraction === 'number' && p.fraction > 0 ? Math.min(1, p.fraction) : 1,
        leaderSellFraction:
          typeof p.leaderSellFraction === 'number' && p.leaderSellFraction > 0
            ? Math.min(1, p.leaderSellFraction)
            : undefined,
        retryUntilTs:
          typeof p.retryUntilTs === 'number' && p.retryUntilTs > 0
            ? p.retryUntilTs
            : p.dueTs + 3_600_000,
        lastDeferLogTs: typeof p.lastDeferLogTs === 'number' ? p.lastDeferLogTs : undefined,
      }),
    );
    return {
      lastSignature: parsed.lastSignature,
      seenSignatures: parsed.seenSignatures ?? {},
      pendingBuys,
      pendingSells,
      positions,
      leaderLedger: parsed.leaderLedger ?? {},
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
  if (!(cfg.maxPositionUsd > 0)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, cfg.maxPositionUsd - pos.sizeUsd);
}

export function canScheduleProportionalAdd(
  cfg: { minProportionalAddUsd: number; maxPositionUsd: number },
  pos: CopyPosition,
  addUsd: number,
): boolean {
  if (!(addUsd > 0)) return false;
  if (cfg.minProportionalAddUsd > 0 && addUsd < cfg.minProportionalAddUsd) return false;
  return positionRoomUsd(cfg, pos) >= addUsd;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
