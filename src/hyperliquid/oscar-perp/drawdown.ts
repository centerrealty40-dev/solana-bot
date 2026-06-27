import fs from 'node:fs';
import path from 'node:path';

import type { HlOscarPerpConfig } from './config.js';

export type OscarDrawdownState = {
  peakAccountValueUsd: number;
  peakUpdatedAtMs: number;
  halted: boolean;
  haltedAtMs?: number;
  haltReason?: string;
  lastCheckMs?: number;
  lastAccountValueUsd?: number;
  lastDrawdownUsd?: number;
};

function envBool(name: string, defaultOn: boolean): boolean {
  const v = process.env[name]?.trim();
  if (v == null || v === '') return defaultOn;
  return v === '1' || v.toLowerCase() === 'true' || v === 'yes';
}

export function oscarDrawdownStatePath(cfg: HlOscarPerpConfig): string {
  return (
    process.env.HL_OSCAR_DRAWDOWN_STATE_PATH?.trim() ||
    path.join(path.dirname(cfg.journalPath), 'drawdown-stop.json')
  );
}

export function loadOscarDrawdownState(filePath: string): OscarDrawdownState | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as OscarDrawdownState;
  } catch {
    return null;
  }
}

export function saveOscarDrawdownState(state: OscarDrawdownState, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8');
}

export function isOscarTradingHalted(cfg: HlOscarPerpConfig): boolean {
  if (cfg.drawdownStopUsd <= 0) return false;
  return loadOscarDrawdownState(oscarDrawdownStatePath(cfg))?.halted === true;
}

export async function initOscarDrawdownMonitor(
  cfg: HlOscarPerpConfig,
  equityUsd: number,
): Promise<OscarDrawdownState | null> {
  if (cfg.drawdownStopUsd <= 0) return null;
  const filePath = oscarDrawdownStatePath(cfg);
  const clearHalt = envBool('HL_OSCAR_DRAWDOWN_CLEAR_HALT', false);
  const existing = loadOscarDrawdownState(filePath);
  if (existing?.halted && !clearHalt) {
    console.warn('[hl-oscar-perp:drawdown] trading HALTED — set HL_OSCAR_DRAWDOWN_CLEAR_HALT=1 to resume');
    return existing;
  }
  const state: OscarDrawdownState = {
    peakAccountValueUsd: equityUsd,
    peakUpdatedAtMs: Date.now(),
    halted: false,
    lastAccountValueUsd: equityUsd,
    lastDrawdownUsd: 0,
  };
  saveOscarDrawdownState(state, filePath);
  console.log(
    `[hl-oscar-perp:drawdown] peak=$${equityUsd.toFixed(2)} threshold=$${cfg.drawdownStopUsd}`,
  );
  return state;
}

export async function runOscarDrawdownCheck(
  cfg: HlOscarPerpConfig,
  equityUsd: number,
): Promise<boolean> {
  if (cfg.drawdownStopUsd <= 0 || cfg.mode !== 'live') return false;
  const filePath = oscarDrawdownStatePath(cfg);
  const state = loadOscarDrawdownState(filePath);
  if (!state || state.halted) return state?.halted === true;

  const newPeak = Math.max(state.peakAccountValueUsd, equityUsd);
  if (newPeak > state.peakAccountValueUsd) state.peakUpdatedAtMs = Date.now();
  state.peakAccountValueUsd = newPeak;
  const drawdownUsd = Math.max(0, newPeak - equityUsd);
  state.lastCheckMs = Date.now();
  state.lastAccountValueUsd = equityUsd;
  state.lastDrawdownUsd = drawdownUsd;
  saveOscarDrawdownState(state, filePath);

  if (drawdownUsd < cfg.drawdownStopUsd) return false;

  state.halted = true;
  state.haltedAtMs = Date.now();
  state.haltReason = 'drawdown_stop';
  saveOscarDrawdownState(state, filePath);
  console.error(
    `[hl-oscar-perp:drawdown] STOP: peak $${newPeak.toFixed(2)} equity $${equityUsd.toFixed(2)} dd $${drawdownUsd.toFixed(2)}`,
  );
  return true;
}
