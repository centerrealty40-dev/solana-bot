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

export type MildDipTapeStructuralSnapshot = {
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  volume5mUsd: number | null;
  turnover: number | null;
  dexId: string | null;
  pairAgeHours: number | null;
};

export type MildDipTapeOwnFloorGates = {
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  minMarketCapUsd: number;
  minVolume5mUsd: number;
  maxTurnover: number;
  minPairAgeHours: number;
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
  greenMeasureAll = false,
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
      ...(greenMeasureAll || greenReasons.length === 0 ? (['green'] as const) : []),
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

export function tapeShadowDiscoverySampleDecision(
  mint: string,
  nowMs: number,
  lastSampleAt: Map<string, number>,
  maxMints: number,
  minGapMs: number,
  staleMs: number,
  cleanup?: { lastAtMs: number },
  cleanupIntervalMs = 1_000,
): 'sample' | 'limitRejected' | 'skip' {
  if (!mint || maxMints <= 0) return 'skip';
  if (
    cleanup &&
    (cleanup.lastAtMs <= 0 ||
      nowMs < cleanup.lastAtMs ||
      nowMs - cleanup.lastAtMs >= Math.max(0, cleanupIntervalMs))
  ) {
    for (const [seenMint, lastSeenMs] of lastSampleAt) {
      if (nowMs - lastSeenMs > Math.max(0, staleMs)) lastSampleAt.delete(seenMint);
    }
    cleanup.lastAtMs = nowMs;
  }
  const lastSampleMs = lastSampleAt.get(mint);
  if (lastSampleMs != null && nowMs - lastSampleMs < Math.max(0, minGapMs)) return 'skip';
  if (lastSampleMs == null && lastSampleAt.size >= Math.floor(maxMints)) {
    return 'limitRejected';
  }
  lastSampleAt.set(mint, nowMs);
  return 'sample';
}

export type MildDipTapeShadowOptions = {
  ring: MildDipPriceRing;
  pairAgeRegistry?: MildDipPairAgeRegistry;
  pairAgeMaxStaleMs?: number;
  pairAgeMaxEntries?: number;
  gates: MildDipTapeGates;
  minIntervalMs: number;
  maxSignalsPerHour: number;
  laneLimits?: Record<
    MildDipTapeLane,
    { minIntervalMs: number; maxSignalsPerHour: number }
  >;
  greenMeasureAll?: boolean;
  outcomeStaleMs?: number;
  idleEvictMs?: number;
  summaryIntervalMs?: number;
  pendingSampleGraceMs?: number;
  pathMaxPoints?: number;
  exitArmPct?: number;
  exitTrailPct?: number;
  exitStopPct?: number;
  exitTimeoutMs?: number;
  structuralSnapshot?: (
    mint: string,
    tsMs: number,
  ) => Promise<MildDipTapeStructuralSnapshot | null>;
  ownFloors?: Record<MildDipTapeLane, MildDipTapeOwnFloorGates>;
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
  sampleUntilMs: number;
  path: Array<[number, number]>;
  peakPriceUsd: number;
  peakTsMs: number;
  troughPriceUsd: number;
  troughTsMs: number;
  armed: boolean;
  lastSimTsMs: number | null;
  lastSimPriceUsd: number | null;
  simSampleCount: number;
  pathBuckets: Map<number, [number, number]>;
  exit?: { reason: 'trail' | 'stop' | 'timeout' | 'no_data'; priceUsd: number; tsMs: number };
  exitEmitted: boolean;
  exitLastSampleAgeMs: number;
};

type TapeLaneCounters = {
  conditions: number;
  recorded: number;
  suppressedCap: number;
  suppressedInterval: number;
  pairAgeKnown: number;
  pairAgeUnknown: number;
  rejectionReasons: Record<string, number>;
  structuralSignals: number;
  structuralPass: number;
  structuralNull: number;
  structuralRejectionReasons: Record<string, number>;
  snapshotSignals: number;
  snapshotMissing: number;
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

function evaluateOwnFloors(
  lane: MildDipTapeLane,
  snapshot: MildDipTapeStructuralSnapshot | null,
  gates: MildDipTapeOwnFloorGates | undefined,
): { pass: boolean | null; fail: string[] } {
  if (!snapshot) return { pass: null, fail: ['no_structural_snapshot'] };
  if (!gates) return { pass: true, fail: [] };
  const fail: string[] = [];
  if (snapshot.liquidityUsd == null || snapshot.liquidityUsd < gates.minLiquidityUsd) {
    fail.push(`${lane}_min_liquidity_usd`);
  }
  if (
    gates.maxLiquidityUsd > 0 &&
    (snapshot.liquidityUsd == null || snapshot.liquidityUsd > gates.maxLiquidityUsd)
  ) {
    fail.push(`${lane}_max_liquidity_usd`);
  }
  if (snapshot.marketCapUsd == null || snapshot.marketCapUsd < gates.minMarketCapUsd) {
    fail.push(`${lane}_min_market_cap_usd`);
  }
  if (snapshot.volume5mUsd == null || snapshot.volume5mUsd < gates.minVolume5mUsd) {
    fail.push(`${lane}_min_volume5m_usd`);
  }
  if (
    gates.maxTurnover > 0 &&
    (snapshot.turnover == null || snapshot.turnover > gates.maxTurnover)
  ) {
    fail.push(`${lane}_max_turnover`);
  }
  if (snapshot.pairAgeHours == null || snapshot.pairAgeHours < gates.minPairAgeHours) {
    fail.push(`${lane}_min_age_hours`);
  }
  return { pass: fail.length === 0, fail };
}

const HORIZONS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
const HORIZON_SET = new Set<number>(HORIZONS_MS);

export function decimateTapePath(
  samples: readonly [number, number][],
  maxPoints: number,
): Array<[number, number]> {
  const ordered = [...new Map(
    [...samples]
      .sort((a, b) => a[0] - b[0])
      .map((point) => [`${point[0]}:${point[1]}`, point]),
  ).values()];
  if (maxPoints <= 0) return [];
  if (ordered.length <= maxPoints) return ordered;
  const high = ordered.reduce((a, b) => (b[1] > a[1] ? b : a), ordered[0]!);
  const low = ordered.reduce((a, b) => (b[1] < a[1] ? b : a), ordered[0]!);
  const required = new Map<string, [number, number]>([
    [`${high[0]}:${high[1]}`, high],
    [`${low[0]}:${low[1]}`, low],
  ]);
  for (const point of ordered) {
    if (required.size >= maxPoints) break;
    required.set(`${point[0]}:${point[1]}`, point);
  }
  return [...required.values()].sort((a, b) => a[0] - b[0]);
}

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
    sampleUntilMs?: number;
    path?: Array<[number, number]>;
    peakPriceUsd?: number;
    peakTsMs?: number;
    troughPriceUsd?: number;
    troughTsMs?: number;
    armed?: boolean;
    lastSimTsMs?: number | null;
    lastSimPriceUsd?: number | null;
    simSampleCount?: number;
    exit?: PendingSignal['exit'];
    exitEmitted?: boolean;
    exitLastSampleAgeMs?: number;
  }>;
  lastSignalAt?: Record<string, number>;
  signalTimes?: number[];
  lastSignalAtByLane?: Record<MildDipTapeLane, Record<string, number>>;
  signalTimesByLane?: Record<MildDipTapeLane, number[]>;
  sequence?: number;
  pairAgeRegistry?: MildDipPairAgeRegistryState;
  pairAgeAttempts?: MildDipPairAgeAttemptState;
};

