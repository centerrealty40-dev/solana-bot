/**
 * vol-green-bot — Volume Awakening / green-tape ENTRY + mild-dip EXIT/manage.
 *
 * Wallet (default): FxQfFTmj… (copy-8zkg keypair)
 * Host (intended): LERA VPS with Helius RPC — isolated from Oscar mild-dip on 2sSu…
 *
 *   npm run vol-green-bot
 *
 * Env: VOL_GREEN_* (aliases) or MILD_DIP_* after bootstrap; see bootstrap-env.ts.
 */
import path from 'node:path';
import { loadMildDipConfig } from '../milddip/config.js';
import { tryAcquireMildDipInstanceLock } from '../milddip/instance-lock.js';
import { mildDipLoopStats, runMildDipLoop } from '../milddip/loop.js';
import { startOpsHeartbeat, writeOpsFatal } from '../core/ops-heartbeat.js';
import {
  bootstrapVolGreenEnv,
  VOL_GREEN_DEFAULT_WALLET_PUBKEY,
} from '../volgreen/bootstrap-env.js';

bootstrapVolGreenEnv();

function appName(): string {
  const raw = process.env.MILD_DIP_APP_NAME?.trim() || process.env.VOL_GREEN_APP_NAME?.trim();
  return raw && /^[a-z0-9._-]{1,64}$/i.test(raw) ? raw : 'vol-green-bot';
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
  if (cfg.entryMode !== 'awakening') {
    console.warn(
      `[${appName()}] entryMode=${cfg.entryMode} (expected awakening) — continuing with configured mode`,
    );
  }

  const lockPath =
    process.env.VOL_GREEN_INSTANCE_LOCK_PATH?.trim() ||
    process.env.MILD_DIP_INSTANCE_LOCK_PATH?.trim() ||
    path.join(path.dirname(cfg.statePath), 'vol-green-bot.lock');
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
        entryMode: cfg.entryMode,
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
        wallet: cfg.walletPubkeyExpected ?? VOL_GREEN_DEFAULT_WALLET_PUBKEY,
        instanceLock: lock.lockPath,
      };
    },
  });

  console.log(
    `[${appName()}] start mode=${cfg.executionMode} entry=${cfg.entryMode} ` +
      `positionUsd=${cfg.positionUsd} wallet=${cfg.walletPubkeyExpected ?? '?'} ` +
      `rpc=${cfg.rpcUrl.slice(0, 48)}…`,
  );

  await runMildDipLoop(cfg);
}

main().catch((err) => fatalExit(err, 'main'));
