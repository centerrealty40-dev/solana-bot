import WebSocket from 'ws';

export type LeaderWsNotification = {
  signature: string;
  slot: number;
  err: unknown | null;
};

type RpcResponse = {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: {
    subscription?: number;
    result?: {
      context?: { slot?: number };
      value?: {
        signature?: string | null;
        err?: unknown | null;
        logs?: string[] | null;
      };
    };
  };
};

export type LeaderWalletWsOptions = {
  wsUrl: string;
  wallet: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  onSignature: (n: LeaderWsNotification) => void;
  onStatus?: (event: 'open' | 'close' | 'subscribed' | 'error', detail?: string) => void;
};

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function hostOnly(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '(invalid-url)';
  }
}

/** `logsSubscribe` on leader wallet — push tx signatures without HTTP poll. */
export class LeaderWalletWsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private nextRpcId = 1;
  private subscriptionId: number | null = null;
  private reconnectMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: LeaderWalletWsOptions) {
    this.reconnectMs = opts.reconnectMinMs ?? 1000;
  }

  start(): void {
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

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.reconnectMs = this.opts.reconnectMinMs ?? 1000;
      } catch {
        this.opts.onStatus?.('error', 'connect cycle failed');
      }
      if (this.stopped) break;
      const cap = this.opts.reconnectMaxMs ?? 30_000;
      const wait = jitter(Math.min(cap, Math.max(this.opts.reconnectMinMs ?? 1000, this.reconnectMs)));
      await new Promise((r) => setTimeout(r, wait));
      this.reconnectMs = Math.min(cap, this.reconnectMs * 2);
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.opts.wsUrl;
      const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
      this.ws = ws;
      let settled = false;
      const subReqId = this.nextRpcId++;

      ws.on('open', () => {
        this.opts.onStatus?.('open', hostOnly(url));
        this.subscriptionId = null;
        const req = {
          jsonrpc: '2.0',
          id: subReqId,
          method: 'logsSubscribe',
          params: [
            { mentions: [this.opts.wallet] },
            { commitment: this.opts.commitment ?? 'confirmed' },
          ],
        };
        ws.send(JSON.stringify(req));
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
          } catch {
            /* ignore */
          }
        }, 25_000);
      });

      ws.on('message', (data) => {
        let msg: RpcResponse;
        try {
          msg = JSON.parse(data.toString()) as RpcResponse;
        } catch {
          return;
        }

        if (msg.id === subReqId) {
          if (msg.error) {
            this.opts.onStatus?.('error', msg.error.message ?? 'logsSubscribe failed');
            return;
          }
          const subId = typeof msg.result === 'number' ? msg.result : Number(msg.result);
          if (Number.isFinite(subId)) {
            this.subscriptionId = subId;
            this.opts.onStatus?.('subscribed', String(subId));
          }
          return;
        }

        if (msg.method !== 'logsNotification' || msg.params?.subscription !== this.subscriptionId) return;
        const res = msg.params.result;
        const slot = res?.context?.slot ?? 0;
        const sig = res?.value?.signature;
        if (!sig || typeof sig !== 'string') return;
        this.opts.onSignature({
          signature: sig,
          slot: Number.isFinite(slot) ? slot : 0,
          err: res?.value?.err ?? null,
        });
      });

      ws.on('close', (code, reason) => {
        this.opts.onStatus?.('close', `${code} ${reason.toString()}`);
        if (this.pingTimer) {
          clearInterval(this.pingTimer);
          this.pingTimer = null;
        }
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('error', (err) => {
        this.opts.onStatus?.('error', String(err));
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }
}