export class MildDipTapeShadow {
  private readonly opts: MildDipTapeShadowOptions;
  private readonly lastSignalAt = new Map<MildDipTapeLane, Map<string, number>>([
    ['green', new Map()],
    ['dip', new Map()],
  ]);
  private readonly signalTimes = new Map<MildDipTapeLane, number[]>([
    ['green', []],
    ['dip', []],
  ]);
  private readonly pending: PendingSignal[] = [];
  private readonly pendingByMint = new Map<string, PendingSignal[]>();
  private readonly counters: Record<MildDipTapeLane, TapeLaneCounters> = {
    green: {
      conditions: 0,
      recorded: 0,
      suppressedCap: 0,
      suppressedInterval: 0,
      pairAgeKnown: 0,
      pairAgeUnknown: 0,
      rejectionReasons: {},
      structuralSignals: 0,
      structuralPass: 0,
      structuralNull: 0,
      structuralRejectionReasons: {},
      snapshotSignals: 0,
      snapshotMissing: 0,
    },
    dip: {
      conditions: 0,
      recorded: 0,
      suppressedCap: 0,
      suppressedInterval: 0,
      pairAgeKnown: 0,
      pairAgeUnknown: 0,
      rejectionReasons: {},
      structuralSignals: 0,
      structuralPass: 0,
      structuralNull: 0,
      structuralRejectionReasons: {},
      snapshotSignals: 0,
      snapshotMissing: 0,
    },
  };
  private summaryWindowStartMs: number | null = null;
  private sequence = 0;
  private pairAgeBackfillRequested = 0;
  private pairAgeBackfillResolved = 0;
  private pairAgeBackfillNull = 0;
  private samplingPending = 0;
  private samplingShadowDiscovery = 0;
  private samplingLimitRejected = 0;
  private structuralFetchCapped = 0;
  private structuralBatchRequests = 0;
  private structuralMintsRequested = 0;
  private structuralMintsResolved = 0;
  private structuralMintsMissed = 0;
  private structuralErrorBackoffs = 0;
  private structuralBatchCapHits = 0;
  private pendingMintCache: {
    computedAtMs: number;
    nextExpiryMs: number;
    graceMs: number;
    maxMints: number;
    all: Set<string>;
    selected: Set<string>;
  } | null = null;

