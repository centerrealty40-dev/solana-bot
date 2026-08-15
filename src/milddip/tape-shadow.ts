import type { MildDipPriceRing, MildDipPriceSample, MildDipPriceSource } from './price-ring.js';

export type MildDipTapeLane = 'green' | 'dip';

export type MildDipTapeFeatures = {
  last: number | null;
  high60: number | null;
  low60: number | null;
  imp5: number | null;
  imp60: number | null;
  rangePos: number | null;
  dd60: number | null;
  pairAgeHours: number | null;
  currentPriceUsd: number | null;
  source: MildDipPriceSource | null;
};

export type MildDipTapeGates = {
  greenImp60MinPct: number;
  greenImp5MinPct: number;
  greenImp5MaxPct: number;
  greenDd60MaxPct: number;
  greenMinPairAgeHours: number;
  dipRangePosMaxPct: number;
  dipDd60MaxPct: number;
  dipImp5MaxPct: number;
  dipMinPairAgeHours: number;
  dipMaxPairAgeHours: number;
};

export type MildDipTapeEvaluation = {
  features: MildDipTapeFeatures;
  matches: MildDipTapeLane[];
  reasons: Record<MildDipTapeLane, string[]>;
};

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pct(value: number): number {
  return value / 100;
}

const EPSILON = 1e-12;

export function tapeFeatures(
  ring: MildDipPriceRing,
  mint: string,
  nowMs: number,
  pairAgeHours: number | null | undefined,
  current?: MildDipPriceSample,
): MildDipTapeFeatures {
  const lastSample = current ?? ring.lastPrice(mint, nowMs);
  const last = finite(lastSample?.priceUsd);
  const high = ring.maxPrice(mint, 60 * 60_000, nowMs);
  const low = ring.minPrice(mint, 60 * 60_000, nowMs);
  const p5 = ring.priceAtOrBefore(mint, 5 * 60_000, nowMs);
  const p60 = ring.priceAtOrBefore(mint, 60 * 60_000, nowMs);
  const high60 = finite(high?.priceUsd);
  const low60 = finite(low?.priceUsd);
  const imp5 = last != null && p5 && p5.priceUsd > 0 ? last / p5.priceUsd - 1 : null;
  const imp60 = last != null && p60 && p60.priceUsd > 0 ? last / p60.priceUsd - 1 : null;
  const rangePos =
    last != null && high60 != null && low60 != null && high60 > low60
      ? (last - low60) / (high60 - low60)
      : null;
  const dd60 = last != null && high60 != null && high60 > 0 ? last / high60 - 1 : null;
  return {
    last,
    high60,
    low60,
    imp5,
    imp60,
    rangePos,
    dd60,
    pairAgeHours: finite(pairAgeHours),
    currentPriceUsd: last,
    source: lastSample?.source ?? null,
  };
}

export function evaluateMildDipTape(
  features: MildDipTapeFeatures,
  gates: MildDipTapeGates,
): MildDipTapeEvaluation {
  const greenReasons: string[] = [];
  const dipReasons: string[] = [];
  const age = features.pairAgeHours;
  if (features.imp60 == null || features.imp60 <= pct(gates.greenImp60MinPct) + EPSILON) {
    greenReasons.push(`imp60=${features.imp60 == null ? 'null' : features.imp60}`);
  }
  if (features.imp5 == null || features.imp5 + EPSILON < pct(gates.greenImp5MinPct)) {
    greenReasons.push(`green_imp5_min=${features.imp5 == null ? 'null' : features.imp5}`);
  }
  if (features.imp5 == null || features.imp5 - EPSILON > pct(gates.greenImp5MaxPct)) {
    greenReasons.push(`green_imp5_max=${features.imp5 == null ? 'null' : features.imp5}`);
  }
  if (features.dd60 == null || features.dd60 - EPSILON > pct(gates.greenDd60MaxPct)) {
    greenReasons.push(`green_dd60=${features.dd60 == null ? 'null' : features.dd60}`);
  }
  if (age == null || age < gates.greenMinPairAgeHours) {
    greenReasons.push(`green_age=${age ?? 'null'}`);
  }

  if (
    features.rangePos == null ||
    features.rangePos + EPSILON >= pct(gates.dipRangePosMaxPct)
  ) {
    dipReasons.push(`rangePos=${features.rangePos == null ? 'null' : features.rangePos}`);
  }
  if (features.dd60 == null || features.dd60 - EPSILON > pct(gates.dipDd60MaxPct)) {
    dipReasons.push(`dip_dd60=${features.dd60 == null ? 'null' : features.dd60}`);
  }
  if (features.imp5 == null || features.imp5 - EPSILON > pct(gates.dipImp5MaxPct)) {
    dipReasons.push(`dip_imp5=${features.imp5 == null ? 'null' : features.imp5}`);
  }
  if (age == null || age < gates.dipMinPairAgeHours || age > gates.dipMaxPairAgeHours) {
    dipReasons.push(`dip_age=${age ?? 'null'}`);
  }

  const reasons = { green: greenReasons, dip: dipReasons };
  return {
    features,
    matches: [
      ...(greenReasons.length === 0 ? (['green'] as const) : []),
      ...(dipReasons.length === 0 ? (['dip'] as const) : []),
    ],
    reasons,
  };
}

