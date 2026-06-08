/**
 * Stage-0 spike: HL WebSocket TWAP vs HypurrScan detect lag.
 *
 * Logs to HL_TWAP_WS_SPIKE_JSONL (default data/hl-twap/ws-spike.jsonl).
 * Does not trade — compare `detectLagMs` with audit twap_start after 24h.
 *
 * Env:
 * - HL_TWAP_WS_WHALE_LIST — comma-sep addresses (optional)
 * - HL_TWAP_WS_MAX_SUBS=30 — cap when deriving from signals.jsonl
 * - HL_TWAP_WS_URL=wss://api.hyperliquid.xyz/ws
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import { detectLagMs } from '../hyperliquid/twap/hl-ws-parse.js';
import { HlWsTwapFeed, loadHlWsFeedConfig } from '../hyperliquid/twap/hl-ws-feed.js';
import { loadHlWsWhaleList } from '../hyperliquid/twap/hl-ws-whales.js';
import type { HlWsTwapOpenEvent } from '../hyperliquid/twap/hl-ws-types.js';
import { fetchHypurrscanUserTwapFeed } from '../hyperliquid/twap/hypurrscan.js';

const SPIKE_PATH =
  process.env.HL_TWAP_WS_SPIKE_JSONL?.trim() ||
  path.join(process.cwd(), 'data', 'hl-twap', 'ws-spike.jsonl');

const HYPURR_POLL_MS = Math.max(15_000, Number(process.env.HL_TWAP_WS_HYPURR_POLL_MS ?? 30_000));

function appendSpike(row: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(SPIKE_PATH), { recursive: true });
  fs.appendFileSync(SPIKE_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

function logEvent(ev: HlWsTwapOpenEvent): void {
  const lag = detectLagMs(ev.receivedAtMs, ev.startedAtMs);
  const row = {
    event: 'hl_ws_twap',
    ...ev,
    detectLagMs: lag,
  };
  appendSpike(row);
  console.log(
    `[hl-twap-ws-spike] ${ev.channel} ${ev.side} ${ev.coin} user=${ev.user.slice(0, 10)}… lag=${lag ?? '?'}ms snapshot=${ev.isSnapshot ? 1 : 0}`,
  );
}

async function hypurrPollLoop(whales: string[]): Promise<void> {
  const seenHypurr = new Set<string>();
  let seeded = false;
  for (;;) {
    for (const user of whales) {
      try {
        const rows = await fetchHypurrscanUserTwapFeed(user);
        const now = Date.now();
        for (const row of rows) {
          if (row.ended || row.action?.type !== 'twapOrder') continue;
          const key = row.hash;
          if (seenHypurr.has(key)) continue;
          seenHypurr.add(key);
          if (!seeded) continue;
          appendSpike({
            event: 'hypurrscan_twap',
            user,
            hash: row.hash,
            coinAsset: row.action.twap.a,
            startedAtMs: row.time,
            receivedAtMs: now,
            detectLagMs: now - row.time,
          });
          console.log(
            `[hl-twap-ws-spike] hypurrscan user=${user.slice(0, 10)}… hash=${row.hash.slice(0, 12)} lag=${now - row.time}ms`,
          );
        }
      } catch (e) {
        console.warn(`[hl-twap-ws-spike] hypurrscan ${user.slice(0, 10)}…`, String(e));
      }
    }
    if (!seeded) {
      seeded = true;
      console.log(`[hl-twap-ws-spike] hypurrscan seeded ${seenHypurr.size} active twap(s)`);
    }
    await new Promise((r) => setTimeout(r, HYPURR_POLL_MS));
  }
}

async function main(): Promise<void> {
  const whales = loadHlWsWhaleList();
  if (whales.length === 0) {
    console.error('[hl-twap-ws-spike] no whales — set HL_TWAP_WS_WHALE_LIST or populate signals.jsonl');
    process.exit(1);
  }

  const cfg = loadHlWsFeedConfig(whales);
  console.log(
    `[hl-twap-ws-spike] start url=${cfg.url} whales=${whales.length} out=${SPIKE_PATH} hypurr_poll=${HYPURR_POLL_MS}ms`,
  );
  appendSpike({ event: 'spike_start', whales: whales.length, url: cfg.url });

  const feed = new HlWsTwapFeed(cfg, logEvent);
  feed.start();
  void hypurrPollLoop(whales);

  const shutdown = (): void => {
    feed.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[hl-twap-ws-spike] fatal', e);
  process.exit(1);
});
