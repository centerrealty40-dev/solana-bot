import WebSocket from 'ws';

import type { HlWsTwapOpenEvent } from './hl-ws-types.js';
import {
  isActiveTwapStatus,
  parseTwapStatesMessage,
  parseUserTwapHistoryMessage,
} from './hl-ws-parse.js';

export type HlWsFeedConfig = {
  url: string;
  whales: string[];
  reconnectMinMs: number;
  reconnectMaxMs: number;
  pingIntervalMs: number;
};

export type HlWsTwapHandler = (event: HlWsTwapOpenEvent) => void;

function jitter(ms: number): number {
  return Math.round(ms * (0.85 + Math.random() * 0.3));
}

function defaultWsUrl(): string {
  return process.env.HL_TWAP_WS_URL?.trim() || 'wss://api.hyperliquid.xyz/ws';
}

export function loadHlWsFeedConfig(whales: string[]): HlWsFeedConfig {
  const reconnectMinMs = Math.max(500, Number(process.env.HL_TWAP_WS_RECONNECT_MIN_MS ?? 1000));
  const reconnectMaxMs = Math.max(reconnectMinMs, Number(process.env.HL_TWAP_WS_RECONNECT_MAX_MS ?? 30_000));
  return {
    url: defaultWsUrl(),
    whales,
    reconnectMinMs,
    reconnectMaxMs,
    pingIntervalMs: Math.max(10_000, Number(process.env.HL_TWAP_WS_PING_MS ?? 25_000)),
  };
}

type HlWsSubscription = { type: string; user: string; dex?: string };

export class HlWsTwapFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectMs: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seenActive = new Set<string>();

  constructor(
    private readonly cfg: HlWsFeedConfig,
    private readonly onTwap: HlWsTwapHandler,
  ) {
    this.reconnectMs = cfg.reconnectMinMs;
  }

  start(): void {
    void this.runLoop();
  }

  stop(): void {
    this.stopped = true;
    this.clearPing();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private subscriptions(): HlWsSubscription[] {
    const subs: HlWsSubscription[] = [];
    for (const user of this.cfg.whales) {
      subs.push({ type: 'userTwapHistory', user });
      subs.push({ type: 'twapStates', user, dex: '' });
    }
    return subs;
  }

  /** Subscribe to a whale discovered via HypurrScan after startup. */
  addWhale(user: string): void {
    const u = user.trim().toLowerCase();
    if (!u.startsWith('0x') || this.cfg.whales.includes(u)) return;
    this.cfg.whales.push(u);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const subscription of [
      { type: 'userTwapHistory', user: u },
      { type: 'twapStates', user: u, dex: '' },
    ]) {
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    }
  }

  seedSyntheticIds(ids: string[]): void {
    for (const id of ids) this.seenActive.add(id);
  }

  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const subscription of this.subscriptions()) {
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription }));
    }
  }

  private dispatchEvents(events: HlWsTwapOpenEvent[]): void {
    for (const ev of events) {
      if (ev.isSnapshot) continue;
      if (!isActiveTwapStatus(ev.status) && ev.channel === 'userTwapHistory') continue;
      const lag = ev.receivedAtMs - ev.startedAtMs;
      if (lag > 120_000) continue;
      if (this.seenActive.has(ev.syntheticId)) continue;
      this.seenActive.add(ev.syntheticId);
      this.onTwap(ev);
    }
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: { channel?: string; data?: unknown };
    try {
      msg = JSON.parse(String(raw)) as { channel?: string; data?: unknown };
    } catch {
      return;
    }
    const receivedAtMs = Date.now();
    if (msg.channel === 'userTwapHistory') {
      this.dispatchEvents(parseUserTwapHistoryMessage(msg.data, receivedAtMs));
      return;
    }
    if (msg.channel === 'twapStates') {
      this.dispatchEvents(parseTwapStatesMessage(msg.data, receivedAtMs));
    }
  }

  private async connectOnce(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.cfg.url);
      this.ws = ws;

      ws.on('open', () => {
        this.reconnectMs = this.cfg.reconnectMinMs;
        this.subscribeAll();
        this.clearPing();
        this.pingTimer = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
          } catch {
            /* ignore */
          }
        }, this.cfg.pingIntervalMs);
        resolve();
      });

      ws.on('message', (data) => this.handleMessage(data));

      ws.on('error', (err) => {
        if (ws.readyState !== WebSocket.OPEN) reject(err);
      });

      ws.on('close', () => {
        this.clearPing();
        if (!this.stopped) resolve();
      });
    });

    while (!this.stopped && this.ws && this.ws.readyState === WebSocket.OPEN) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        this.reconnectMs = this.cfg.reconnectMinMs;
      } catch {
        /* reconnect below */
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, jitter(this.reconnectMs)));
      this.reconnectMs = Math.min(this.cfg.reconnectMaxMs, Math.round(this.reconnectMs * 1.6));
    }
  }
}