export type MildDipTapeShadowEvent = Record<string, unknown>;

export type MildDipTapeShadowOptions = {
  ring: MildDipPriceRing;
  gates: MildDipTapeGates;
  minIntervalMs: number;
  maxSignalsPerHour: number;
  append: (event: MildDipTapeShadowEvent) => void;
};

type PendingSignal = {
  id: string;
  lane: MildDipTapeLane;
  mint: string;
  signalTsMs: number;
  signalPriceUsd: number;
  maxPriceUsd: number;
  minPriceUsd: number;
  emitted: Set<number>;
};

const HORIZONS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;

export class MildDipTapeShadow {
  private readonly opts: MildDipTapeShadowOptions;
  private readonly lastSignalAt = new Map<string, number>();
  private readonly signalTimes: number[] = [];
  private readonly pending: PendingSignal[] = [];
  private sequence = 0;

  constructor(opts: MildDipTapeShadowOptions) {
    this.opts = opts;
  }

  onPriceSample(input: {
    mint: string;
    priceUsd: number;
    tsMs: number;
    source?: MildDipPriceSource;
    pairAgeHours?: number | null;
  }): void {
    const source = input.source ?? 'stream';
    const sample: MildDipPriceSample = {
      tsMs: input.tsMs,
      priceUsd: input.priceUsd,
      source,
    };
    this.opts.ring.note(input.mint, input.priceUsd, { tsMs: input.tsMs, source });
    this.advanceOutcomes(input.mint, sample);

    const evaluation = evaluateMildDipTape(
      tapeFeatures(this.opts.ring, input.mint, input.tsMs, input.pairAgeHours, sample),
      this.opts.gates,
    );
    if (evaluation.matches.length === 0) return;
    this.pruneSignalTimes(input.tsMs);
    const last = this.lastSignalAt.get(input.mint) ?? 0;
    if (input.tsMs - last < this.opts.minIntervalMs) return;
    if (this.signalTimes.length >= this.opts.maxSignalsPerHour) return;
    this.lastSignalAt.set(input.mint, input.tsMs);
    this.signalTimes.push(input.tsMs);

    for (const lane of evaluation.matches) {
      const id = `${input.mint}:${input.tsMs}:${lane}:${this.sequence++}`;
      this.opts.append({
        kind: 'mild_dip_tape_lane_signal',
        signalId: id,
        lane,
        mint: input.mint,
        ...evaluation.features,
        pairAgeHours: evaluation.features.pairAgeHours,
        currentPriceUsd: input.priceUsd,
        source,
        shadowOnly: true,
      });
      this.pending.push({
        id,
        lane,
        mint: input.mint,
        signalTsMs: input.tsMs,
        signalPriceUsd: input.priceUsd,
        maxPriceUsd: input.priceUsd,
        minPriceUsd: input.priceUsd,
        emitted: new Set(),
      });
    }
  }

  private advanceOutcomes(mint: string, sample: MildDipPriceSample): void {
    for (const signal of this.pending) {
      if (signal.mint !== mint || sample.tsMs < signal.signalTsMs) continue;
      signal.maxPriceUsd = Math.max(signal.maxPriceUsd, sample.priceUsd);
      signal.minPriceUsd = Math.min(signal.minPriceUsd, sample.priceUsd);
      for (const horizonMs of HORIZONS_MS) {
        if (signal.emitted.has(horizonMs) || sample.tsMs - signal.signalTsMs < horizonMs) continue;
        signal.emitted.add(horizonMs);
        this.opts.append({
          kind: 'mild_dip_tape_lane_outcome',
          signalId: signal.id,
          lane: signal.lane,
          mint: signal.mint,
          signalTsMs: signal.signalTsMs,
          horizonMs,
          horizonMinutes: horizonMs / 60_000,
          signalPriceUsd: signal.signalPriceUsd,
          priceAtHorizonUsd: sample.priceUsd,
          maxPriceUsd: signal.maxPriceUsd,
          minPriceUsd: signal.minPriceUsd,
          shadowOnly: true,
        });
      }
    }
    while (this.pending.length > 0 && this.pending[0]!.emitted.size === HORIZONS_MS.length) {
      this.pending.shift();
    }
  }

  private pruneSignalTimes(nowMs: number): void {
    const cut = nowMs - 60 * 60_000;
    while (this.signalTimes.length > 0 && this.signalTimes[0]! <= cut) this.signalTimes.shift();
  }
}

export const DEFAULT_MILD_DIP_TAPE_GATES: MildDipTapeGates = {
  greenImp60MinPct: 0,
  greenImp5MinPct: 4,
  greenImp5MaxPct: 40,
  greenDd60MaxPct: -5,
  greenMinPairAgeHours: 1,
  dipRangePosMaxPct: 20,
  dipDd60MaxPct: -40,
  dipImp5MaxPct: -15,
  dipMinPairAgeHours: 0.5,
  dipMaxPairAgeHours: 24,
};
