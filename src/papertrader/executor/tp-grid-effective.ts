import type { PaperTraderConfig } from '../config.js';
import type { OpenTrade } from '../types.js';
import { isPaperOscarIdealizedStackStrategyId } from '../paper-oscar-v21.js';
import { isVariantAHybridExitPolicy } from './exit-policy-variant-a.js';
import { isWaveBExitPolicy, waveBTpGridProfileFor } from './exit-policy-wave-b.js';

export interface TpGridEffective {
  stepPnl: number;
  sellFraction: number;
  /**
   * 1.11.167: упорядоченный профиль `sellFraction` по ступеням (1-based индекс).
   * Когда непустой — `sellFractionForStep(k)` возвращает `profile[min(k-1, len-1)]`,
   * иначе плоский `sellFraction`. Пустой массив → fallback на `sellFraction`.
   */
  sellFractionByStep: number[];
  /** Возвращает `sellFraction` для k-й ступени (k≥1). Универсальный helper. */
  sellFractionForStep: (kOneBased: number) => number;
  maxRungs: number | undefined;
  firstRungRetraceMinPnlPct: number;
}

/**
 * Per-open overrides for TP grid (regime fork). When `tpGridOverrides` is absent, uses global `cfg`.
 */
export function tpGridEffective(ot: OpenTrade, cfg: PaperTraderConfig): TpGridEffective {
  const o = ot.tpGridOverrides;
  /**
   * Режим B live — параметры сетки только из cfg (effCfg), без legacy tp-regime overrides на открытии.
   * Исключение: политика выхода зафиксирована на сделке (`liveExitPolicyId`) — всегда читаем `tpGridOverrides`.
   */
  const exitPolicyPinned =
    ot.liveExitPolicyId === 'legacy_grid' ||
    ot.liveExitPolicyId === 'wave_b_v1' ||
    ot.liveExitPolicyId === 'variant_a_v1' ||
    ot.liveExitPolicyId === 'variant_a_v2';
  const ignoreOverrides =
    cfg.liveExitModeAbEnabled === true && ot.liveExitProfileMode === 'B' && !exitPolicyPinned;
  const paperIdealizedUnlimitedB =
    isPaperOscarIdealizedStackStrategyId(cfg.strategyId) && ot.liveExitProfileMode === 'B';
  /** §5.4 `IDEALIZED_OSCAR_STACK_SPEC_V2` — лестница B без верхней крышки (prod был maxRungs=4). */
  const liveOscarUnlimitedB = cfg.strategyId === 'live-oscar' && ot.liveExitProfileMode === 'B';
  const variantAHybridUnlimited =
    cfg.strategyId === 'live-oscar' && isVariantAHybridExitPolicy(ot);
  const unlimitedBGrid = paperIdealizedUnlimitedB || liveOscarUnlimitedB || variantAHybridUnlimited;
  const flatSellFraction = Math.min(
    1,
    ignoreOverrides ? cfg.tpGridSellFraction : (o?.gridSellFraction ?? cfg.tpGridSellFraction),
  );
  /**
   * Wave B (1.11.228): grid profile is selected at runtime from the live `legs` state, so
   * stored `tpGridOverrides` from earlier code versions never override the averaging-aware fork.
   * - Both branches: +2.5% steps, escalating sell (5%/10%/15%/… of remainder per rung).
   */
  const waveBProfile = isWaveBExitPolicy(ot) ? waveBTpGridProfileFor(ot) : null;
  /** Profile из cfg; per-open override `gridSellFractionByStep` поддерживается опционально. */
  const profileSrc: readonly number[] =
    waveBProfile != null
      ? waveBProfile.gridSellFractionByStep
      : !ignoreOverrides &&
          Array.isArray(o?.gridSellFractionByStep) &&
          o!.gridSellFractionByStep!.length > 0
        ? o!.gridSellFractionByStep!
        : (cfg.tpGridSellFractionByStep ?? []);
  const sellFractionByStep: number[] = profileSrc.map((x: number) => Math.min(1, Math.max(0, x)));
  return {
    stepPnl:
      waveBProfile != null
        ? waveBProfile.gridStepPnl
        : ignoreOverrides
          ? cfg.tpGridStepPnl
          : (o?.gridStepPnl ?? cfg.tpGridStepPnl),
    sellFraction: flatSellFraction,
    sellFractionByStep,
    sellFractionForStep: (kOneBased: number): number => {
      if (sellFractionByStep.length === 0) return flatSellFraction;
      const idx = Math.max(1, Math.floor(kOneBased)) - 1;
      const clamped = Math.min(idx, sellFractionByStep.length - 1);
      return sellFractionByStep[clamped] ?? flatSellFraction;
    },
    maxRungs: unlimitedBGrid
      ? undefined
      : ignoreOverrides
        ? cfg.tpGridMaxRungs
        : (o?.gridMaxRungs ?? cfg.tpGridMaxRungs),
    firstRungRetraceMinPnlPct:
      waveBProfile != null
        ? waveBProfile.gridFirstRungRetraceMinPnlPct
        : ignoreOverrides
          ? cfg.tpGridFirstRungRetraceMinPnlPct
          : (o?.gridFirstRungRetraceMinPnlPct ?? cfg.tpGridFirstRungRetraceMinPnlPct),
  };
}

/** DCA killstop for exit/DCA gating: regime override on the open trade, else global config. */
export function dcaKillstopEffective(ot: OpenTrade, cfg: PaperTraderConfig): number {
  const o = ot.tpGridOverrides?.dcaKillstop;
  if (typeof o === 'number' && o < 0) return o;
  return cfg.dcaKillstop;
}
