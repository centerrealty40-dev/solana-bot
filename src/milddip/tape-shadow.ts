import fs from 'node:fs';
import path from 'node:path';
import {
  mildDipPairAgeRegistry,
  type MildDipPairAgeAttemptState,
  type MildDipPairAgeRegistry,
  type MildDipPairAgeRegistryState,
} from './pair-age-registry.js';
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
  spanMs: number;
  sampleCount: number;
  firstSampleTsMs: number | null;
  window60SpanMs: number;
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
  const observed = ring.windowStats(mint, 90 * 60_000, nowMs);
  const window60 = ring.windowStats(mint, 60 * 60_000, nowMs);
  const p5 = ring.priceAtOrBefore(mint, 5 * 60_000, nowMs);
  const p60 = ring.priceAtOrBefore(mint, 60 * 60_000, nowMs);
  const has60m = p60 != null;
  const high = has60m ? ring.maxPrice(mint, 60 * 60_000, nowMs) : null;
  const low = has60m ? ring.minPrice(mint, 60 * 60_000, nowMs) : null;
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
    spanMs: observed.spanMs,
    sampleCount: observed.sampleCount,
    firstSampleTsMs: observed.firstSampleTsMs,
    window60SpanMs: window60.spanMs,
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

export function tapePairAgeBackfillDue(
  lastRunMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  return lastRunMs <= 0 || nowMs - lastRunMs >= Math.max(0, intervalMs);
}

