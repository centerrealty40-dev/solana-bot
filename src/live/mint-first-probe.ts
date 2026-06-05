/**
 * Live Oscar — «первый раз по mint»: жёсткий signal-kill −7%, без усреднения −7/−14%;
 * убыток → permanent denylist; прибыльное закрытие → graduated (стандартная логика дальше).
 */
import fs from 'node:fs';
import path from 'node:path';

import { child } from '../core/logger.js';
import type { LiveOscarConfig } from './config.js';
import { appendMintToPermanentDenylistLocal } from './mint-permanent-denylist.js';

const log = child('live-mint-first-probe');

export function liveMintFirstProbeEnabled(cfg: Pick<LiveOscarConfig, 'liveMintFirstProbeEnabled'>): boolean {
  return cfg.liveMintFirstProbeEnabled;
}

export function liveMintFirstProbeKillDropPct(
  cfg: Pick<LiveOscarConfig, 'liveMintFirstProbeKillDropPct'>,
): number {
  const n = cfg.liveMintFirstProbeKillDropPct;
  return Number.isFinite(n) && n > 0 ? n : 7;
}

export function resolveLiveMintGraduatedPath(raw: string): string {
  const t = raw.trim();
  if (!t) return path.resolve(process.cwd(), 'data/live/live-oscar-mint-graduated.txt');
  return path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
}

let cachedGraduatedAbs = '';
let cachedGraduatedMtime = NaN;
let cachedGraduated = new Set<string>();

export function invalidateLiveMintGraduatedCache(): void {
  cachedGraduatedAbs = '';
  cachedGraduatedMtime = NaN;
  cachedGraduated = new Set();
}

/** @internal Tests */
export function clearLiveMintGraduatedCacheForTests(): void {
  invalidateLiveMintGraduatedCache();
}

function loadGraduatedSet(absPath: string): { set: Set<string>; mtimeMs: number } {
  if (!fs.existsSync(absPath)) return { set: new Set(), mtimeMs: NaN };
  const st = fs.statSync(absPath);
  const body = fs.readFileSync(absPath, 'utf8');
  const out = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const cut = line.split('#')[0]?.trim();
    if (cut) out.add(cut);
  }
  return { set: out, mtimeMs: st.mtimeMs };
}

export function loadLiveMintGraduatedSet(
  cfg: Pick<LiveOscarConfig, 'liveMintGraduatedPath'>,
): Set<string> {
  const abs = resolveLiveMintGraduatedPath(cfg.liveMintGraduatedPath);
  const loaded = loadGraduatedSet(abs);
  if (cachedGraduatedAbs === abs && cachedGraduatedMtime === loaded.mtimeMs) {
    return cachedGraduated;
  }
  cachedGraduated = loaded.set;
  cachedGraduatedAbs = abs;
  cachedGraduatedMtime = loaded.mtimeMs;
  return cachedGraduated;
}

export function isMintLiveOscarGraduated(
  cfg: Pick<LiveOscarConfig, 'liveMintGraduatedPath'>,
  mint: string,
): boolean {
  const key = mint.trim();
  if (!key) return false;
  return loadLiveMintGraduatedSet(cfg).has(key);
}

/** Mint ещё не «выпускался» после прибыльного live-закрытия. */
export function shouldUseLiveMintFirstProbe(
  cfg: LiveOscarConfig,
  mint: string,
): boolean {
  if (!liveMintFirstProbeEnabled(cfg)) return false;
  if (cfg.executionMode !== 'live') return false;
  return !isMintLiveOscarGraduated(cfg, mint);
}

export function markMintLiveOscarGraduated(
  cfg: Pick<LiveOscarConfig, 'liveMintGraduatedPath'>,
  mint: string,
): boolean {
  const key = mint.trim();
  if (!key) return false;
  const set = loadLiveMintGraduatedSet(cfg);
  if (set.has(key)) return false;

  const abs = resolveLiveMintGraduatedPath(cfg.liveMintGraduatedPath);
  const dir = path.dirname(abs);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const line = `${key}  # profitable_close ${stamp}\n`;
  const prefix = fs.existsSync(abs) && fs.statSync(abs).size > 0 ? '\n' : '';
  fs.appendFileSync(abs, `${prefix}${line}`, 'utf8');
  invalidateLiveMintGraduatedCache();
  log.info({ path: abs, mint: key }, 'live mint graduated after profitable close');
  return true;
}

function firstProbeLossDenyTelegramEnabled(): boolean {
  const s = process.env.LIVE_FIRST_MINT_PROBE_DENY_TELEGRAM_ENABLED?.trim();
  if (s === '0' || s === 'false') return false;
  return true;
}

/**
 * После полного закрытия live-oscar, открытого в режиме first-probe.
 */
export function onLiveOscarFirstMintProbeFullClose(args: {
  liveOscarCfg: LiveOscarConfig | undefined;
  strategyId: string;
  mint: string;
  symbol: string;
  netPnlUsd: number;
  liveMintFirstProbe: boolean;
  killDropPct?: number;
}): void {
  const { liveOscarCfg, strategyId, mint, symbol, netPnlUsd, liveMintFirstProbe } = args;
  if (!liveMintFirstProbe || !liveOscarCfg) return;
  if (strategyId !== 'live-oscar' || liveOscarCfg.executionMode !== 'live') return;

  const key = mint.trim();
  if (!key) return;

  if (netPnlUsd > 0) {
    markMintLiveOscarGraduated(liveOscarCfg, key);
    return;
  }

  if (!(netPnlUsd < 0)) return;

  if (!liveOscarCfg.liveFirstMintProbeDenyOnLossEnabled) {
    log.debug({ mint: key, netPnlUsd }, 'live first mint probe deny on loss disabled (stub preserved)');
    return;
  }

  const killPct = args.killDropPct ?? liveMintFirstProbeKillDropPct(liveOscarCfg);
  const sym = symbol?.trim() || '?';
  const added = appendMintToPermanentDenylistLocal(
    liveOscarCfg,
    key,
    `first_mint_probe_loss net=${netPnlUsd.toFixed(2)} kill=${killPct}%`,
    { symbol: sym, skipListChangeTelegram: !firstProbeLossDenyTelegramEnabled() },
  );
  if (!added) {
    log.info({ mint: key }, 'live first mint probe denylist: already listed');
  }
}
