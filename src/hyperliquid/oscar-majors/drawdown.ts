import fs from 'node:fs';
import path from 'node:path';

import type { HlOscarMajorsConfig } from './config.js';
import { notifyMajorsDrawdownHalt } from './telegram-notify.js';

export type MajorsDrawdownState = {
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
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

export function majorsDrawdownStatePath(cfg: HlOscarMajorsConfig): string {
  return (
    process.env.HL_MAJORS_DRAWDOWN_STATE_PATH?.trim() ||
    path.join(path.dirname(cfg.journalPath), 'drawdown-stop.json')
  );
}

export function loadMajorsDrawdownState(filePath: string): MajorsDrawdownState | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as MajorsDrawdownState;
  } catch {
    return null;
  }
}

export function saveMajorsDrawdownState(state: MajorsDrawdownState, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, 'utf8');
}

export function isMajorsTradingHalted(cfg: HlOscarMajorsConfig): boolean {
  if (cfg.drawdownStopUsd <= 0) return false;
  return loadMajorsDrawdownState(majorsDrawdownStatePath(cfg))?.halted === true;
}

export async function initMajorsDrawdownMonitor(
  cfg: HlOscarMajorsConfig,
  equityUsd: number,
): Promise<MajorsDrawdownState | null> {
  if (cfg.drawdownStopUsd <= 0) return null;
  const filePath = majorsDrawdownStatePath(cfg);
  const clearHalt = envBool('HL_MAJORS_DRAWDOWN_CLEAR_HALT', false);
  const existing = loadMajorsDrawdownState(filePath);
  if (existing?.halted && !clearHalt) {
    console.warn('[hl-oscar-majors:drawdown] trading HALTED — set HL_MAJORS_DRAWDOWN_CLEAR_HALT=1 to resume');
    return existing;
  }
  const state: MajorsDrawdownState = {
    peakAccountValueUsd: equityUsd,
    peakUpdatedAtMs: Date.now(),
    halted: false,
    lastAccountValueUsd: equityUsd,
    lastDrawdownUsd: 0,
  };
  saveMajorsDrawdownState(state, filePath);
  console.log(
    `[hl-oscar-majors:drawdown] peak=$${equityUsd.toFixed(2)} threshold=$${cfg.drawdownStopUsd}`,
  );
  return state;
}

export async function runMajorsDrawdownCheck(
  cfg: HlOscarMajorsConfig,
  equityUsd: number,
): Promise<boolean> {
  if (cfg.drawdownStopUsd <= 0 || cfg.mode !== 'live') return false;
  const filePath = majorsDrawdownStatePath(cfg);
  const state = loadMajorsDrawdownState(filePath);
  if (!state || state.halted) return state?.halted === true;

  const newPeak = Math.max(state.peakAccountValueUsd, equityUsd);
  if (newPeak > state.peakAccountValueUsd) state.peakUpdatedAtMs = Date.now();
  state.peakAccountValueUsd = newPeak;
  const drawdownUsd = Math.max(0, newPeak - equityUsd);
  state.lastCheckMs = Date.now();
  state.lastAccountValueUsd = equityUsd;
  state.lastDrawdownUsd = drawdownUsd;
  saveMajorsDrawdownState(state, filePath);

  if (drawdownUsd < cfg.drawdownStopUsd) return false;

  state.halted = true;
  state.haltedAtMs = Date.now();
  state.haltReason = 'drawdown_stop';
  saveMajorsDrawdownState(state, filePath);
  console.error(
    `[hl-oscar-majors:drawdown] STOP: peak $${newPeak.toFixed(2)} equity $${equityUsd.toFixed(2)} dd $${drawdownUsd.toFixed(2)}`,
  );
  await notifyMajorsDrawdownHalt({
    peakUsd: newPeak,
    equityUsd,
    drawdownUsd,
    thresholdUsd: cfg.drawdownStopUsd,
  });
  return true;
}
