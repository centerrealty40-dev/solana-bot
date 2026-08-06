/**
 * Mild-dip test bot — DexScreener pc5m ∈ (−20, 0], USDC clip,
 * W9.1 peak-giveback exit (arm MFE / giveback from peak).
 *
 *   npm run mild-dip-bot
 *
 * Env: MILD_DIP_* (see ecosystem.config.cjs / .env.example).
 */
import path from 'node:path';
import { loadMildDipConfig } from '../milddip/config.js';
import { tryAcquireMildDipInstanceLock } from '../milddip/instance-lock.js';
import { mildDipLoopStats, runMildDipLoop } from '../milddip/loop.js';
import { startOpsHeartbeat, writeOpsFatal } from '../core/ops-heartbeat.js';

function appName(): string {
  const raw = process.env.MILD_DIP_APP_NAME?.trim();
  return raw && /^[a-z0-9._-]{1,64}$/i.test(raw) ? raw : 'mild-dip-bot';
}

function fatalExit(err: unknown, source: string): never {
  writeOpsFatal(appName(), source, err);
  console.error(`[${appName()}] ${source}`, err);
  process.exit(1);
}

process.on('uncaughtException', (err) => fatalExit(err, 'uncaughtException'));
process.on('unhandledRejection', (err) => fatalExit(err, 'unhandledRejection'));

async function main(): Promise<void> {
  const cfg = loadMildDipConfig();
  const lockPath =
    process.env.MILD_DIP_INSTANCE_LOCK_PATH?.trim() ||
    path.join(path.dirname(cfg.statePath), 'mild-dip-bot.lock');
  const lock = tryAcquireMildDipInstanceLock(lockPath);
  if (!lock) {
    console.error(
      `[${appName()}] another live instance holds ${lockPath} — exit to prevent double-buys`,
    );
    process.exit(2);
  }
  const releaseLock = (): void => {
    try {
      lock.release();
    } catch {
      /* ignore */
    }
  };
  process.on('exit', releaseLock);
  process.on('SIGINT', () => {
    releaseLock();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    releaseLock();
    process.exit(143);
  });

  startOpsHeartbeat({
    appName: appName(),
    stats: () => {
      const s = mildDipLoopStats();
      return {
        mode: cfg.executionMode,
        open: s?.open ?? 0,
        lastScanAtMs: s?.lastScanAtMs ?? null,
        lastMarkAtMs: s?.lastMarkAtMs ?? null,
        lastMarkPassMs: s?.lastMarkPassMs ?? null,
        lastMarkedOk: s?.lastMarkedOk ?? null,
        lastMarkedNull: s?.lastMarkedNull ?? null,
        markCacheTtlMs: cfg.markCacheTtlMs,
        markIntervalMs: cfg.markIntervalMs,
        scanIntervalMs: cfg.scanIntervalMs,
        hotMints: s?.hotMints ?? 0,
        stream: s?.stream ?? false,
        positionUsd: cfg.positionUsd,
        wallet: cfg.walletPubkeyExpected ?? null,
        instanceLock: lock.lockPath,
      };
    },
  });
  await runMildDipLoop(cfg);
}

main().catch((err) => fatalExit(err, 'fatal'));
