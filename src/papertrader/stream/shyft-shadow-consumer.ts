/**
 * Shyft Yellowstone gRPC shadow consumer (Stage 1.1, 1.11.467).
 *
 * Observability-only: one gRPC consumer for the whole live-oscar process. Subscribes to swap
 * transactions for the **watched/open** mint set with NARROW `accountInclude` filters (the watched
 * mints — never a program-wide firehose, to avoid loading the shared Shyft Build account / superbot).
 * Per swap tx it derives a USD price from the pool vault reserves in `postTokenBalances` and stores it
 * as the in-memory last stream price for that mint (read at the entry / MTM comparison points).
 *
 * The stream price NEVER feeds a trading gate / eval / execution decision in Stage 1.1.
 *
 * Dependency: `@triton-one/yellowstone-grpc` (Yellowstone gRPC NAPI client).
 */
import * as YellowstoneGrpc from '@triton-one/yellowstone-grpc';
import { CommitmentLevel, txEncode } from '@triton-one/yellowstone-grpc';
import type ClientType from '@triton-one/yellowstone-grpc';
import type {
  SubscribeRequest,
  SubscribeUpdate,
  SubscribeUpdateTransactionInfo,
} from '@triton-one/yellowstone-grpc';
import { getSolUsd } from '../pricing.js';
import { extractStreamPoolPriceUsd, type ShadowTokenBalance } from './shadow-price.js';
import {
  DEFAULT_CIRCUIT_COOLDOWN_MS,
  DEFAULT_CIRCUIT_FAST_FAILS,
  DEFAULT_CIRCUIT_FAST_FAIL_WINDOW_MS,
  DEFAULT_STABLE_BEFORE_BACKOFF_RESET_MS,
  FAST_FAIL_MAX_SESSION_MS,
  isSingleMintSetChange,
  ShyftStreamCircuitBreaker,
} from './shyft-shadow-resilience.js';
import {
  getShyftShadowWatchedMints,
  onShyftShadowMintsChanged,
  recordShyftShadowStreamPrice,
} from './shadow-state.js';

/**
 * Resolve the Yellowstone `Client` constructor robustly across CJS/ESM interop shapes.
 *
 * `@triton-one/yellowstone-grpc@5` ships dual CJS/ESM builds. Under tsx/esbuild the default
 * export arrives double-wrapped (the namespace's `default` is the CJS `module.exports`, whose
 * own `default` is the class), so a plain `import Client from ...` yields a non-constructable
 * object ("Client is not a constructor"). Unwrap nested `default` layers until we hit the class.
 */
type YellowstoneClientCtor = new (
  endpoint: string,
  xToken: string | undefined,
  channelOptions: unknown,
  reconnectOptions?: { enabled?: boolean },
) => ClientType;

function resolveYellowstoneClientCtor(): YellowstoneClientCtor {
  const ns = YellowstoneGrpc as Record<string, unknown>;
  let candidate: unknown = ns.default ?? (ns as { Client?: unknown }).Client ?? ns;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof candidate === 'function') return candidate as YellowstoneClientCtor;
    if (candidate && typeof candidate === 'object' && 'default' in (candidate as object)) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    break;
  }
  throw new Error('yellowstone-grpc Client constructor not found (CJS/ESM interop)');
}

/**
 * Lazily resolved (and memoized) so any interop failure surfaces inside the flag-gated connect
 * loop — caught by its try/catch + backoff — and never throws at module load (process-safe).
 */
let cachedYellowstoneClientCtor: YellowstoneClientCtor | null = null;
function getYellowstoneClientCtor(): YellowstoneClientCtor {
  if (!cachedYellowstoneClientCtor) {
    cachedYellowstoneClientCtor = resolveYellowstoneClientCtor();
  }
  return cachedYellowstoneClientCtor;
}