  constructor(opts: MildDipTapeShadowOptions) {
    this.opts = opts;
  }

  private invalidatePendingMintCache(): void {
    this.pendingMintCache = null;
  }

  private appendSignal(
    lane: MildDipTapeLane,
    id: string,
    input: {
      mint: string;
      priceUsd: number;
      tsMs: number;
      source: MildDipPriceSource;
    },
    features: MildDipTapeFeatures,
    formulaGateFailures: string[],
    snapshot: MildDipTapeStructuralSnapshot | null,
  ): void {
    const floor = evaluateOwnFloors(lane, snapshot, this.opts.ownFloors?.[lane]);
    const counters = this.counters[lane];
    counters.structuralSignals += 1;
    if (snapshot) counters.snapshotSignals += 1;
    else counters.snapshotMissing += 1;
    if (floor.pass === true) counters.structuralPass += 1;
    else if (floor.pass == null) counters.structuralNull += 1;
    for (const reason of floor.fail) {
      counters.structuralRejectionReasons[reason] =
        (counters.structuralRejectionReasons[reason] ?? 0) + 1;
    }
    this.opts.append({
      kind: 'mild_dip_tape_lane_signal',
      signalId: id,
      lane,
      mint: input.mint,
      ...features,
      liquidityUsd: snapshot?.liquidityUsd ?? null,
      marketCapUsd: snapshot?.marketCapUsd ?? null,
      volume5mUsd: snapshot?.volume5mUsd ?? null,
      turnover: snapshot?.turnover ?? null,
      dexId: snapshot?.dexId ?? null,
      pairAgeHours: snapshot?.pairAgeHours ?? features.pairAgeHours,
      currentPriceUsd: input.priceUsd,
      source: input.source,
      ownFloorsPass: floor.pass,
      ownFloorsFail: floor.fail,
      formulaGateFailures,
      measureAll: lane === 'green' && this.opts.greenMeasureAll === true,
      shadowOnly: true,
    });
  }