export type MildDipTapeShadowOptions = {
  ring: MildDipPriceRing;
  pairAgeRegistry?: MildDipPairAgeRegistry;
  pairAgeMaxStaleMs?: number;
  pairAgeMaxEntries?: number;
  gates: MildDipTapeGates;
  minIntervalMs: number;
  maxSignalsPerHour: number;
  outcomeStaleMs?: number;
  idleEvictMs?: number;
  summaryIntervalMs?: number;
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

type TapeLaneCounters = {
  conditions: number;
  recorded: number;
  suppressedCap: number;
  suppressedInterval: number;
  pairAgeKnown: number;
  pairAgeUnknown: number;
  rejectionReasons: Record<string, number>;
};

function rejectionReasonKeys(
  lane: MildDipTapeLane,
  evaluation: MildDipTapeEvaluation,
): string[] {
  const keys = new Set<string>();
  const features = evaluation.features;
  if (features.imp60 == null) keys.add('no_60m_coverage');
  if (features.imp5 == null) keys.add('no_5m_coverage');
  if (features.pairAgeHours == null) keys.add('pairAgeHours=null');
  for (const reason of evaluation.reasons[lane]) {
    const key = reason.slice(0, reason.indexOf('='));
    if (key.endsWith('_age') && features.pairAgeHours == null) continue;
    if (key === 'imp60' && features.imp60 == null) continue;
    if (key === 'green_imp5_min' || key === 'green_imp5_max' || key === 'dip_imp5') {
      if (features.imp5 == null) continue;
    }
    if (key && !keys.has(key)) keys.add(key);
  }
  return [...keys];
}

const HORIZONS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
const HORIZON_SET = new Set<number>(HORIZONS_MS);

export type MildDipTapeShadowPersistedState = {
  updatedAtMs?: number;
  ring?: Record<string, MildDipPriceSample[]>;
  pending?: Array<{
    id?: string;
    lane?: MildDipTapeLane;
    mint?: string;
    signalTsMs?: number;
    signalPriceUsd?: number;
    maxPriceUsd?: number;
    minPriceUsd?: number;
    emitted?: number[];
  }>;
  lastSignalAt?: Record<string, number>;
  signalTimes?: number[];
  sequence?: number;
  pairAgeRegistry?: MildDipPairAgeRegistryState;
  pairAgeAttempts?: MildDipPairAgeAttemptState;
};

export class MildDipTapeShadow {
  private readonly opts: MildDipTapeShadowOptions;
  private readonly lastSignalAt = new Map<string, number>();
  private readonly signalTimes: number[] = [];
  private readonly pending: PendingSignal[] = [];
  private readonly counters: Record<MildDipTapeLane, TapeLaneCounters> = {
    green: {
      conditions: 0,
      recorded: 0,
      suppressedCap: 0,
      suppressedInterval: 0,
      pairAgeKnown: 0,
      pairAgeUnknown: 0,
      rejectionReasons: {},
    },
    dip: {
      conditions: 0,
      recorded: 0,
      suppressedCap: 0,
      suppressedInterval: 0,
      pairAgeKnown: 0,
      pairAgeUnknown: 0,
      rejectionReasons: {},
    },
  };
  private summaryWindowStartMs: number | null = null;
  private sequence = 0;
  private pairAgeBackfillRequested = 0;
  private pairAgeBackfillResolved = 0;
  private pairAgeBackfillNull = 0;

  constructor(opts: MildDipTapeShadowOptions) {
    this.opts = opts;
  }

  getPairAgeRegistry(): MildDipPairAgeRegistry {
    return this.opts.pairAgeRegistry ?? mildDipPairAgeRegistry;
  }

  private pairAgeMaxStaleMs(): number {
    return this.opts.pairAgeMaxStaleMs ?? 7 * 24 * 3_600_000;
  }

  private pairAgeMaxEntries(): number {
    return this.opts.pairAgeMaxEntries ?? 5_000;
  }

  toJSON(nowMs = Date.now()): MildDipTapeShadowPersistedState {
    this.pruneSignalTimes(nowMs);
    return {
      updatedAtMs: nowMs,
      ring: this.opts.ring.toJSON(nowMs),
      pending: this.pending.map((signal) => ({
        id: signal.id,
        lane: signal.lane,
        mint: signal.mint,
        signalTsMs: signal.signalTsMs,
        signalPriceUsd: signal.signalPriceUsd,
        maxPriceUsd: signal.maxPriceUsd,
        minPriceUsd: signal.minPriceUsd,
        emitted: [...signal.emitted],
      })),
      lastSignalAt: Object.fromEntries(this.lastSignalAt),
      signalTimes: [...this.signalTimes],
      sequence: this.sequence,
      pairAgeRegistry: this.getPairAgeRegistry().toJSON(
        nowMs,
        this.pairAgeMaxStaleMs(),
        this.pairAgeMaxEntries(),
      ),
      pairAgeAttempts: this.getPairAgeRegistry().attemptsToJSON(
        nowMs,
        this.pairAgeMaxStaleMs(),
        this.pairAgeMaxEntries(),
      ),
    };
  }

  loadJSON(data: unknown, nowMs = Date.now()): { samples: number; pending: number } {
    if (!data || typeof data !== 'object') return { samples: 0, pending: 0 };
    const state = data as MildDipTapeShadowPersistedState;
    const samples = this.opts.ring.loadJSON(state.ring ?? {}, nowMs);
    this.getPairAgeRegistry().loadJSON(
      state.pairAgeRegistry ?? {},
      nowMs,
      this.pairAgeMaxStaleMs(),
      this.pairAgeMaxEntries(),
    );
    this.getPairAgeRegistry().loadAttemptsJSON(
      state.pairAgeAttempts ?? {},
      nowMs,
      this.pairAgeMaxStaleMs(),
      this.pairAgeMaxEntries(),
    );
    this.lastSignalAt.clear();
    for (const [mint, tsMs] of Object.entries(state.lastSignalAt ?? {})) {
      if (mint && typeof tsMs === 'number' && Number.isFinite(tsMs)) {
        this.lastSignalAt.set(mint, tsMs);
      }
    }
    this.signalTimes.length = 0;
    for (const tsMs of state.signalTimes ?? []) {
      if (typeof tsMs === 'number' && Number.isFinite(tsMs)) this.signalTimes.push(tsMs);
    }
    this.pruneSignalTimes(nowMs);
    this.pending.length = 0;
    let pending = 0;
    for (const raw of state.pending ?? []) {
      if (
        !raw ||
        (raw.lane !== 'green' && raw.lane !== 'dip') ||
        typeof raw.id !== 'string' ||
        typeof raw.mint !== 'string' ||
        typeof raw.signalTsMs !== 'number' ||
        !Number.isFinite(raw.signalTsMs) ||
        typeof raw.signalPriceUsd !== 'number' ||
        !Number.isFinite(raw.signalPriceUsd) ||
        typeof raw.maxPriceUsd !== 'number' ||
        !Number.isFinite(raw.maxPriceUsd) ||
        typeof raw.minPriceUsd !== 'number' ||
        !Number.isFinite(raw.minPriceUsd)
      ) {
        continue;
      }
      if (raw.signalTsMs + HORIZONS_MS[HORIZONS_MS.length - 1] <= nowMs) continue;
      const emitted = new Set(
        (Array.isArray(raw.emitted) ? raw.emitted : []).filter((h): h is number =>
          HORIZON_SET.has(h),
        ),
      );
      if (emitted.size >= HORIZONS_MS.length) continue;
      this.pending.push({
        id: raw.id,
        lane: raw.lane,
        mint: raw.mint,
        signalTsMs: raw.signalTsMs,
        signalPriceUsd: raw.signalPriceUsd,
        maxPriceUsd: raw.maxPriceUsd,
        minPriceUsd: raw.minPriceUsd,
        emitted,
      });
      pending += 1;
    }
    if (
      typeof state.sequence === 'number' &&
      Number.isInteger(state.sequence) &&
      state.sequence >= 0
    ) {
      this.sequence = state.sequence;
    }
    return { samples, pending };
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
    this.tick(input.tsMs);

    const pairAgeHours =
      input.pairAgeHours ??
      this.getPairAgeRegistry().pairAgeHours(input.mint, input.tsMs);
    const evaluation = evaluateMildDipTape(
      tapeFeatures(this.opts.ring, input.mint, input.tsMs, pairAgeHours, sample),
      this.opts.gates,
    );
    for (const lane of ['green', 'dip'] as const) {
      if (pairAgeHours == null) this.counters[lane].pairAgeUnknown += 1;
      else this.counters[lane].pairAgeKnown += 1;
      if (!evaluation.matches.includes(lane)) {
        for (const reason of rejectionReasonKeys(lane, evaluation)) {
          this.counters[lane].rejectionReasons[reason] =
            (this.counters[lane].rejectionReasons[reason] ?? 0) + 1;
        }
      }
    }
    if (evaluation.matches.length === 0) return;
    this.pruneSignalTimes(input.tsMs);
    const lastSignalAt = this.lastSignalAt.get(input.mint) ?? 0;
    let recordedAny = false;
    for (const lane of evaluation.matches) {
      this.counters[lane].conditions += 1;
      if (input.tsMs - lastSignalAt < this.opts.minIntervalMs) {
        this.counters[lane].suppressedInterval += 1;
        continue;
      }
      if (this.signalTimes.length >= this.opts.maxSignalsPerHour) {
        this.counters[lane].suppressedCap += 1;
        continue;
      }
      this.signalTimes.push(input.tsMs);
      this.counters[lane].recorded += 1;
      recordedAny = true;
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
    if (recordedAny) this.lastSignalAt.set(input.mint, input.tsMs);
  }

  tick(nowMs: number): void {
    if (this.summaryWindowStartMs == null) this.summaryWindowStartMs = nowMs;
    for (const signal of this.pending) {
      const latest = this.opts.ring.latestAtOrBefore(signal.mint, nowMs);
      if (!latest || latest.tsMs < signal.signalTsMs) continue;
      for (const horizonMs of HORIZONS_MS) {
        const horizonTsMs = signal.signalTsMs + horizonMs;
        if (signal.emitted.has(horizonMs) || nowMs < horizonTsMs) continue;
        const horizonSample = this.opts.ring.latestAtOrBefore(signal.mint, horizonTsMs) ?? latest;
        const stats = this.opts.ring.samplesInRange(signal.mint, signal.signalTsMs, horizonTsMs);
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
          priceAtHorizonUsd: horizonSample.priceUsd,
          priceAgeMs: Math.max(0, horizonTsMs - horizonSample.tsMs),
          priceStale:
            Math.max(0, horizonTsMs - horizonSample.tsMs) >
            (this.opts.outcomeStaleMs ?? 5 * 60_000),
          maxPriceUsd: stats.maxPriceUsd ?? signal.signalPriceUsd,
          minPriceUsd: stats.minPriceUsd ?? signal.signalPriceUsd,
          sampleCount: stats.sampleCount,
          shadowOnly: true,
        });
      }
    }
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      if (this.pending[i]!.emitted.size === HORIZONS_MS.length) this.pending.splice(i, 1);
    }
    this.opts.ring.evictIdle(
      nowMs,
      this.opts.idleEvictMs ?? this.opts.outcomeStaleMs ?? 15 * 60_000,
      new Set(this.pending.map((signal) => signal.mint)),
    );
    const summaryIntervalMs = this.opts.summaryIntervalMs ?? 5 * 60_000;
    if (nowMs - this.summaryWindowStartMs >= summaryIntervalMs) {
      const hasActivity =
        this.counters.green.conditions > 0 ||
        this.counters.dip.conditions > 0 ||
        this.counters.green.pairAgeKnown > 0 ||
        this.counters.green.pairAgeUnknown > 0 ||
        this.counters.dip.pairAgeKnown > 0 ||
        this.counters.dip.pairAgeUnknown > 0 ||
        this.pairAgeBackfillRequested > 0 ||
        Object.keys(this.counters.green.rejectionReasons).length > 0 ||
        Object.keys(this.counters.dip.rejectionReasons).length > 0;
      if (hasActivity) {
        this.opts.append({
          kind: 'mild_dip_tape_lane_summary',
          windowStartMs: this.summaryWindowStartMs,
          windowEndMs: nowMs,
          lanes: {
            green: {
              conditions: this.counters.green.conditions,
              recorded: this.counters.green.recorded,
              suppressedCap: this.counters.green.suppressedCap,
              suppressedInterval: this.counters.green.suppressedInterval,
              pairAgeKnown: this.counters.green.pairAgeKnown,
              pairAgeUnknown: this.counters.green.pairAgeUnknown,
              rejectionReasons: { ...this.counters.green.rejectionReasons },
            },
            dip: {
              conditions: this.counters.dip.conditions,
              recorded: this.counters.dip.recorded,
              suppressedCap: this.counters.dip.suppressedCap,
              suppressedInterval: this.counters.dip.suppressedInterval,
              pairAgeKnown: this.counters.dip.pairAgeKnown,
              pairAgeUnknown: this.counters.dip.pairAgeUnknown,
              rejectionReasons: { ...this.counters.dip.rejectionReasons },
            },
          },
          pairAgeBackfill: {
            requested: this.pairAgeBackfillRequested,
            resolved: this.pairAgeBackfillResolved,
            null: this.pairAgeBackfillNull,
          },
          shadowOnly: true,
        });
      }
      this.counters.green = {
        conditions: 0,
        recorded: 0,
        suppressedCap: 0,
        suppressedInterval: 0,
        pairAgeKnown: 0,
        pairAgeUnknown: 0,
        rejectionReasons: {},
      };
      this.counters.dip = {
        conditions: 0,
        recorded: 0,
        suppressedCap: 0,
        suppressedInterval: 0,
        pairAgeKnown: 0,
        pairAgeUnknown: 0,
        rejectionReasons: {},
      };
      this.pairAgeBackfillRequested = 0;
      this.pairAgeBackfillResolved = 0;
      this.pairAgeBackfillNull = 0;
      this.summaryWindowStartMs = nowMs;
    }
  }

  notePairAgeBackfill(requested: number, resolved: number, nulls: number): void {
    this.pairAgeBackfillRequested += Math.max(0, Math.floor(requested));
    this.pairAgeBackfillResolved += Math.max(0, Math.floor(resolved));
    this.pairAgeBackfillNull += Math.max(0, Math.floor(nulls));
  }

  selectPairAgeBackfillMints(
    nowMs: number,
    windowMs: number,
    retryMs: number,
    maxMints: number,
    hasStructuralAge: (mint: string) => boolean,
  ): string[] {
    return this.opts.ring
      .watchedMints(nowMs)
      .filter(
        (mint) =>
          !hasStructuralAge(mint) &&
          this.getPairAgeRegistry().pairAgeHours(mint, nowMs) == null &&
          this.getPairAgeRegistry().canAttemptPairAge(mint, nowMs, retryMs),
      )
      .sort(
        (a, b) =>
          this.opts.ring.sampleCount(b, windowMs, nowMs) -
          this.opts.ring.sampleCount(a, windowMs, nowMs),
      )
      .slice(0, Math.max(0, Math.floor(maxMints)));
  }

  private pruneSignalTimes(nowMs: number): void {
    const cut = nowMs - 60 * 60_000;
    while (this.signalTimes.length > 0 && this.signalTimes[0]! <= cut) this.signalTimes.shift();
  }
}

