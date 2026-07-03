import type { PaperTraderConfig } from '../config.js';
import {
  evaluateSmartLotteryIntelGate,
  type IntelGateHit,
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

/** Snapshot attached to runner_probe eval decisions (journal + Telegram). */
export type OscarIntelGateSnapshot = {
  mode: OscarIntelMode;
  required: boolean;
  wouldBlock: boolean;
  blocked: boolean;
  swapCovered: boolean;
  reasons: string[];
  hits: IntelGateHit[];
  /** Discovery/runner tier thresholds passed before intel gate fired. */
  tierGatesPassed: boolean;
};

function parseOscarIntelMode(raw: string | undefined): OscarIntelMode | null {
  if (raw === 'shadow' || raw === 'advisory' || raw === 'gate' || raw === 'off') return raw;
  return null;
}

function resolveOscarIntelMode(cfg: PaperTraderConfig): OscarIntelMode {
  if (!cfg.liveOscarIntelEnabled) return 'off';
  return parseOscarIntelMode(cfg.liveOscarIntelMode) ?? 'off';
}

/** Runner_probe lane may override global `LIVE_OSCAR_INTEL_MODE` via `LIVE_OSCAR_INTEL_MODE_RUNNER_PROBE`. */
export function resolveOscarIntelModeForRunnerProbe(cfg: PaperTraderConfig): OscarIntelMode {
  if (!cfg.liveOscarIntelEnabled) return 'off';
  const lane = parseOscarIntelMode(cfg.liveOscarIntelModeRunnerProbe);
  if (lane && lane !== 'off') return lane;
  return resolveOscarIntelMode(cfg);
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
  modeOverride?: OscarIntelMode,
): Promise<OscarIntelGateResult> {
  const mode = modeOverride ?? resolveOscarIntelMode(cfg);
  if (mode === 'off' || !cfg.liveOscarIntelWalletGateEnabled) {
    return {
      ok: true,
      reasons: [],
      swapCovered: true,
      hits: [],
      mode,
      wouldBlock: false,
      blocked: false,
    };
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
        hits: [],
        mode,
        wouldBlock: true,
        blocked: mode === 'gate',
      };
    }
    return {
      ok: true,
      reasons: [],
      swapCovered: false,
      hits: [],
      mode,
      wouldBlock: false,
      blocked: false,
    };
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

/** Runner probe 12–48h: intel required for 12–24h relax band; 24h+ uses standard gate flags. */
export function resolveOscarIntelModeForRunnerLite(cfg: PaperTraderConfig): OscarIntelMode {
  if (!cfg.liveOscarIntelEnabled) return 'off';
  const lane = parseOscarIntelMode(cfg.liveOscarIntelModeRunnerLite);
  if (lane && lane !== 'off') return lane;
  return resolveOscarIntelMode(cfg);
}

/** Runner_lite 12–48h: intel shadow by default; optional gate for 12–24h band. */
export async function evaluateOscarIntelGateForRunnerLite(
  mint: string,
  cfg: PaperTraderConfig,
  ageMin: number,
): Promise<OscarIntelGateResult & { required: boolean }> {
  const age = Number(ageMin);
  const in12hBand = age + 1e-9 >= 720 && age - 1e-9 < 1440;
  const in24hBand =
    age + 1e-9 >= 1440 && age - 1e-9 <= cfg.runnerLiteMaxAgeMin;
  const required =
    (in12hBand && cfg.runnerLite12hIntelRequired) ||
    (in24hBand && cfg.liveOscarIntelWalletGateEnabled);
  const mode = resolveOscarIntelModeForRunnerLite(cfg);
  if (!required) {
    return {
      ok: true,
      reasons: [],
      swapCovered: true,
      hits: [],
      mode,
      wouldBlock: false,
      blocked: false,
      required: false,
    };
  }
  const ig = await evaluateOscarIntelGate(mint, cfg, mode);
  return { ...ig, required: true };
}

/** Runner probe 12–48h: intel required for 12–24h relax band; 24h+ uses standard gate flags. */
export async function evaluateOscarIntelGateForRunnerProbe(
  mint: string,
  cfg: PaperTraderConfig,
  ageMin: number,
): Promise<OscarIntelGateResult & { required: boolean }> {
  const age = Number(ageMin);
  const in12hBand = age + 1e-9 >= 720 && age - 1e-9 < 1440;
  const in24hBand =
    age + 1e-9 >= 1440 && age - 1e-9 <= cfg.runnerProbeMaxAgeMin;
  const required =
    (in12hBand && cfg.runnerProbe12hIntelRequired) ||
    (in24hBand && cfg.liveOscarIntelWalletGateEnabled);
  const mode = resolveOscarIntelModeForRunnerProbe(cfg);
  if (!required) {
    return {
      ok: true,
      reasons: [],
      swapCovered: true,
      hits: [],
      mode,
      wouldBlock: false,
      blocked: false,
      required: false,
    };
  }
  const ig = await evaluateOscarIntelGate(mint, cfg, mode);
  return { ...ig, required: true };
}

/** Prod lane: global `LIVE_OSCAR_INTEL_MODE` when wallet gate enabled. */
export async function evaluateOscarIntelGateForProd(
  mint: string,
  cfg: PaperTraderConfig,
): Promise<OscarIntelGateResult & { required: boolean }> {
  const mode = resolveOscarIntelMode(cfg);
  const required = cfg.liveOscarIntelWalletGateEnabled && mode !== 'off';
  if (!required) {
    return {
      ok: true,
      reasons: [],
      swapCovered: true,
      hits: [],
      mode,
      wouldBlock: false,
      blocked: false,
      required: false,
    };
  }
  const ig = await evaluateOscarIntelGate(mint, cfg, mode);
  return { ...ig, required: true };
}

export function oscarIntelGateSnapshotFromResult(
  ig: OscarIntelGateResult & { required: boolean },
  tierGatesPassed = false,
): OscarIntelGateSnapshot {
  return {
    mode: ig.mode,
    required: ig.required,
    wouldBlock: ig.wouldBlock,
    blocked: ig.blocked,
    swapCovered: ig.swapCovered,
    reasons: ig.reasons,
    hits: ig.hits,
    tierGatesPassed,
  };
}