const FILTER_NAME = 'live_oscar_shadow';
/** Valid base58 pubkey that effectively never appears in DEX swaps — used as a "match nothing" filter. */
const SENTINEL_NO_MATCH = '1nc1nerator11111111111111111111111111111111';
const DEFAULT_MAX_ACCOUNT_INCLUDE = 256;
/** Avoid reconnect storm when Shyft drops the stream (~2s cycle on prod without this). */
const DEFAULT_RECONNECT_INITIAL_MS = 5_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
/** Debounce mint-set churn — full reconnect instead of in-flight stream.write (causes receive failed). */
const RESUBSCRIBE_DEBOUNCE_MS = 3_000;
/** After connect, ignore mint-set resubscribes for this long (boot churn → reconnect storm). */
const DEFAULT_CONNECT_GRACE_MS = 15_000;
/** Connected but no swap-derived price for this long → tear down and reconnect. */
const DEFAULT_STALE_STREAM_MS = 5 * 60_000;
const STALE_CHECK_INTERVAL_MS = 30_000;

type StreamStatus =
  | 'connecting'
  | 'connected'
  | 'end'
  | 'error'
  | 'decode_error'
  | 'closed'
  | 'circuit_open';

export interface ShyftStreamHealthSnapshot {
  status: StreamStatus | 'idle';
  detail: string | null;
  watchedMintCount: number;
  reconnectCount: number;
  lastObservationMs: number | null;
  connectedSinceMs: number | null;
  observationsTotal: number;
}

let healthStatus: ShyftStreamHealthSnapshot['status'] = 'idle';
let healthDetail: string | null = null;
let healthReconnectCount = 0;
let healthLastObservationMs: number | null = null;
let healthConnectedSinceMs: number | null = null;
let healthObservationsTotal = 0;

function refreshHealthSnapshot(): ShyftStreamHealthSnapshot {
  return {
    status: healthStatus,
    detail: healthDetail,
    watchedMintCount: getShyftShadowWatchedMints().length,
    reconnectCount: healthReconnectCount,
    lastObservationMs: healthLastObservationMs,
    connectedSinceMs: healthConnectedSinceMs,
    observationsTotal: healthObservationsTotal,
  };
}

/** Read-only health snapshot for `live_shyft_stream_health` journal rows. */
export function getShyftStreamHealthSnapshot(): ShyftStreamHealthSnapshot {
  return refreshHealthSnapshot();
}

/** Test-only reset. */
export function __resetShyftStreamHealthForTests(): void {
  healthStatus = 'idle';
  healthDetail = null;
  healthReconnectCount = 0;
  healthLastObservationMs = null;
  healthConnectedSinceMs = null;
  healthObservationsTotal = 0;
}

export interface ShyftShadowConsumerConfig {
  endpoint: string;
  token: string;
  maxAccountInclude?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  /** After connect, suppress mint-set resubscribes for this many ms (0 = disabled). */
  connectGraceMs?: number;
  /** Reconnect when connected but no prices observed for this many ms (0 = disabled). */
  staleStreamMs?: number;
  /** Reset reconnect backoff only after first observation or this many ms stable (0 = first obs only). */
  stableBeforeBackoffResetMs?: number;
  circuitFastFails?: number;
  circuitFastFailWindowMs?: number;
  circuitCooldownMs?: number;
}

export interface ShyftShadowConsumerCallbacks {
  /** Status transitions (connect/reconnect/end) — wire to a JSONL metric. */
  onStatus?: (status: StreamStatus, detail?: string) => void;
  onError?: (err: unknown) => void;
  /** Per stored stream observation — diagnostics only. */
  onObservation?: (mint: string, priceUsd: number, streamTsMs: number) => void;
  /** Periodic / transition health snapshot (`live_shyft_stream_health`). */
  onHealth?: (snapshot: ShyftStreamHealthSnapshot) => void;
}

export interface ShyftShadowConsumerHandle {
  close(): void;
}

/** Minimal parsed-tx view of the JsonParsed `txEncode.encode` output. */
interface ParsedTxView {
  meta?: { postTokenBalances?: readonly ShadowTokenBalance[] | null } | null;
}

type WritableStream = { write: (r: SubscribeRequest) => void; end: () => void };

const encodeJsonParsed = txEncode.encode as unknown as (
  info: SubscribeUpdateTransactionInfo,
  encoding: number,
  maxSupportedTransactionVersion: number | undefined,
  showRewards: boolean,
) => ParsedTxView;

function emptyRequest(): SubscribeRequest {
  return {
    accounts: {},
    slots: {},
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };
}

function buildSubscribeRequest(mints: string[], maxAccountInclude: number): SubscribeRequest {
  const accountInclude = mints.length > 0 ? mints.slice(0, maxAccountInclude) : [SENTINEL_NO_MATCH];
  return {
    ...emptyRequest(),
    transactions: {
      [FILTER_NAME]: {
        vote: false,
        failed: false,
        accountInclude,
        accountExclude: [],
        accountRequired: [],
      },
    },
  };
}

