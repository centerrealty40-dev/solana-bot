/**
 * Shared ensure/start helpers for strategy PM2 apps.
 * Used by strategy-process-watch (in-PM2) and strategy-keepalive-cron (outside PM2).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 1.11.685 — Oscar trading = mild-dip only (8zkg twins retired). */
export const STRATEGY_KEEPALIVE_APPS = [
  'mild-dip-bot',
  'strategy-process-watch',
];

/**
 * @param {string} root
 * @param {typeof execSync} [execSyncFn]
 * @returns {Map<string, string>}
 */
export function getPm2StatusMap(root, execSyncFn = execSync) {
  try {
    const out = execSyncFn('pm2 jlist', {
      encoding: 'utf8',
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(out);
    const map = new Map();
    for (const app of apps) map.set(app.name, app?.pm2_env?.status ?? 'unknown');
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Restart if stopped/errored; start from ecosystem if missing.
 * @param {{ root: string, pm2Name: string, status: string, execSyncFn?: typeof execSync }} input
 */
export function ensurePm2App(input) {
  const execSyncFn = input.execSyncFn ?? execSync;
  const status = input.status || 'missing';
  const eco = path.join(input.root, 'ecosystem.config.cjs');
  if (status === 'online') return { action: 'none', ok: true };
  if (status === 'stopped' || status === 'errored' || status === 'stopping') {
    try {
      execSyncFn(`pm2 restart ${input.pm2Name}`, {
        cwd: input.root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { action: 'restart', ok: true };
    } catch (e) {
      // fall through to start
      void e;
    }
  }
  if (!fs.existsSync(eco)) {
    return { action: 'failed', ok: false, error: 'ecosystem.config.cjs missing' };
  }
  try {
    execSyncFn(`pm2 start ecosystem.config.cjs --only ${input.pm2Name} --update-env`, {
      cwd: input.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { action: 'start', ok: true };
  } catch (e) {
    return {
      action: 'failed',
      ok: false,
      error: String(e?.message || e).slice(0, 200),
    };
  }
}

/**
 * @param {{ root: string, appNames?: string[], execSyncFn?: typeof execSync }} input
 */
export function ensureStrategyApps(input) {
  const names = input.appNames?.length ? input.appNames : STRATEGY_KEEPALIVE_APPS;
  const statusMap = getPm2StatusMap(input.root, input.execSyncFn);
  const results = [];
  for (const name of names) {
    const status = statusMap.get(name) ?? 'missing';
    const ensured = ensurePm2App({
      root: input.root,
      pm2Name: name,
      status,
      execSyncFn: input.execSyncFn,
    });
    results.push({ name, prevStatus: status, ...ensured });
  }
  return results;
}