  private refreshPendingMintCache(nowMs: number, graceMs: number, maxMints: number): void {
    const normalizedGraceMs = Math.max(0, graceMs);
    const max = Math.max(0, Math.floor(maxMints));
    const cached = this.pendingMintCache;
    if (
      cached &&
      cached.graceMs === normalizedGraceMs &&
      cached.maxMints === max &&
      nowMs >= cached.computedAtMs &&
      nowMs < cached.nextExpiryMs &&
      nowMs - cached.computedAtMs < 1_000
    ) {
      return;
    }
    const allMints = new Set<string>();
    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const signal of this.pending) {
      const horizonExpiryMs =
        signal.signalTsMs + HORIZONS_MS[HORIZONS_MS.length - 1] + normalizedGraceMs;
      if (signal.sampleUntilMs <= nowMs || horizonExpiryMs <= nowMs) continue;
      allMints.add(signal.mint);
      nextExpiryMs = Math.min(nextExpiryMs, signal.sampleUntilMs, horizonExpiryMs);
    }
    const selected = new Set<string>();
    if (max > 0) {
      const candidates = this.pending
        .filter((signal) => allMints.has(signal.mint))
        .sort((a, b) => a.sampleUntilMs - b.sampleUntilMs);
      for (const signal of candidates) {
        if (selected.has(signal.mint)) continue;
        selected.add(signal.mint);
        if (selected.size >= max) break;
      }
    }
    this.pendingMintCache = {
      computedAtMs: nowMs,
      nextExpiryMs,
      graceMs: normalizedGraceMs,
      maxMints: max,
      all: allMints,
      selected,
    };
  }

  getPairAgeRegistry(): MildDipPairAgeRegistry {
    return this.opts.pairAgeRegistry ?? mildDipPairAgeRegistry;
  }

  private addPending(signal: PendingSignal): void {
    this.pending.push(signal);
    const bucket = this.pendingByMint.get(signal.mint) ?? [];
    bucket.push(signal);
    this.pendingByMint.set(signal.mint, bucket);
  }

  private removePending(signal: PendingSignal): void {
    const bucket = this.pendingByMint.get(signal.mint);
    if (!bucket) return;
    const index = bucket.indexOf(signal);
    if (index >= 0) bucket.splice(index, 1);
    if (bucket.length === 0) this.pendingByMint.delete(signal.mint);
  }

  private rebuildPath(signal: PendingSignal): void {
    const maxPoints = this.opts.pathMaxPoints ?? 60;
    if (maxPoints <= 0) {
      signal.path = [];
      return;
    }
    const points = [
      ...signal.path,
      ...signal.pathBuckets.values(),
      [signal.peakTsMs - signal.signalTsMs, signal.peakPriceUsd] as [number, number],
      [
        signal.troughTsMs - signal.signalTsMs,
        signal.troughPriceUsd,
      ] as [number, number],
    ];
    signal.path = decimateTapePath(points, maxPoints);
  }

  private recordPath(signal: PendingSignal, tsMs: number, priceUsd: number): void {
    const offset = tsMs - signal.signalTsMs;
    if (offset < 0 || offset > 60 * 60_000 || (this.opts.pathMaxPoints ?? 60) <= 0) return;
    const maxPoints = this.opts.pathMaxPoints ?? 60;
    const bucketWidth = (60 * 60_000) / Math.max(1, maxPoints);
    const bucket = Math.min(maxPoints - 1, Math.floor(offset / bucketWidth));
    if (!signal.pathBuckets.has(bucket)) signal.pathBuckets.set(bucket, [offset, priceUsd]);
    this.rebuildPath(signal);
  }

  private emitExit(signal: PendingSignal): void {
    if (!signal.exit || signal.exitEmitted) return;
    const lastTs = signal.lastSimTsMs ?? signal.signalTsMs;
    signal.exitLastSampleAgeMs =
      signal.exitLastSampleAgeMs ??
      Math.max(0, signal.exit.tsMs - lastTs);
    this.opts.append({
      kind: 'mild_dip_tape_lane_exit',
      signalId: signal.id,
      lane: signal.lane,
      mint: signal.mint,
      signalTsMs: signal.signalTsMs,
      signalPriceUsd: signal.signalPriceUsd,
      reason: signal.exit.reason,
      exitPriceUsd: signal.exit.priceUsd,
      exitTsMs: signal.exit.tsMs,
      holdMs: Math.max(0, signal.exit.tsMs - signal.signalTsMs),
      retPct:
        signal.signalPriceUsd > 0
          ? (signal.exit.priceUsd / signal.signalPriceUsd - 1) * 100
          : 0,
      mfePct:
        signal.signalPriceUsd > 0
          ? (signal.peakPriceUsd / signal.signalPriceUsd - 1) * 100
          : 0,
      maePct:
        signal.signalPriceUsd > 0
          ? (signal.troughPriceUsd / signal.signalPriceUsd - 1) * 100
          : 0,
      peakTsMs: signal.peakTsMs,
      peakToExitMs: Math.max(0, signal.exit.tsMs - signal.peakTsMs),
      sampleCount: signal.simSampleCount,
      exitLastSampleAgeMs: signal.exitLastSampleAgeMs,
      priceStale:
        signal.exitLastSampleAgeMs > (this.opts.outcomeStaleMs ?? 5 * 60_000),
      armed: signal.armed,
      shadowOnly: true,
    });
    signal.exitEmitted = true;
  }

  private pairAgeMaxStaleMs(): number {
    return this.opts.pairAgeMaxStaleMs ?? 7 * 24 * 3_600_000;
  }

  private pairAgeMaxEntries(): number {
    return this.opts.pairAgeMaxEntries ?? 5_000;
  }

  toJSON(nowMs = Date.now()): MildDipTapeShadowPersistedState {
    this.pruneSignalTimes('green', nowMs);
    this.pruneSignalTimes('dip', nowMs);
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
        sampleUntilMs: signal.sampleUntilMs,
        path: signal.path,
        peakPriceUsd: signal.peakPriceUsd,
        peakTsMs: signal.peakTsMs,
        troughPriceUsd: signal.troughPriceUsd,
        troughTsMs: signal.troughTsMs,
        armed: signal.armed,
        lastSimTsMs: signal.lastSimTsMs,
        lastSimPriceUsd: signal.lastSimPriceUsd,
        simSampleCount: signal.simSampleCount,
        exit: signal.exit,
        exitEmitted: signal.exitEmitted,
        exitLastSampleAgeMs: signal.exitLastSampleAgeMs,
      })),
      lastSignalAt: Object.fromEntries(this.lastSignalAt.get('dip')!),
      signalTimes: [...this.signalTimes.get('dip')!],
      lastSignalAtByLane: {
        green: Object.fromEntries(this.lastSignalAt.get('green')!),
        dip: Object.fromEntries(this.lastSignalAt.get('dip')!),
      },
      signalTimesByLane: {
        green: [...this.signalTimes.get('green')!],
        dip: [...this.signalTimes.get('dip')!],
      },
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
    for (const lane of ['green', 'dip'] as const) {
      this.lastSignalAt.get(lane)!.clear();
      const source = state.lastSignalAtByLane?.[lane] ?? state.lastSignalAt;
      for (const [mint, tsMs] of Object.entries(source ?? {})) {
        if (mint && typeof tsMs === 'number' && Number.isFinite(tsMs)) {
          this.lastSignalAt.get(lane)!.set(mint, tsMs);
        }
      }
      const times = this.signalTimes.get(lane)!;
      times.length = 0;
      for (const tsMs of state.signalTimesByLane?.[lane] ?? state.signalTimes ?? []) {
        if (typeof tsMs === 'number' && Number.isFinite(tsMs)) times.push(tsMs);
      }
    }
    this.pruneSignalTimes('green', nowMs);
    this.pruneSignalTimes('dip', nowMs);
    this.pending.length = 0;
    this.pendingByMint.clear();
    this.invalidatePendingMintCache();
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
      const sampleUntilMs =
        typeof raw.sampleUntilMs === 'number' && Number.isFinite(raw.sampleUntilMs)
          ? raw.sampleUntilMs
          : raw.signalTsMs +
            HORIZONS_MS[HORIZONS_MS.length - 1] +
            (this.opts.pendingSampleGraceMs ?? 0);
      if (emitted.size >= HORIZONS_MS.length && sampleUntilMs <= nowMs) continue;
      const path = Array.isArray(raw.path)
        ? raw.path.filter(
            (p): p is [number, number] =>
              Array.isArray(p) &&
              p.length === 2 &&
              typeof p[0] === 'number' &&
              typeof p[1] === 'number' &&
              Number.isFinite(p[0]) &&
              Number.isFinite(p[1]),
          )
        : [[0, raw.signalPriceUsd] as [number, number]];
      const pathBuckets = new Map<number, [number, number]>();
      for (const point of path) {
        const width = 60 * 60_000 / Math.max(1, this.opts.pathMaxPoints ?? 60);
        const bucket = Math.min(
          Math.max(0, (this.opts.pathMaxPoints ?? 60) - 1),
          Math.floor(point[0] / width),
        );
        if (!pathBuckets.has(bucket)) pathBuckets.set(bucket, point);
      }
      const restored: PendingSignal = {
        id: raw.id,
        lane: raw.lane,
        mint: raw.mint,
        signalTsMs: raw.signalTsMs,
        signalPriceUsd: raw.signalPriceUsd,
        maxPriceUsd: raw.maxPriceUsd,
        minPriceUsd: raw.minPriceUsd,
        emitted,
        sampleUntilMs,
        path,
        peakPriceUsd:
          typeof raw.peakPriceUsd === 'number' ? raw.peakPriceUsd : raw.signalPriceUsd,
        peakTsMs:
          typeof raw.peakTsMs === 'number' ? raw.peakTsMs : raw.signalTsMs,
        troughPriceUsd:
          typeof raw.troughPriceUsd === 'number' ? raw.troughPriceUsd : raw.signalPriceUsd,
        troughTsMs:
          typeof raw.troughTsMs === 'number' ? raw.troughTsMs : raw.signalTsMs,
        armed: raw.armed === true,
        lastSimTsMs:
          typeof raw.lastSimTsMs === 'number' ? raw.lastSimTsMs : null,
        lastSimPriceUsd:
          typeof raw.lastSimPriceUsd === 'number' ? raw.lastSimPriceUsd : null,
        simSampleCount:
          typeof raw.simSampleCount === 'number' ? raw.simSampleCount : 0,
        pathBuckets,
        exit: raw.exit,
        exitEmitted: raw.exitEmitted === true,
        exitLastSampleAgeMs:
          typeof raw.exitLastSampleAgeMs === 'number' ? raw.exitLastSampleAgeMs : 0,
      };
      if (
        restored.exit &&
        raw.exitLastSampleAgeMs == null &&
        restored.exit.reason === 'timeout'
      ) {
        restored.exitLastSampleAgeMs = Math.max(
          0,
          restored.exit.tsMs - (restored.lastSimTsMs ?? restored.signalTsMs),
        );
      }
      this.addPending(restored);
      if (raw.exit && raw.exitEmitted !== true) this.emitExit(restored);
      this.invalidatePendingMintCache();
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
    for (const signal of this.pendingByMint.get(input.mint) ?? []) {
      if (input.tsMs <= signal.signalTsMs) continue;
      this.simulateSample(signal, input.tsMs, input.priceUsd);
    }
    this.tick(input.tsMs);

    const pairAgeHours =
      input.pairAgeHours ??
      this.getPairAgeRegistry().pairAgeHours(input.mint, input.tsMs);
    const evaluation = evaluateMildDipTape(
      tapeFeatures(this.opts.ring, input.mint, input.tsMs, pairAgeHours, sample),
      this.opts.gates,
      this.opts.greenMeasureAll ?? false,
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
    let recordedAny = false;
    const recordedLanes = new Set<MildDipTapeLane>();
    for (const lane of evaluation.matches) {
      this.counters[lane].conditions += 1;
      const limits = this.opts.laneLimits?.[lane] ?? {
        minIntervalMs: this.opts.minIntervalMs,
        maxSignalsPerHour: this.opts.maxSignalsPerHour,
      };
      this.pruneSignalTimes(lane, input.tsMs);
      const lastSignalAt = this.lastSignalAt.get(lane)!.get(input.mint) ?? 0;
      if (input.tsMs - lastSignalAt < limits.minIntervalMs) {
        this.counters[lane].suppressedInterval += 1;
        continue;
      }
      if (this.signalTimes.get(lane)!.length >= limits.maxSignalsPerHour) {
        this.counters[lane].suppressedCap += 1;
        continue;
      }
      this.signalTimes.get(lane)!.push(input.tsMs);
      this.counters[lane].recorded += 1;
      recordedAny = true;
      recordedLanes.add(lane);
      const id = `${input.mint}:${input.tsMs}:${lane}:${this.sequence++}`;
      const emitSignal = (snapshot: MildDipTapeStructuralSnapshot | null): void =>
        this.appendSignal(
          lane,
          id,
          {
            mint: input.mint,
            priceUsd: input.priceUsd,
            tsMs: input.tsMs,
            source,
          },
          evaluation.features,
          evaluation.reasons[lane],
          snapshot,
        );
      if (this.opts.structuralSnapshot) {
        void Promise.resolve()
          .then(() => this.opts.structuralSnapshot!(input.mint, input.tsMs))
          .then((snapshot) => emitSignal(snapshot))
          .catch(() => emitSignal(null));
      } else {
        emitSignal(null);
      }
      const pendingSignal: PendingSignal = {
        id,
        lane,
        mint: input.mint,
        signalTsMs: input.tsMs,
        signalPriceUsd: input.priceUsd,
        maxPriceUsd: input.priceUsd,
        minPriceUsd: input.priceUsd,
        emitted: new Set(),
        sampleUntilMs:
          input.tsMs +
          HORIZONS_MS[HORIZONS_MS.length - 1] +
          (this.opts.pendingSampleGraceMs ?? 0),
        path: [[0, input.priceUsd]],
        peakPriceUsd: input.priceUsd,
        peakTsMs: input.tsMs,
        troughPriceUsd: input.priceUsd,
        troughTsMs: input.tsMs,
        armed: false,
        lastSimTsMs: null,
        lastSimPriceUsd: null,
        simSampleCount: 0,
        pathBuckets: new Map(),
        exitEmitted: false,
        exitLastSampleAgeMs: 0,
      };
      this.recordPath(pendingSignal, input.tsMs, input.priceUsd);
      this.addPending(pendingSignal);
      this.invalidatePendingMintCache();
    }
    if (recordedAny) {
      for (const lane of recordedLanes) {
        this.lastSignalAt.get(lane)!.set(input.mint, input.tsMs);
      }
    }
  }

  private simulateSample(signal: PendingSignal, tsMs: number, priceUsd: number): void {
    if (signal.exit || !Number.isFinite(priceUsd) || priceUsd <= 0) return;
    if (tsMs > signal.signalTsMs + (this.opts.exitTimeoutMs ?? 3_600_000)) {
      signal.exit = {
        reason: signal.simSampleCount > 0 ? 'timeout' : 'no_data',
        priceUsd: signal.simSampleCount > 0
          ? signal.lastSimPriceUsd ?? signal.signalPriceUsd
          : signal.signalPriceUsd,
        tsMs: signal.lastSimTsMs ?? signal.signalTsMs,
      };
      signal.exitLastSampleAgeMs = Math.max(
        0,
        (signal.exit.tsMs ?? tsMs) - (signal.lastSimTsMs ?? signal.signalTsMs),
      );
      this.emitExit(signal);
      return;
    }
    signal.maxPriceUsd = Math.max(signal.maxPriceUsd, priceUsd);
    signal.minPriceUsd = Math.min(signal.minPriceUsd, priceUsd);
    if (priceUsd < signal.troughPriceUsd) {
      signal.troughPriceUsd = priceUsd;
      signal.troughTsMs = tsMs;
    }
    signal.simSampleCount += 1;
    signal.lastSimTsMs = tsMs;
    signal.lastSimPriceUsd = priceUsd;
    if (priceUsd > signal.peakPriceUsd) {
      signal.peakPriceUsd = priceUsd;
      signal.peakTsMs = tsMs;
    }
    this.recordPath(signal, tsMs, priceUsd);
    const entry = signal.signalPriceUsd;
    if (priceUsd / entry - 1 >= (this.opts.exitArmPct ?? 10) / 100) signal.armed = true;
    const stop = priceUsd <= entry * (1 + (this.opts.exitStopPct ?? -30) / 100);
    const trail =
      signal.armed &&
      priceUsd <= signal.peakPriceUsd * (1 - (this.opts.exitTrailPct ?? 9) / 100);
    if (stop || trail) {
      signal.exit = {
        reason: trail ? 'trail' : 'stop',
        priceUsd,
        tsMs,
      };
      signal.exitLastSampleAgeMs = 0;
      this.emitExit(signal);
    }
  }

  private emitCompletion(signal: PendingSignal, nowMs: number): void {
    if (!signal.exit) {
      if (signal.simSampleCount === 0) {
        signal.exit = { reason: 'no_data', priceUsd: signal.signalPriceUsd, tsMs: signal.signalTsMs };
        signal.exitLastSampleAgeMs = 0;
        this.emitExit(signal);
      } else if (nowMs >= signal.signalTsMs + (this.opts.exitTimeoutMs ?? 3_600_000)) {
        signal.exit = {
          reason: 'timeout',
          priceUsd: signal.lastSimPriceUsd ?? signal.signalPriceUsd,
          tsMs: signal.lastSimTsMs ?? signal.signalTsMs,
        };
        signal.exitLastSampleAgeMs = Math.max(
          0,
          nowMs - (signal.lastSimTsMs ?? signal.signalTsMs),
        );
        this.emitExit(signal);
      }
    }
    if (!signal.exit) return;
    this.opts.append({
      kind: 'mild_dip_tape_lane_path',
      signalId: signal.id,
      lane: signal.lane,
      mint: signal.mint,
      signalTsMs: signal.signalTsMs,
      signalPriceUsd: signal.signalPriceUsd,
      path:
        (this.opts.pathMaxPoints ?? 60) === 0
          ? []
          : decimateTapePath(signal.path, this.opts.pathMaxPoints ?? 60),
      pointsTotal: signal.path.length,
      firstTsMs: signal.signalTsMs + (signal.path[0]?.[0] ?? 0),
      lastTsMs: signal.signalTsMs + (signal.path[signal.path.length - 1]?.[0] ?? 0),
      shadowOnly: true,
    });
  }

  tick(nowMs: number): void {
    if (this.summaryWindowStartMs == null) this.summaryWindowStartMs = nowMs;
    for (const signal of this.pending) {
      if (
        !signal.exit &&
        nowMs >= signal.signalTsMs + (this.opts.exitTimeoutMs ?? 3_600_000) &&
        signal.simSampleCount > 0
      ) {
        signal.exit = {
          reason: 'timeout',
          priceUsd: signal.lastSimPriceUsd ?? signal.signalPriceUsd,
          tsMs: signal.lastSimTsMs!,
        };
        signal.exitLastSampleAgeMs = Math.max(
          0,
          nowMs - (signal.lastSimTsMs ?? signal.signalTsMs),
        );
        this.emitExit(signal);
      } else if (
        !signal.exit &&
        nowMs >= signal.signalTsMs + (this.opts.exitTimeoutMs ?? 3_600_000) &&
        signal.simSampleCount === 0
      ) {
        signal.exit = {
          reason: 'no_data',
          priceUsd: signal.signalPriceUsd,
          tsMs: signal.signalTsMs,
        };
        signal.exitLastSampleAgeMs = 0;
        this.emitExit(signal);
      }
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
      if (
        this.pending[i]!.emitted.size === HORIZONS_MS.length &&
        this.pending[i]!.sampleUntilMs <= nowMs
      ) {
        this.emitCompletion(this.pending[i]!, nowMs);
        const signal = this.pending[i]!;
        this.removePending(signal);
        this.pending.splice(i, 1);
        this.invalidatePendingMintCache();
      }
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
        this.counters.green.structuralSignals > 0 ||
        this.counters.dip.structuralSignals > 0 ||
        this.pairAgeBackfillRequested > 0 ||
        this.samplingPending > 0 ||
        this.samplingShadowDiscovery > 0 ||
        this.samplingLimitRejected > 0 ||
        this.structuralFetchCapped > 0 ||
        this.structuralBatchRequests > 0 ||
        this.structuralBatchCapHits > 0 ||
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
              structural: {
                signals: this.counters.green.structuralSignals,
                ownFloorsPass: this.counters.green.structuralPass,
                ownFloorsNull: this.counters.green.structuralNull,
                rejectionReasons: { ...this.counters.green.structuralRejectionReasons },
                withSnapshot: this.counters.green.snapshotSignals,
                withoutSnapshot: this.counters.green.snapshotMissing,
              },
            },
            dip: {
              conditions: this.counters.dip.conditions,
              recorded: this.counters.dip.recorded,
              suppressedCap: this.counters.dip.suppressedCap,
              suppressedInterval: this.counters.dip.suppressedInterval,
              pairAgeKnown: this.counters.dip.pairAgeKnown,
              pairAgeUnknown: this.counters.dip.pairAgeUnknown,
              rejectionReasons: { ...this.counters.dip.rejectionReasons },
              structural: {
                signals: this.counters.dip.structuralSignals,
                ownFloorsPass: this.counters.dip.structuralPass,
                ownFloorsNull: this.counters.dip.structuralNull,
                rejectionReasons: { ...this.counters.dip.structuralRejectionReasons },
                withSnapshot: this.counters.dip.snapshotSignals,
                withoutSnapshot: this.counters.dip.snapshotMissing,
              },
            },
          },
          pairAgeBackfill: {
            requested: this.pairAgeBackfillRequested,
            resolved: this.pairAgeBackfillResolved,
            null: this.pairAgeBackfillNull,
          },
          sampling: {
            pending: this.samplingPending,
            shadowDiscovery: this.samplingShadowDiscovery,
            limitRejected: this.samplingLimitRejected,
          },
          structuralFetchCapped: this.structuralFetchCapped,
          structuralBatchRequests: this.structuralBatchRequests,
          structuralMintsRequested: this.structuralMintsRequested,
          structuralMintsResolved: this.structuralMintsResolved,
          structuralMintsMissed: this.structuralMintsMissed,
          structuralErrorBackoffs: this.structuralErrorBackoffs,
          structuralBatchCapHits: this.structuralBatchCapHits,
          measureAll: this.opts.greenMeasureAll === true,
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
        structuralSignals: 0,
        structuralPass: 0,
        structuralNull: 0,
        structuralRejectionReasons: {},
        snapshotSignals: 0,
        snapshotMissing: 0,
      };
      this.counters.dip = {
        conditions: 0,
        recorded: 0,
        suppressedCap: 0,
        suppressedInterval: 0,
        pairAgeKnown: 0,
        pairAgeUnknown: 0,
        rejectionReasons: {},
        structuralSignals: 0,
        structuralPass: 0,
        structuralNull: 0,
        structuralRejectionReasons: {},
        snapshotSignals: 0,
        snapshotMissing: 0,
      };
      this.pairAgeBackfillRequested = 0;
      this.pairAgeBackfillResolved = 0;
      this.pairAgeBackfillNull = 0;
      this.samplingPending = 0;
      this.samplingShadowDiscovery = 0;
      this.samplingLimitRejected = 0;
      this.structuralFetchCapped = 0;
      this.structuralBatchRequests = 0;
      this.structuralMintsRequested = 0;
      this.structuralMintsResolved = 0;
      this.structuralMintsMissed = 0;
      this.structuralErrorBackoffs = 0;
      this.structuralBatchCapHits = 0;
      this.summaryWindowStartMs = nowMs;
    }
  }

  notePairAgeBackfill(requested: number, resolved: number, nulls: number): void {
    this.pairAgeBackfillRequested += Math.max(0, Math.floor(requested));
    this.pairAgeBackfillResolved += Math.max(0, Math.floor(resolved));
    this.pairAgeBackfillNull += Math.max(0, Math.floor(nulls));
  }

  noteSampling(reason: 'pending' | 'shadowDiscovery' | 'limitRejected', count = 1): void {
    const value = Math.max(0, Math.floor(count));
    if (reason === 'pending') this.samplingPending += value;
    else if (reason === 'shadowDiscovery') this.samplingShadowDiscovery += value;
    else this.samplingLimitRejected += value;
  }

  noteStructuralFetchCapped(count = 1): void {
    this.structuralFetchCapped += Math.max(0, Math.floor(count));
  }

  noteStructuralBatchResult(result: {
    requests: number;
    requestedMints: readonly string[];
    resolvedMints: readonly string[];
    missedMints: readonly string[];
    errorMints: readonly string[];
  }): void {
    this.structuralBatchRequests += result.requests;
    this.structuralMintsRequested += result.requestedMints.length;
    this.structuralMintsResolved += result.resolvedMints.length;
    this.structuralMintsMissed += result.missedMints.length;
    this.structuralErrorBackoffs += result.errorMints.length;
  }

  noteStructuralBatchError(mints: number): void {
    this.structuralBatchRequests += 1;
    this.structuralMintsRequested += Math.max(0, mints);
    this.structuralErrorBackoffs += Math.max(0, mints);
  }

  noteStructuralBatchCapHit(count = 1): void {
    this.structuralBatchCapHits += Math.max(0, count);
  }

  hasPendingSignal(mint: string, nowMs: number, graceMs = 0): boolean {
    return this.pendingSampleDecision(mint, nowMs, graceMs, Number.MAX_SAFE_INTEGER) !== 'none';
  }

  pendingSampleDecision(
    mint: string,
    nowMs: number,
    graceMs: number,
    maxMints: number,
  ): 'pending' | 'limitRejected' | 'none' {
    this.refreshPendingMintCache(nowMs, graceMs, maxMints);
    const cache = this.pendingMintCache!;
    if (cache.selected.has(mint)) return 'pending';
    if (cache.all.has(mint)) return 'limitRejected';
    return 'none';
  }

  pendingMints(nowMs: number, graceMs: number, maxMints: number): ReadonlySet<string> {
    this.refreshPendingMintCache(nowMs, graceMs, maxMints);
    return this.pendingMintCache!.selected;
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

  private pruneSignalTimes(lane: MildDipTapeLane, nowMs: number): void {
    const cut = nowMs - 60 * 60_000;
    const times = this.signalTimes.get(lane)!;
    while (times.length > 0 && times[0]! <= cut) times.shift();
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