function pingRequest(): SubscribeRequest {
  return { ...emptyRequest(), ping: { id: 1 } };
}

/** Start the single live-oscar shadow consumer. Returns a handle whose `close()` stops reconnects. */
export function startShyftShadowConsumer(
  cfg: ShyftShadowConsumerConfig,
  cb: ShyftShadowConsumerCallbacks = {},
): ShyftShadowConsumerHandle {
  const maxAccountInclude = cfg.maxAccountInclude ?? DEFAULT_MAX_ACCOUNT_INCLUDE;
  const reconnectMaxMs = cfg.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  const reconnectInitialMs = cfg.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
  const connectGraceMs = cfg.connectGraceMs ?? DEFAULT_CONNECT_GRACE_MS;
  const staleStreamMs = cfg.staleStreamMs ?? DEFAULT_STALE_STREAM_MS;
  const stableBeforeBackoffResetMs =
    cfg.stableBeforeBackoffResetMs ?? DEFAULT_STABLE_BEFORE_BACKOFF_RESET_MS;
  const circuit = new ShyftStreamCircuitBreaker(
    cfg.circuitFastFails ?? DEFAULT_CIRCUIT_FAST_FAILS,
    cfg.circuitFastFailWindowMs ?? DEFAULT_CIRCUIT_FAST_FAIL_WINDOW_MS,
    cfg.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS,
  );

  let closed = false;
  let backoff = reconnectInitialMs;
  let connectLoopStarted = false;
  let activeStream: WritableStream | null = null;
  /** Stream handle allowed to accept writes (ping / in-place resubscribe). Cleared before end(). */
  let writableStream: WritableStream | null = null;
  let resubscribeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let connectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResubscribeAfterGrace = false;
  let lastObservationMs = 0;
  let connectedAtMs = 0;
  let subscribedMints: string[] = [];
  let sessionBackoffReset = false;
  let stableBackoffTimer: ReturnType<typeof setTimeout> | null = null;

  function clearConnectGraceTimer(): void {
    if (connectGraceTimer) {
      clearTimeout(connectGraceTimer);
      connectGraceTimer = null;
    }
  }

  function clearStableBackoffTimer(): void {
    if (stableBackoffTimer) {
      clearTimeout(stableBackoffTimer);
      stableBackoffTimer = null;
    }
  }

  function emitHealth(): void {
    cb.onHealth?.(refreshHealthSnapshot());
  }

  function noteStatus(status: StreamStatus, detail?: string): void {
    healthStatus = status;
    healthDetail = detail ?? null;
    if (status === 'connected') {
      healthConnectedSinceMs = Date.now();
    } else if (
      status === 'end' ||
      status === 'error' ||
      status === 'closed' ||
      status === 'circuit_open'
    ) {
      healthConnectedSinceMs = null;
    }
    cb.onStatus?.(status, detail);
    emitHealth();
  }

  function maybeResetBackoff(_reason: 'observation' | 'stable_timer'): void {
    if (sessionBackoffReset) return;
    sessionBackoffReset = true;
    clearStableBackoffTimer();
    backoff = reconnectInitialMs;
    circuit.reset();
  }

  function armStableBackoffTimer(): void {
    clearStableBackoffTimer();
    if (stableBeforeBackoffResetMs <= 0) return;
    stableBackoffTimer = setTimeout(() => {
      stableBackoffTimer = null;
      if (closed || !writableStream) return;
      maybeResetBackoff('stable_timer');
    }, stableBeforeBackoffResetMs);
    if (typeof stableBackoffTimer.unref === 'function') stableBackoffTimer.unref();
  }

  function invalidateWritableStream(): void {
    writableStream = null;
  }

  function safeStreamWrite(req: SubscribeRequest): boolean {
    const stream = writableStream;
    if (!stream || stream !== activeStream) return false;
    try {
      stream.write(req);
      return true;
    } catch {
      invalidateWritableStream();
      return false;
    }
  }

  function scheduleResubscribe(reason: string): void {
    if (closed || !activeStream) return;
    invalidateWritableStream();
    healthReconnectCount += 1;
    noteStatus('error', reason);
    try {
      activeStream.end();
    } catch {
      /* ignore */
    }
  }

  function queueMintSetResubscribe(): void {
    if (closed || !activeStream) return;
    const sinceConnect = Date.now() - connectedAtMs;
    if (connectedAtMs > 0 && connectGraceMs > 0 && sinceConnect < connectGraceMs) {
      pendingResubscribeAfterGrace = true;
      return;
    }
    if (resubscribeDebounceTimer) clearTimeout(resubscribeDebounceTimer);
    resubscribeDebounceTimer = setTimeout(() => {
      resubscribeDebounceTimer = null;
      if (closed || !activeStream) return;

      const newMints = getShyftShadowWatchedMints().slice(0, maxAccountInclude);
      const streamStable =
        lastObservationMs > 0 &&
        connectedAtMs > 0 &&
        Date.now() - connectedAtMs >= Math.min(connectGraceMs, stableBeforeBackoffResetMs);

      if (
        streamStable &&
        writableStream &&
        isSingleMintSetChange(subscribedMints, newMints)
      ) {
        if (safeStreamWrite(buildSubscribeRequest(newMints, maxAccountInclude))) {
          subscribedMints = [...newMints];
          noteStatus('connected', `in_place_mint_update mints=${newMints.length}`);
          return;
        }
      }

      scheduleResubscribe('resubscribe_mint_set_changed');
    }, RESUBSCRIBE_DEBOUNCE_MS);
    if (typeof resubscribeDebounceTimer.unref === 'function') resubscribeDebounceTimer.unref();
  }

  function armConnectGraceTimer(): void {
    clearConnectGraceTimer();
    pendingResubscribeAfterGrace = false;
    if (connectGraceMs <= 0) return;
    connectGraceTimer = setTimeout(() => {
      connectGraceTimer = null;
      if (closed || !activeStream) return;
      if (pendingResubscribeAfterGrace) {
        pendingResubscribeAfterGrace = false;
        queueMintSetResubscribe();
      }
    }, connectGraceMs);
    if (typeof connectGraceTimer.unref === 'function') connectGraceTimer.unref();
  }

  function recordSessionFailure(sessionStartedMs: number, errMsg: string): void {
    const sessionMs = Date.now() - sessionStartedMs;
    if (sessionMs <= FAST_FAIL_MAX_SESSION_MS) {
      const tripped = circuit.recordFastFail();
      if (tripped) {
        noteStatus('circuit_open', `fast_fail_cooldown ${Math.round(circuit.remainingMs() / 1000)}s`);
      }
    }
    noteStatus('error', errMsg);
  }

  function startConnectLoop(): void {
    if (connectLoopStarted || closed) return;
    connectLoopStarted = true;
    void (async () => {
      while (!closed) {
        if (circuit.isOpen()) {
          const wait = circuit.remainingMs();
          noteStatus('circuit_open', `cooldown ${Math.round(wait / 1000)}s remaining`);
          await delay(wait);
          continue;
        }

        const mints = getShyftShadowWatchedMints();
        if (mints.length === 0) {
          await delay(reconnectInitialMs);
          continue;
        }
        const sessionStartedMs = Date.now();
        try {
          await connectOnce();
        } catch (err) {
          healthReconnectCount += 1;
          const msg = err instanceof Error ? err.message : String(err);
          recordSessionFailure(sessionStartedMs, msg);
          cb.onError?.(err);
        }
        if (closed) break;
        const jitter = Math.floor(Math.random() * Math.min(2_000, backoff));
        await delay(backoff + jitter);
        backoff = Math.min(backoff * 2, reconnectMaxMs);
      }
    })();
  }

  // Defer connect until first non-empty mint set; debounced resubscribe on later changes.
  onShyftShadowMintsChanged((mints) => {
    if (mints.length > 0 && !connectLoopStarted) {
      startConnectLoop();
      return;
    }
    queueMintSetResubscribe();
  });

  function handleUpdate(update: SubscribeUpdate): void {
    if (update.ping) {
      safeStreamWrite(pingRequest());
      return;
    }
    const info = update.transaction?.transaction;
    if (!info) return;
    const slot = Number(update.transaction?.slot ?? 0);
    const streamTsMs = Date.now();

    let parsed: ParsedTxView;
    try {
      parsed = encodeJsonParsed(info, 4 /* WasmUiTransactionEncoding.JsonParsed */, 0, false);
    } catch {
      noteStatus('decode_error');
      return;
    }
    const balances = parsed.meta?.postTokenBalances;
    if (!balances || balances.length === 0) return;

    const watchedSet = new Set(getShyftShadowWatchedMints());
    if (watchedSet.size === 0) return;
    const solUsd = getSolUsd();
    const seen = new Set<string>();
    for (const b of balances) {
      const mint = b?.mint ?? undefined;
      if (!mint || seen.has(mint) || !watchedSet.has(mint)) continue;
      seen.add(mint);
      const px = extractStreamPoolPriceUsd(balances, mint, solUsd);
      if (!px) continue;
      lastObservationMs = streamTsMs;
      healthLastObservationMs = streamTsMs;
      healthObservationsTotal += 1;
      maybeResetBackoff('observation');
      recordShyftShadowStreamPrice(mint, {
        priceUsd: px.priceUsd,
        streamTsMs,
        slot: Number.isFinite(slot) && slot > 0 ? slot : null,
      });
      cb.onObservation?.(mint, px.priceUsd, streamTsMs);
    }
  }

  async function connectOnce(): Promise<void> {
    const mints = getShyftShadowWatchedMints();
    if (mints.length === 0) return;

    noteStatus('connecting', cfg.endpoint);
    const YellowstoneClient = getYellowstoneClientCtor();
    const client = new YellowstoneClient(cfg.endpoint, cfg.token, undefined, { enabled: false });
    await client.connect();
    const stream = await client.subscribe(buildSubscribeRequest(mints, maxAccountInclude));
    activeStream = stream;
    writableStream = stream;
    subscribedMints = mints.slice(0, maxAccountInclude);
    sessionBackoffReset = false;
    connectedAtMs = Date.now();
    lastObservationMs = 0;
    armConnectGraceTimer();
    armStableBackoffTimer();
    noteStatus('connected', `${cfg.endpoint} mints=${mints.length}`);

    await new Promise<void>((resolve) => {
      let settled = false;
      const sessionStartedMs = connectedAtMs;
      const done = (errMsg?: string): void => {
        if (settled) return;
        settled = true;
        invalidateWritableStream();
        clearStableBackoffTimer();
        if (staleTimer) clearInterval(staleTimer);
        if (healthTimer) clearInterval(healthTimer);
        if (errMsg) recordSessionFailure(sessionStartedMs, errMsg);
        resolve();
      };
      const healthTimer = setInterval(() => emitHealth(), 60_000);
      if (typeof healthTimer.unref === 'function') healthTimer.unref();
      const staleTimer =
        staleStreamMs > 0
          ? setInterval(() => {
              if (closed) return;
              const now = Date.now();
              const sinceConnect = now - connectedAtMs;
              if (sinceConnect < staleStreamMs) return;
              if (lastObservationMs > 0) {
                if (now - lastObservationMs < staleStreamMs) return;
              }
              scheduleResubscribe('stale_no_prices');
              done();
            }, STALE_CHECK_INTERVAL_MS)
          : null;
      if (staleTimer && typeof staleTimer.unref === 'function') staleTimer.unref();

      stream.on('data', (update: SubscribeUpdate) => {
        try {
          handleUpdate(update);
        } catch (err) {
          cb.onError?.(err);
        }
      });
      stream.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        healthReconnectCount += 1;
        done(msg);
        cb.onError?.(err);
      });
      stream.on('end', () => {
        noteStatus('end');
        done();
      });
      stream.on('close', () => done());
    });

    activeStream = null;
    invalidateWritableStream();
    try {
      stream.end();
    } catch {
      /* ignore */
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      if (typeof t.unref === 'function') t.unref();
    });
  }

  if (getShyftShadowWatchedMints().length > 0) {
    startConnectLoop();
  }

  return {
    close(): void {
      closed = true;
      if (resubscribeDebounceTimer) clearTimeout(resubscribeDebounceTimer);
      clearConnectGraceTimer();
      clearStableBackoffTimer();
      onShyftShadowMintsChanged(null);
      invalidateWritableStream();
      noteStatus('closed');
      try {
        activeStream?.end();
      } catch {
        /* ignore */
      }
      activeStream = null;
    },
  };
}
