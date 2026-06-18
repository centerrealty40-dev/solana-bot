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
const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

type StreamStatus = 'connecting' | 'connected' | 'end' | 'error' | 'decode_error' | 'closed';

export interface ShyftShadowConsumerConfig {
  endpoint: string;
  token: string;
  maxAccountInclude?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
}

export interface ShyftShadowConsumerCallbacks {
  /** Status transitions (connect/reconnect/end) — wire to a JSONL metric. */
  onStatus?: (status: StreamStatus, detail?: string) => void;
  onError?: (err: unknown) => void;
  /** Per stored stream observation — diagnostics only. */
  onObservation?: (mint: string, priceUsd: number, streamTsMs: number) => void;
}

export interface ShyftShadowConsumerHandle {
  close(): void;
}

/** Minimal parsed-tx view of the JsonParsed `txEncode.encode` output. */
interface ParsedTxView {
  meta?: { postTokenBalances?: readonly ShadowTokenBalance[] | null } | null;
}

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

  let closed = false;
  let backoff = reconnectInitialMs;
  let activeStream: { write: (r: SubscribeRequest) => void; end: () => void } | null = null;

  // Push subscription updates onto the live stream when the watched mint set changes (no reconnect).
  onShyftShadowMintsChanged((mints) => {
    if (!activeStream) return;
    try {
      activeStream.write(buildSubscribeRequest(mints, maxAccountInclude));
    } catch (err) {
      cb.onError?.(err);
    }
  });

  function handleUpdate(update: SubscribeUpdate): void {
    if (update.ping) {
      try {
        activeStream?.write(pingRequest());
      } catch {
        /* ignore ping write failures — keepalive is best-effort */
      }
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
      cb.onStatus?.('decode_error');
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
      recordShyftShadowStreamPrice(mint, {
        priceUsd: px.priceUsd,
        streamTsMs,
        slot: Number.isFinite(slot) && slot > 0 ? slot : null,
      });
      cb.onObservation?.(mint, px.priceUsd, streamTsMs);
    }
  }

  async function connectOnce(): Promise<void> {
    cb.onStatus?.('connecting', cfg.endpoint);
    const YellowstoneClient = getYellowstoneClientCtor();
    const client = new YellowstoneClient(cfg.endpoint, cfg.token, undefined, { enabled: false });
    // yellowstone-grpc@5 requires an explicit connect() before subscribe()/unary calls
    // (otherwise: "Client not connected. Call connect() first").
    await client.connect();
    const stream = await client.subscribe(
      buildSubscribeRequest(getShyftShadowWatchedMints(), maxAccountInclude),
    );
    activeStream = stream;
    backoff = reconnectInitialMs;
    cb.onStatus?.('connected', cfg.endpoint);

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stream.on('data', (update: SubscribeUpdate) => {
        try {
          handleUpdate(update);
        } catch (err) {
          cb.onError?.(err);
        }
      });
      stream.on('error', (err: unknown) => {
        cb.onStatus?.('error', err instanceof Error ? err.message : String(err));
        cb.onError?.(err);
        done();
      });
      stream.on('end', () => {
        cb.onStatus?.('end');
        done();
      });
      stream.on('close', () => done());
    });

    activeStream = null;
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

  void (async () => {
    while (!closed) {
      try {
        await connectOnce();
      } catch (err) {
        cb.onStatus?.('error', err instanceof Error ? err.message : String(err));
        cb.onError?.(err);
      }
      if (closed) break;
      const jitter = Math.floor(Math.random() * Math.min(1_000, backoff));
      await delay(backoff + jitter);
      backoff = Math.min(backoff * 2, reconnectMaxMs);
    }
  })();

  return {
    close(): void {
      closed = true;
      onShyftShadowMintsChanged(null);
      cb.onStatus?.('closed');
      try {
        activeStream?.end();
      } catch {
        /* ignore */
      }
      activeStream = null;
    },
  };
}
