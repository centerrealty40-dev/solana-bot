/**
 * Mild-dip test bot — DexScreener pc5m ∈ (−20, 0], USDC clip, TP / time-stop exit.
 *
 *   npm run mild-dip-bot
 *
 * Env: MILD_DIP_* (see ecosystem.config.cjs / .env.example).
 */
import { loadMildDipConfig } from '../milddip/config.js';
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
  startOpsHeartbeat({
    appName: appName(),
    stats: () => {
      const s = mildDipLoopStats();
      return {
        mode: cfg.executionMode,
        open: s?.open ?? 0,
        lastScanAtMs: s?.lastScanAtMs ?? null,
        lastMarkAtMs: s?.lastMarkAtMs ?? null,
        positionUsd: cfg.positionUsd,
        wallet: cfg.walletPubkeyExpected ?? null,
      };
    },
  });
  await runMildDipLoop(cfg);
}

main().catch((err) => fatalExit(err, 'fatal'));
