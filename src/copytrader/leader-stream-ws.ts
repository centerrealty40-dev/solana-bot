/**
 * Helius LaserStream WebSocket ingress for the leader wallet.
 *
 * Uses `transactionSubscribe` (Business+) with `accountInclude` = leader.
 * Falls back to standard `logsSubscribe` + mentions if transactionSubscribe
 * is rejected. Poll remains a safety net in main.
 */
import WebSocket from 'ws';

export type LeaderStreamHandlers = {
  onSignature: (signature: string, meta?: { source: 'transactionSubscribe' | 'logsSubscribe' }) => void;
  onStatus?: (msg: string, detail?: Record<string, unknown>) => void;
};

export type LeaderStreamOptions = {
  wsUrl: string;
  leaderWallet: string;
  /** Prefer Helius extension; set false to force logsSubscribe. */
  preferTransactionSubscribe?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
};

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function asSigString(v: unknown): string | null {
  if (typeof v === 'string' && v.length >= 64) return v;
  return null;
}

/** Pull base58 signature from Helius/Agave transactionNotification / logsNotification. */
export function extractSignature(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  const direct = asSigString(o.signature);
  if (direct) return direct;

  // Helius: result.transaction.transaction.signatures[0] or result.transaction.signature
  const txWrap = o.transaction;
  if (txWrap && typeof txWrap === 'object') {
    const tw = txWrap as Record<string, unknown>;
    const fromWrap = asSigString(tw.signature);
    if (fromWrap) return fromWrap;
    const inner = tw.transaction;
    if (inner && typeof inner === 'object') {
      const inn = inner as Record<string, unknown>;
      const sigs = inn.signatures;
      if (Array.isArray(sigs)) {
        const s0 = asSigString(sigs[0]);
        if (s0) return s0;
      }
    }
    const sigs = tw.signatures;
    if (Array.isArray(sigs)) {
      const s0 = asSigString(sigs[0]);
      if (s0) return s0;
    }
  }

  const value = o.value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const fromVal = asSigString(v.signature);
    if (fromVal) return fromVal;
  }
  return null;
}

export class LeaderWalletStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private nextId = 1;
  private reconnectMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private subMode: 'transactionSubscribe' | 'logsSubscribe' | null = null;
  private pendingSubId: number | null = null;

  constructor(
    private readonly opts: LeaderStreamOptions,
    private readonly handlers: LeaderStreamHandlers,
  ) {
    this.reconnectMs = opts.reconnectMinMs ?? 1_000;
  }

  start(): void {
    this.stopped = false;
    void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  get mode(): typeof this.subMode {
    return this.subMode;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.reconnectMs = this.opts.reconnectMinMs ?? 1_000;
      } catch (e) {
        this.handlers.onStatus?.('ws_cycle_error', { err: String(e) });
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, jitter(this.reconnectMs)));
      this.reconnectMs = Math.min(
        this.reconnectMs * 2,
        this.opts.reconnectMaxMs ?? 30_000,
      );
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.wsUrl);
      this.ws = ws;
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        ws.removeAllListeners();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (this.ws === ws) this.ws = null;
        this.subMode = null;
      };

      ws.on('open', () => {
        this.handlers.onStatus?.('ws_open', { urlHost: safeHost(this.opts.wsUrl) });
        const preferTx = this.opts.preferTransactionSubscribe !== false;
        if (preferTx) this.subscribeTransaction(ws);
        else this.subscribeLogs(ws);
        this.pingTimer = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
          } catch {
            /* ignore */
          }
        }, 20_000);
      });

      ws.on('message', (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (msg.error && this.pendingSubId != null && msg.id === this.pendingSubId) {
          const errObj = msg.error as { message?: string; code?: number };
          this.handlers.onStatus?.('subscribe_error', {
            mode: this.subMode,
            message: errObj.message,
            code: errObj.code,
          });
          // Fall back once from transactionSubscribe → logsSubscribe.
          if (this.subMode === 'transactionSubscribe') {
            this.pendingSubId = null;
            this.subscribeLogs(ws);
            return;
          }
          fail(new Error(errObj.message || 'subscribe failed'));
          return;
        }

        if (typeof msg.result === 'number' && msg.id === this.pendingSubId) {
          this.handlers.onStatus?.('subscribed', {
            mode: this.subMode,
            subscriptionId: msg.result,
          });
          this.pendingSubId = null;
          return;
        }

        if (msg.method === 'transactionNotification' || msg.method === 'logsNotification') {
          const params = msg.params as { result?: unknown } | undefined;
          const sig = extractSignature(params?.result ?? params);
          if (sig) {
            this.handlers.onSignature(sig, {
              source: msg.method === 'transactionNotification' ? 'transactionSubscribe' : 'logsSubscribe',
            });
          } else {
            this.handlers.onStatus?.('notify_no_signature', { method: msg.method });
          }
        }
      });

      ws.on('close', () => {
        cleanup();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('error', (err) => {
        this.handlers.onStatus?.('ws_error', { err: String(err) });
        if (!settled) fail(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private subscribeTransaction(ws: WebSocket): void {
    this.subMode = 'transactionSubscribe';
    const id = this.nextId++;
    this.pendingSubId = id;
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'transactionSubscribe',
        params: [
          {
            vote: false,
            failed: false,
            accountInclude: [this.opts.leaderWallet],
            accountExclude: [],
            accountRequired: [],
            // Critical: leader swaps usually touch ATAs, not the wallet pubkey directly.
            tokenAccounts: 'balanceChanged',
          },
          {
            commitment: 'processed',
            encoding: 'jsonParsed',
            transactionDetails: 'full',
            showRewards: false,
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    );
  }

  private subscribeLogs(ws: WebSocket): void {
    this.subMode = 'logsSubscribe';
    const id = this.nextId++;
    this.pendingSubId = id;
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'logsSubscribe',
        params: [
          { mentions: [this.opts.leaderWallet] },
          { commitment: 'confirmed' },
        ],
      }),
    );
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'bad-url';
  }
}

/** Build Helius WS URL from env without printing the key. */
export function resolveLeaderStreamWsUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit =
    env.COPY_TRADER_LEADER_STREAM_WS_URL?.trim() ||
    env.HELIUS_WS_URL?.trim() ||
    '';
  if (explicit) return explicit;
  const key = env.HELIUS_API_KEY?.trim() || '';
  if (!key) return null;
  // LaserStream WebSocket unified endpoint (Business+ for transactionSubscribe).
  return `wss://mainnet.helius-rpc.com/?api-key=${key}`;
}
