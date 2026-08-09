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
import {
  bumpProcessStart,
  mildDipRuntimeMetrics,
} from '../milddip/runtime-metrics.js';
import { startOpsHeartbeat, writeOpsFatal } from '../core/ops-heartbeat.js';
import { refreshSolPrice } from '../papertrader/pricing.js';
import {
  bootstrapVolGreenEnv,
  VOL_GREEN_DEFAULT_WALLET_PUBKEY,
} from '../volgreen/bootstrap-env.js';

bootstrapVolGreenEnv();
bumpProcessStart();
void refreshSolPrice().then((ok) => {
  console.log(`[vol-green-bot] solUsd refresh=${ok ? 1 : 0}`);
});

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
  if (cfg.entryMode !== 'green_tape' && cfg.entryMode !== 'awakening') {
    console.warn(
      `[${appName()}] entryMode=${cfg.entryMode} (expected green_tape|awakening) — continuing`,
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
      const m = mildDipRuntimeMetrics();
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
        // SPEC reconnect RCA — do not treat every ws open as Helius reconnect.
        ws_close_1006_count: m.wsClose1006Count,
        ws_close_other_count: m.wsCloseOtherCount,
        ws_reconnect_backoff_count: m.wsReconnectBackoffCount,
        ws_open_count: m.wsOpenCount,
        process_start_count: m.processStartCount,
        enrich_over_budget_count: m.enrichOverBudgetCount,
        tick_error_count: m.tickErrorCount,
        tick_errors_by_code: m.tickErrorsByCode,
        last_ws_close_code: m.lastWsCloseCode,
        last_tick_error_code: m.lastTickErrorCode,
      };
    },
  });

  let rpcHost = 'rpc';
  try {
    rpcHost = new URL(cfg.rpcUrl).host;
  } catch {
    /* ignore */
  }
  const triple = cfg.greenTape.tripleGreenOnly
    ? `triple_green small=(${cfg.greenTape.tripleSmallMinPc},${cfg.greenTape.tripleSmallMaxPc}] ` +
      `huge>=${cfg.greenTape.tripleHugeMinPc} age>=${cfg.greenTape.minPairAgeHours}h`
    : 'legacy_or_paths';
  const leaders = (process.env.VOL_GREEN_LEADER_WATCH ?? '').trim();
  console.log(
    `[${appName()}] start mode=${cfg.executionMode} entry=${cfg.entryMode} ${triple} ` +
      `streamImpulseOnly=${cfg.streamImpulseOnly ? 1 : 0} enrich=${cfg.streamImpulseOnly ? 0 : 1} ` +
      `sources=${cfg.discoverSources} stream=${cfg.streamEnabled ? 1 : 0} ` +
      `resolve=${cfg.buyMintResolveMaxPerMin}/min leaderWatch=${leaders || '0'} ` +
      `positionUsd=${cfg.positionUsd} wallet=${cfg.walletPubkeyExpected ?? '?'} ` +
      `rpcHost=${rpcHost}`,
  );

  await runMildDipLoop(cfg);
}

main().catch((err) => fatalExit(err, 'main'));
