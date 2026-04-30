import WebSocket from 'ws';
import type { StreamConfig } from './config.js';
import { child } from '../core/logger.js';

const log = child('sa-stream-ws');

export type LogNotification = {
  programId: string;
  signature: string;
  slot: number;
  err: unknown | null;
  logs: string[];
  payload: Record<string, unknown>;
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

function jitter(ms: number): number {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

export class LogsWsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private nextRpcId = 1;
  private readonly subToProgram = new Map<number, string>();
  private readonly pendingReq = new Map<number, string>();
  private reconnectMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: StreamConfig,
    private readonly onLog: (n: LogNotification) => void,
  ) {
    this.reconnectMs = cfg.reconnectMinMs;
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
        this.reconnectMs = this.cfg.reconnectMinMs;
      } catch (e) {
        log.warn({ err: String(e) }, 'sa-stream ws cycle error');
      }
      if (this.stopped) break;
      const wait = jitter(Math.min(this.cfg.reconnectMaxMs, Math.max(this.cfg.reconnectMinMs, this.reconnectMs)));
      log.info({ wait_ms: wait }, 'sa-stream reconnecting after backoff');
      await new Promise((r) => setTimeout(r, wait));
      this.reconnectMs = Math.min(this.cfg.reconnectMaxMs, this.reconnectMs * 2);
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.cfg.rpcWsUrl;
      const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        log.info({ url: hostOnly(url) }, 'sa-stream websocket open');
        this.subToProgram.clear();
        this.pendingReq.clear();
        for (const programId of this.cfg.programIds) {
          const id = this.nextRpcId++;
          this.pendingReq.set(id, programId);
          const req = {
            jsonrpc: '2.0',
            id,
            method: 'logsSubscribe',
            params: [{ mentions: [programId] }, { commitment: this.cfg.commitment }],
          };
          ws.send(JSON.stringify(req));
        }
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

        if (msg.id !== undefined && this.pendingReq.has(msg.id)) {
          const programId = this.pendingReq.get(msg.id)!;
          this.pendingReq.delete(msg.id);
          if (msg.error) {
            log.error({ programId, err: msg.error }, 'logsSubscribe error');
            return;
          }
          const subId = typeof msg.result === 'number' ? msg.result : Number(msg.result);
          if (!Number.isFinite(subId)) {
            log.error({ programId, result: msg.result }, 'unexpected subscribe result');
            return;
          }
          this.subToProgram.set(subId, programId);
          log.info({ programId, subscriptionId: subId }, 'logsSubscribe ok');
          return;
        }

        if (msg.method === 'logsNotification' && msg.params?.subscription !== undefined) {
          const programId = this.subToProgram.get(msg.params.subscription);
          if (!programId) return;
          const res = msg.params.result;
          const slot = res?.context?.slot ?? 0;
          if (!Number.isFinite(slot) || slot <= 0) return;
          const sig = res?.value?.signature;
          if (!sig || typeof sig !== 'string') return;
          const logsArr = res?.value?.logs ?? [];
          const logs = Array.isArray(logsArr) ? logsArr.map(String) : [];
          const err = res?.value?.err ?? null;
          this.onLog({
            programId,
            signature: sig,
            slot,
            err,
            logs,
            payload: {
              context: res?.context ?? {},
              value: res?.value ?? {},
            },
          });
        }
      });

      ws.on('close', (code, reason) => {
        log.warn({ code, reason: reason.toString() }, 'sa-stream websocket closed');
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
        log.warn({ err: String(err) }, 'sa-stream websocket error');
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }
}

function hostOnly(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    return `${u.protocol}//${u.host}/`;
  } catch {
    return '(invalid-url)';
  }
}
