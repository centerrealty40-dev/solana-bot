/**
 * Preset C discovery bridge — isolated from main live-oscar `runDipDiscovery`.
 */
import type { PaperTraderConfig } from '../papertrader/config.js';
import {
  appendPostExitReentryGateReasons,
  type DiscoveryTickResult,
  type EvalDecision,
  lastEntryTsByMintMap,
} from '../papertrader/discovery/dip-clones.js';
import { isMintBlacklisted } from '../papertrader/discovery/mint-blacklist-file.js';
import { shouldEvaluateMint } from '../papertrader/discovery/discovery-eval-throttle.js';
import {
  resolveLiveOscarMcapTier,
  type LiveOscarTradeTier,
} from '../papertrader/live-oscar-mcap-tier.js';
import { resolveLiveOscarScalpWaveMcapTier } from '../papertrader/live-oscar-scalp-wave.js';
import type { SnapshotFeatures } from '../papertrader/types.js';
import { evaluatePresetCCandidates, type PresetCPullbackCandidate } from './pullback-scan.js';
import { isPresetCMcapKnown, presetCFilterReasons } from './filters.js';
import { isLiveOscarPresetCStrategyId } from './live-oscar-family.js';
import { presetCTelegramGateReasons } from './telegram-gate.js';

const MINT_COOLDOWN_MS = Math.max(
  0,
  Math.floor(Number(process.env.PRESET_C_DISCOVERY_MINT_COOLDOWN_MS ?? 1_800_000)),
);

/** Map mcap → Live Oscar phase (micro / low / scalp_wave / prod); exit stays wave B on prod lane. */
function resolvePresetCPhaseTier(
  cfg: PaperTraderConfig,
  mcapUsd: number,
): LiveOscarTradeTier | undefined {
  if (!isPresetCMcapKnown(mcapUsd)) return 'low';
  if (resolveLiveOscarScalpWaveMcapTier(cfg, mcapUsd) === 'scalp_wave') {
    return 'scalp_wave';
  }
  const t = resolveLiveOscarMcapTier(cfg, mcapUsd);
  if (t === 'micro' || t === 'low' || t === 'prod' || t === 'scalp_wave') return t;
  return undefined;
}

function candidateToFeatures(c: PresetCPullbackCandidate): SnapshotFeatures {
  return {
    price_usd: +c.priceUsd.toFixed(8),
    snapshot_ts_ms: c.pick.lastTs.getTime(),
    liq_usd: +c.liqUsd.toFixed(0),
    pair_address: c.pair,
    vol5m_usd: 0,
    vol1h_usd: 0,
    buys5m: 0,
    sells5m: 0,
    buy_sell_ratio_5m: null,
    holders: c.holderCount ?? 0,
    token_age_min: +c.tokenAgeMin.toFixed(1),
    dip_pct: -c.pick.retraceFromPeakPct,
    impulse_pct: +c.pick.risePct.toFixed(2),
    dip_lookback_min: null,
    market_cap_usd: +c.refMcapUsd.toFixed(2),
  };
}

function buildDecision(
  cfg: PaperTraderConfig,
  c: PresetCPullbackCandidate,
  pass: boolean,
  reasons: string[],
): EvalDecision {
  const tier = resolvePresetCPhaseTier(cfg, c.refMcapUsd);
  return {
    lane: 'post_migration',
    source: c.dex,
    mint: c.mint,
    symbol: c.symbol,
    ageMin: c.tokenAgeMin,
    pass,
    reasons,
    features: candidateToFeatures(c),
    whale: null,
    entryPath: 'preset_c_pullback',
    ...(tier ? { liveOscarMcapTier: tier } : {}),
    liveOscarTradeLane: 'prod',
  };
}

/** Exported for tests — filter one PG pullback row through Preset C gates. */
export function evaluatePresetCCandidate(
  cfg: PaperTraderConfig,
  c: PresetCPullbackCandidate,
  nowMs = Date.now(),
): EvalDecision {
  const geom = presetCFilterReasons({
    refMcapUsd: c.refMcapUsd,
    retraceFromPeakPct: c.pick.retraceFromPeakPct,
  });
  const reasons = [...geom];

  if (geom.length > 0) {
    return buildDecision(cfg, c, false, reasons);
  }

  if (cfg.mintBlacklistEnabled && cfg.mintBlacklistPath?.trim()) {
    if (isMintBlacklisted(cfg.mintBlacklistPath.trim(), c.mint)) {
      reasons.push('mint_blacklist');
    }
  }

  const lastEntry = lastEntryTsByMintMap.get(c.mint) ?? 0;
  if (MINT_COOLDOWN_MS > 0 && lastEntry > 0 && nowMs - lastEntry < MINT_COOLDOWN_MS) {
    reasons.push(`preset_c_mint_cooldown_${((MINT_COOLDOWN_MS - (nowMs - lastEntry)) / 60_000).toFixed(0)}m`);
  }

  appendPostExitReentryGateReasons(cfg, c.mint, c.priceUsd, reasons);

  reasons.push(...presetCTelegramGateReasons(c.mint, nowMs));

  const tier = resolvePresetCPhaseTier(cfg, c.refMcapUsd);
  if (!tier) {
    reasons.push('preset_c_mcap_tier_below');
  }

  return buildDecision(cfg, c, reasons.length === 0, reasons);
}

export async function runPresetCDiscovery(cfg: PaperTraderConfig): Promise<DiscoveryTickResult> {
  if (!isLiveOscarPresetCStrategyId(cfg.strategyId)) {
    return { discovered: 0, evaluated: 0, passed: 0, decisions: [] };
  }

  const raw = await evaluatePresetCCandidates();
  const decisions: EvalDecision[] = [];
  let evaluated = 0;
  let passed = 0;

  for (const c of raw) {
    if (!shouldEvaluateMint(c.mint, cfg.discoveryReevalSec ?? 30)) continue;
    evaluated++;
    const d = evaluatePresetCCandidate(cfg, c);
    decisions.push(d);
    if (d.pass) passed++;
  }

  return {
    discovered: raw.length,
    evaluated,
    passed,
    decisions,
    priorityMintSet: new Set(decisions.map((d) => d.mint)),
  };
}
