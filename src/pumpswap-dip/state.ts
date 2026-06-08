import fs from 'node:fs';
import path from 'node:path';
import type { PumpswapDipConfig } from './config.js';
import type { PumpswapDipPosition } from './types.js';

export type PumpswapDipState = {
  positions: PumpswapDipPosition[];
  /** Recent buy timestamps per mint (for hourly cap). */
  buyTsHistoryByMint: Record<string, number[]>;
  updatedAt: number;
};

function emptyState(): PumpswapDipState {
  return { positions: [], buyTsHistoryByMint: {}, updatedAt: Date.now() };
}

export function readPumpswapDipState(cfg: PumpswapDipConfig): PumpswapDipState {
  try {
    const raw = fs.readFileSync(cfg.statePath, 'utf8');
    const j = JSON.parse(raw) as Partial<PumpswapDipState> & { lastBuyTsByMint?: Record<string, number> };
    const buyTsHistoryByMint =
      j.buyTsHistoryByMint && typeof j.buyTsHistoryByMint === 'object'
        ? j.buyTsHistoryByMint
        : j.lastBuyTsByMint
          ? Object.fromEntries(
              Object.entries(j.lastBuyTsByMint).map(([m, ts]) => [m, [Number(ts)]]),
            )
          : {};
    return {
      positions: Array.isArray(j.positions) ? j.positions : [],
      buyTsHistoryByMint,
      updatedAt: Number(j.updatedAt ?? Date.now()),
    };
  } catch {
    return emptyState();
  }
}

export function writePumpswapDipState(cfg: PumpswapDipConfig, state: PumpswapDipState): void {
  const dir = path.dirname(cfg.statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfg.statePath}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2),
    'utf8',
  );
  fs.renameSync(tmp, cfg.statePath);
}

export function openPositionCount(state: PumpswapDipState): number {
  return state.positions.length;
}

export function findPosition(state: PumpswapDipState, mint: string): PumpswapDipPosition | undefined {
  return state.positions.find((p) => p.mint === mint);
}

export function canBuyMint(state: PumpswapDipState, cfg: PumpswapDipConfig, mint: string, nowMs: number): boolean {
  if (findPosition(state, mint)) return false;
  const hist = state.buyTsHistoryByMint[mint] ?? [];
  const recent = hist.filter((ts) => nowMs - ts < 3_600_000);
  return recent.length < cfg.maxBuysPerMintPerHour;
}

export function recordBuyAttempt(state: PumpswapDipState, mint: string, nowMs: number): void {
  const hist = state.buyTsHistoryByMint[mint] ?? [];
  hist.push(nowMs);
  state.buyTsHistoryByMint[mint] = hist.filter((ts) => nowMs - ts < 24 * 3_600_000);
}
