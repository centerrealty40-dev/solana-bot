import fs from 'node:fs';
import path from 'node:path';
import type { PumpswapComboConfig } from './config.js';
import type { ComboPosition } from './types.js';

export type ComboState = {
  positions: ComboPosition[];
  realizedPnlUsd: number;
  halted: boolean;
  haltReason?: string;
  haltedAt?: number;
  /** mint → ms until re-entry after losing close */
  lossCooldownUntilByMint: Record<string, number>;
  updatedAt: number;
};

function emptyState(): ComboState {
  return {
    positions: [],
    realizedPnlUsd: 0,
    halted: false,
    lossCooldownUntilByMint: {},
    updatedAt: Date.now(),
  };
}

export function readComboState(cfg: PumpswapComboConfig): ComboState {
  try {
    const raw = fs.readFileSync(cfg.statePath, 'utf8');
    const j = JSON.parse(raw) as Partial<ComboState>;
    return {
      positions: Array.isArray(j.positions) ? j.positions : [],
      realizedPnlUsd: Number(j.realizedPnlUsd ?? 0),
      halted: Boolean(j.halted),
      haltReason: typeof j.haltReason === 'string' ? j.haltReason : undefined,
      haltedAt: typeof j.haltedAt === 'number' ? j.haltedAt : undefined,
      lossCooldownUntilByMint:
        j.lossCooldownUntilByMint && typeof j.lossCooldownUntilByMint === 'object'
          ? j.lossCooldownUntilByMint
          : {},
      updatedAt: Number(j.updatedAt ?? Date.now()),
    };
  } catch {
    return emptyState();
  }
}

export function writeComboState(cfg: PumpswapComboConfig, state: ComboState): void {
  const dir = path.dirname(cfg.statePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${cfg.statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf8');
  fs.renameSync(tmp, cfg.statePath);
}

export function findPosition(state: ComboState, mint: string): ComboPosition | undefined {
  return state.positions.find((p) => p.mint === mint);
}

export function investedUsd(pos: ComboPosition): number {
  return pos.legs.reduce((s, l) => s + l.usd, 0);
}

export function avgFillPrice(pos: ComboPosition): number {
  let w = 0;
  let t = 0;
  for (const l of pos.legs) {
    if (l.fillPriceUsd > 0) {
      w += l.usd;
      t += l.usd / l.fillPriceUsd;
    }
  }
  return t > 0 ? w / t : 0;
}

export function isLossCooldownActive(state: ComboState, mint: string, nowMs: number): boolean {
  const until = state.lossCooldownUntilByMint[mint] ?? 0;
  return until > nowMs;
}

export function setLossCooldown(cfg: PumpswapComboConfig, state: ComboState, mint: string, nowMs: number): void {
  state.lossCooldownUntilByMint[mint] = nowMs + cfg.lossCooldownMs;
}

export function pruneCooldowns(state: ComboState, nowMs: number): void {
  for (const [m, until] of Object.entries(state.lossCooldownUntilByMint)) {
    if (until <= nowMs) delete state.lossCooldownUntilByMint[m];
  }
}
