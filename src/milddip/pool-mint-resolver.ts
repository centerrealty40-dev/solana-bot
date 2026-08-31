import { child } from '../core/logger.js';
import {
  decodePoolTokenMint,
  PUMPSWAP_POOL_OWNER,
} from './stream-events.js';

const log = child('mild-dip-pool-mint-resolver');

type AccountInfo = {
  owner?: string;
  data?: [string, string] | string;
} | null;

export type PoolMintResolverStats = {
  cacheHits: number;
  queued: number;
  dropped: number;
  resolved: number;
  rejected: number;
  rpcCalls: number;
  rpcErrors: number;
  cacheSize: number;
};

export type FetchPoolAccounts = (pools: string[]) => Promise<AccountInfo[]>;

type Pending = { tsMs: number; signature?: string };

export class PoolMintResolver {
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, Pending[]>();
  private readonly cache = new Map<string, string>();
  private readonly negative = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  private lastErrorLogMs = 0;
  private readonly counters = {
    cacheHits: 0,
    queued: 0,
    dropped: 0,
    resolved: 0,
    rejected: 0,
    rpcCalls: 0,
    rpcErrors: 0,
  };

  private readonly fetchAccounts: FetchPoolAccounts;

  constructor(
    private readonly opts: {
      rpcHttpUrl: string;
      onMint: (mint: string, tsMs: number, signature?: string) => void;
      batchSize?: number;
      batchIntervalMs?: number;
      maxQueue?: number;
      maxCacheEntries?: number;
      negativeTtlMs?: number;
      maxAttempts?: number;
      fetchAccounts?: FetchPoolAccounts;
    },
  ) {
    this.fetchAccounts = opts.fetchAccounts ?? ((pools) => this.fetchViaRpc(pools));
    this.timer = setInterval(() => {
      void this.tick();
    }, Math.max(50, opts.batchIntervalMs ?? 1000));
    this.timer.unref?.();
  }

  enqueue(pool: string, tsMs: number, signature?: string): void {
    if (this.stopped) return;
    const cached = this.cache.get(pool);
    if (cached) {
      this.counters.cacheHits += 1;
      this.opts.onMint(cached, tsMs, signature);
      return;
    }
    const negativeUntil = this.negative.get(pool);
    if (negativeUntil != null) {
      if (negativeUntil > Date.now()) {
        this.counters.dropped += 1;
        return;
      }
      this.negative.delete(pool);
    }
    const existing = this.pending.get(pool);
    if (existing) {
      existing.push({ tsMs, signature });
      this.counters.dropped += 1;
      return;
    }
    if (this.inFlight.has(pool) || this.queue.length >= (this.opts.maxQueue ?? 5000)) {
      this.counters.dropped += 1;
      return;
    }
    this.pending.set(pool, [{ tsMs, signature }]);
    this.queue.push(pool);
    this.counters.queued += 1;
  }

  stats(): PoolMintResolverStats {
    return { ...this.counters, cacheSize: this.cache.size };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.queue.length = 0;
    this.pending.clear();
    this.inFlight.clear();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking || this.queue.length === 0) return;
    this.ticking = true;
    try {
      const batch: string[] = [];
      while (batch.length < (this.opts.batchSize ?? 100) && this.queue.length > 0) {
        const pool = this.queue.shift();
        if (!pool) break;
        batch.push(pool);
        this.inFlight.add(pool);
      }
      if (batch.length === 0) return;
      let accounts: AccountInfo[] | null = null;
      const attempts = Math.max(1, this.opts.maxAttempts ?? 2);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          this.counters.rpcCalls += 1;
          accounts = await this.fetchAccounts(batch);
          break;
        } catch (error) {
          this.counters.rpcErrors += 1;
          if (attempt + 1 >= attempts) {
            this.logError(error);
          }
        }
      }
      if (!accounts) {
        for (const pool of batch) this.reject(pool);
        return;
      }
      for (let i = 0; i < batch.length; i += 1) {
        const pool = batch[i]!;
        const account = accounts[i] ?? null;
        const data = account?.data;
        const bytes =
          Array.isArray(data) && data[1] === 'base64'
            ? Buffer.from(data[0], 'base64')
            : null;
        const mint =
          account?.owner === PUMPSWAP_POOL_OWNER && bytes
            ? decodePoolTokenMint(bytes)
            : null;
        if (mint) this.resolve(pool, mint);
        else this.reject(pool);
      }
    } catch (error) {
      this.logError(error);
      for (const pool of [...this.inFlight]) {
        this.reject(pool);
      }
    } finally {
      this.ticking = false;
    }
  }

  private resolve(pool: string, mint: string): void {
    this.inFlight.delete(pool);
    const items = this.pendingFor(pool);
    this.insertCache(pool, mint);
    this.counters.resolved += 1;
    for (const item of items) {
      this.opts.onMint(mint, item.tsMs, item.signature);
    }
  }

  private reject(pool: string): void {
    this.inFlight.delete(pool);
    this.pending.delete(pool);
    this.negative.set(pool, Date.now() + (this.opts.negativeTtlMs ?? 600_000));
    this.counters.rejected += 1;
  }

  private pendingFor(pool: string): Pending[] {
    // The pending list is removed after the list is captured so callbacks can enqueue safely.
    const items = this.pending.get(pool) ?? [];
    this.pending.delete(pool);
    return items;
  }

  private insertCache(pool: string, mint: string): void {
    this.cache.delete(pool);
    this.cache.set(pool, mint);
    const maxEntries = Math.max(1, this.opts.maxCacheEntries ?? 100_000);
    while (this.cache.size > maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchViaRpc(pools: string[]): Promise<AccountInfo[]> {
    const response = await fetch(this.opts.rpcHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'getMultipleAccounts',
        params: [pools, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    });
    if (!response.ok) throw new Error(`getMultipleAccounts HTTP ${response.status}`);
    const body = (await response.json()) as {
      error?: { message?: string };
      result?: { value?: AccountInfo[] };
    };
    if (body.error) throw new Error(body.error.message ?? 'getMultipleAccounts failed');
    if (!Array.isArray(body.result?.value)) throw new Error('getMultipleAccounts malformed response');
    return body.result.value;
  }

  private logError(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogMs < 60_000) return;
    this.lastErrorLogMs = now;
    log.warn({ err: String(error) }, 'pool mint resolver RPC tick failed');
  }
}