export function saveMildDipTapeShadowState(
  filePath: string,
  shadow: MildDipTapeShadow,
  nowMs = Date.now(),
): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(shadow.toJSON(nowMs))}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

export function loadMildDipTapeShadowState(
  filePath: string,
  shadow: MildDipTapeShadow,
  nowMs = Date.now(),
): { samples: number; pending: number } {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return shadow.loadJSON(raw, nowMs);
  } catch {
    return { samples: 0, pending: 0 };
  }
}

export function createMildDipTapeShadowStateSaver(opts: {
  filePath: string;
  shadow: MildDipTapeShadow;
  ring: MildDipPriceRing;
  saveIntervalMs: number;
  idleEvictMs: number;
  pairAgeMaxStaleMs?: number;
  pairAgeMaxEntries?: number;
  now?: () => number;
  log?: (message: string) => void;
}): { save: (force?: boolean) => boolean } {
  let lastSaveMs: number | null = null;
  let lastSizeLogMs = Number.NEGATIVE_INFINITY;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? console.log;

  return {
    save(force = false): boolean {
      const nowMs = now();
      if (!force && lastSaveMs != null && nowMs - lastSaveMs < opts.saveIntervalMs) {
        return false;
      }
      opts.ring.evictIdle(nowMs, opts.idleEvictMs);
      opts.shadow.getPairAgeRegistry().evict(
        nowMs,
        opts.pairAgeMaxStaleMs ?? 7 * 24 * 3_600_000,
        opts.pairAgeMaxEntries ?? 5_000,
      );
      saveMildDipTapeShadowState(opts.filePath, opts.shadow, nowMs);
      lastSaveMs = nowMs;
      if (nowMs - lastSizeLogMs >= 10 * 60_000) {
        try {
          const bytes = fs.statSync(opts.filePath).size;
          const mints = opts.ring.watchedMints(nowMs).length;
          log(`[mild-dip] tape-shadow state saved bytes=${bytes} mints=${mints}`);
          lastSizeLogMs = nowMs;
        } catch {
          /* ignore diagnostics failure after a successful state save */
        }
      }
      return true;
    },
  };
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
