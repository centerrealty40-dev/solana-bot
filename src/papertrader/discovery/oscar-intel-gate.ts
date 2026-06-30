import type { PaperTraderConfig } from '../config.js';
import {
  evaluateSmartLotteryIntelGate,
  type SmartLotteryIntelResult,
} from './smart-lottery-intel.js';

export type OscarIntelMode = 'off' | 'shadow' | 'advisory' | 'gate';

export type OscarIntelGateResult = SmartLotteryIntelResult & {
  mode: OscarIntelMode;
  /** True when gate mode would block (or did block). */
  wouldBlock: boolean;
  /** Hard block applied this eval (gate mode only). */
  blocked: boolean;
};

function resolveOscarIntelMode(cfg: PaperTraderConfig): OscarIntelMode {
  if (!cfg.liveOscarIntelEnabled) return 'off';
  const m = cfg.liveOscarIntelMode;
  if (m === 'shadow' || m === 'advisory' || m === 'gate') return m;
  return 'off';
}

/** Map Oscar intel env → smart-lottery gate cfg slice (read-only overlay). */
function oscarIntelCfgSlice(cfg: PaperTraderConfig): PaperTraderConfig {
  return {
    ...cfg,
    smlotIntelGateEnabled: cfg.liveOscarIntelWalletGateEnabled,
    smlotEarlyBuyWindowSec: cfg.liveOscarIntelEarlyBuyWindowSec,
    smlotEarlyBuyWalletCap: cfg.liveOscarIntelEarlyBuyWalletCap,
    smlotRequireEarlySwapCoverage: cfg.liveOscarIntelRequireSwapCoverage,
    smlotBlockIntelBlockTrade: cfg.liveOscarIntelBlockIntelBlockTrade,
    smlotBlockBadTags: cfg.liveOscarIntelBlockBadTags,
    smlotBlockClusteredWallets: cfg.liveOscarIntelBlockClusteredWallets,
    smlotBlockScamFarmMeta: cfg.liveOscarIntelBlockScamFarmMeta,
  };
}

/**
 * Wallet-intel mint gate for Live Oscar / runner_probe (port of `evaluateSmartLotteryIntelGate`).
 * Shadow/advisory never block; gate hard-blocks on BLOCK_TRADE / scam tags / clusters.
 */
export async function evaluateOscarIntelGate(
  mint: string,
  cfg: PaperTraderConfig,
): Promise<OscarIntelGateResult> {
  const mode = resolveOscarIntelMode(cfg);
  if (mode === 'off' || !cfg.liveOscarIntelWalletGateEnabled) {
    return { ok: true, reasons: [], swapCovered: true, mode, wouldBlock: false, blocked: false };
  }

  let core: SmartLotteryIntelResult;
  try {
    core = await evaluateSmartLotteryIntelGate(mint, oscarIntelCfgSlice(cfg));
  } catch {
    if (cfg.liveOscarIntelFailClosed) {
      return {
        ok: false,
        reasons: ['intel_pg_error'],
        swapCovered: false,
        mode,
        wouldBlock: true,
        blocked: mode === 'gate',
      };
    }
    return { ok: true, reasons: [], swapCovered: false, mode, wouldBlock: false, blocked: false };
  }

  const wouldBlock = !core.ok;
  const blocked = mode === 'gate' && wouldBlock;
  return {
    ...core,
    ok: blocked ? false : core.ok,
    mode,
    wouldBlock,
    blocked,
  };
}

/** Runner probe 12–36h: intel required for 12–24h relax band; 24–36h uses standard gate flags. */
export async function evaluateOscarIntelGateForRunnerProbe(
  mint: string,
  cfg: PaperTraderConfig,
  ageMin: number,
): Promise<OscarIntelGateResult & { required: boolean }> {
  const age = Number(ageMin);
  const in12hBand = age + 1e-9 >= 720 && age - 1e-9 < 1440;
  const in24hBand = age + 1e-9 >= 1440 && age - 1e-9 <= 2160;
  const required =
    (in12hBand && cfg.runnerProbe12hIntelRequired) ||
    (in24hBand && cfg.liveOscarIntelWalletGateEnabled);
  if (!required) {
    return {
      ok: true,
      reasons: [],
      swapCovered: true,
      mode: resolveOscarIntelMode(cfg),
      wouldBlock: false,
      blocked: false,
      required: false,
    };
  }
  const ig = await evaluateOscarIntelGate(mint, cfg);
  return { ...ig, required: true };
}
