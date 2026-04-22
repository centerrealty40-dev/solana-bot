/**
 * PumpPortal WebSocket Collector
 * ===============================
 *
 * Бесплатный real-time поток ВСЕХ pump.fun trades. Подключаемся к
 * wss://pumpportal.fun/api/data, подписываемся на:
 *   1. subscribeNewToken — каждое создание pump.fun токена
 *   2. subscribeTokenTrade с динамическим пулом mint'ов (последние ~500
 *      созданных или активно торгующихся), чтобы получать поток покупок
 *      по этим токенам.
 *
 * Каждое полученное trade событие нормализуется в NormalizedSwap и
 * батчем (раз в FLUSH_MS) пишется в swaps. SOL→USD цена освежается раз
 * в 5 мин из DexScreener.
 *
 * Запуск:
 *   npm run pp:collector             -- forever
 *   npm run pp:collector -- --once   -- одна минута и выход (smoke test)
 *
 * Метрики каждые 30 сек:
 *   - events/sec, мints in trade-pool, swaps inserted
 */
import 'dotenv/config';
import WebSocket from 'ws';
import { fetch } from 'undici';
import { child } from '../src/core/logger.js';
import { insertSwapsBatch } from '../src/core/db/repository.js';
import type { NormalizedSwap } from '../src/core/types.js';

const log = child('pumpportal');

// =====================================================================
// CONFIG
// =====================================================================
const PP_URL = 'wss://pumpportal.fun/api/data';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_DECIMALS = 6;                          // pump.fun токены = 6 decimals
const TRADE_POOL_MAX = 500;                       // сколько mint'ов держим в active subscription
const TRADE_POOL_TTL_MS = 30 * 60_000;            // выкидываем mint из подписки через 30 мин
const FLUSH_MS = 2_000;                           // батч-инсерт раз в 2 сек
const SOL_PRICE_REFRESH_MS = 5 * 60_000;
const STATS_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 3000, 10_000, 30_000];

// Pumpfun bonding-curve мигрирует на Raydium после ~85 SOL volume.
// PumpPortal в `pool` шлёт 'pump' до миграции, 'raydium' после.
const POOL_TO_DEX: Record<string, NormalizedSwap['dex']> = {
  pump: 'pumpfun',
  raydium: 'raydium',
};

// =====================================================================
// SOL price ticker
// =====================================================================
let SOL_USD = 200;  // sane default

async function refreshSolPrice(): Promise<void> {
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`);
    if (!r.ok) return;
    const j: any = await r.json();
    const top = Array.isArray(j) ? j.find((p: any) => p.priceUsd) : null;
    const px = Number(top?.priceUsd ?? 0);
    if (px > 50 && px < 5000) {
      SOL_USD = px;
      log.debug({ sol_usd: SOL_USD }, 'SOL price refreshed');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'SOL price refresh failed');
  }
}

// =====================================================================
// Active mint pool (LRU-ish)
// =====================================================================
interface PoolEntry { mint: string; addedAt: number; }
const tradePool = new Map<string, number>();   // mint -> addedAtMs

function tradePoolAdd(mint: string): boolean {
  const now = Date.now();
  if (tradePool.has(mint)) {
    tradePool.set(mint, now);  // refresh
    return false;
  }
  tradePool.set(mint, now);
  return true;
}

function tradePoolEvictExpired(): string[] {
  const now = Date.now();
  const evicted: string[] = [];
  for (const [mint, ts] of tradePool) {
    if (now - ts > TRADE_POOL_TTL_MS || tradePool.size > TRADE_POOL_MAX) {
      evicted.push(mint);
      tradePool.delete(mint);
      if (tradePool.size <= TRADE_POOL_MAX * 0.9) break;
    }
  }
  return evicted;
}

// =====================================================================
// Buffer + flush
// =====================================================================
const swapBuf: NormalizedSwap[] = [];
let totalInserted = 0;
let totalEvents = 0;

async function flushBuffer(): Promise<void> {
  if (swapBuf.length === 0) return;
  const batch = swapBuf.splice(0, swapBuf.length);
  try {
    const n = await insertSwapsBatch(batch);
    totalInserted += n;
  } catch (err) {
    log.warn({ err: String(err), n: batch.length }, 'flush failed');
  }
}

// =====================================================================
// Trade normalization
// =====================================================================
function normalizeTrade(ev: any): NormalizedSwap | null {
  if (!ev || !ev.mint || !ev.signature || !ev.traderPublicKey) return null;
  if (ev.txType !== 'buy' && ev.txType !== 'sell') return null;
  const tokenAmount = Number(ev.tokenAmount ?? 0);
  const solAmount = Number(ev.solAmount ?? 0);
  if (!(tokenAmount > 0) || !(solAmount > 0)) return null;

  const amountUsd = solAmount * SOL_USD;
  const priceUsd = amountUsd / tokenAmount;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const dex: NormalizedSwap['dex'] = POOL_TO_DEX[ev.pool] ?? 'pumpfun';

  return {
    signature: ev.signature,
    slot: Number(ev.slot ?? 0),
    blockTime: new Date(),  // PumpPortal не шлёт block_time, используем receive time
    wallet: ev.traderPublicKey,
    baseMint: ev.mint,
    quoteMint: SOL_MINT,
    side: ev.txType,
    baseAmountRaw: BigInt(Math.floor(tokenAmount * Math.pow(10, PUMP_DECIMALS))),
    quoteAmountRaw: BigInt(Math.floor(solAmount * 1e9)),
    priceUsd,
    amountUsd,
    dex,
    source: 'pumpportal',
  };
}

// =====================================================================
// WebSocket lifecycle
// =====================================================================
let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let pendingTradeSubs: string[] = [];

function wsSend(payload: any): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function subscribeTrades(mints: string[]): void {
  if (mints.length === 0) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    pendingTradeSubs.push(...mints);
    return;
  }
  // PumpPortal принимает массив, разобьём на чанки по 100 на всякий
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    wsSend({ method: 'subscribeTokenTrade', keys: chunk });
  }
}

function unsubscribeTrades(mints: string[]): void {
  if (mints.length === 0 || !ws || ws.readyState !== WebSocket.OPEN) return;
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    wsSend({ method: 'unsubscribeTokenTrade', keys: chunk });
  }
}

function connect(): void {
  log.info({ url: PP_URL, attempt: reconnectAttempt }, 'connecting');
  ws = new WebSocket(PP_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; SolanaAlphaResearch/1.0)',
      'Origin': 'https://pumpportal.fun',
    },
  });

  ws.on('open', () => {
    log.info('connected');
    reconnectAttempt = 0;
    // subscribe to new tokens (always)
    wsSend({ method: 'subscribeNewToken' });
    // re-subscribe pending trade pool
    if (pendingTradeSubs.length > 0) {
      const m = [...new Set(pendingTradeSubs)];
      pendingTradeSubs = [];
      subscribeTrades(m);
      log.info({ resubbed: m.length }, 're-subscribed trades after reconnect');
    }
    // also re-subscribe everything in the live pool
    if (tradePool.size > 0) {
      subscribeTrades([...tradePool.keys()]);
    }
  });

  ws.on('message', (raw) => {
    totalEvents++;
    let ev: any;
    try { ev = JSON.parse(String(raw)); } catch { return; }

    // Server-side acks etc.: { message: "Successfully subscribed..." }
    if (typeof ev.message === 'string' && !ev.signature) {
      log.debug({ msg: ev.message }, 'pp ack');
      return;
    }

    // 1. New token event
    if (ev.txType === 'create' && ev.mint) {
      const fresh = tradePoolAdd(ev.mint);
      if (fresh) subscribeTrades([ev.mint]);
      // initialBuy is also a trade — record it
      const initBuy = normalizeTrade({
        ...ev,
        txType: 'buy',
        tokenAmount: ev.initialBuy,
        solAmount: ev.solAmount,
      });
      if (initBuy) swapBuf.push(initBuy);
      return;
    }

    // 2. Trade event
    if (ev.txType === 'buy' || ev.txType === 'sell') {
      const swap = normalizeTrade(ev);
      if (swap) {
        swapBuf.push(swap);
        tradePoolAdd(ev.mint);  // refresh TTL
      }
      return;
    }
  });

  ws.on('close', (code, reason) => {
    log.warn({ code, reason: String(reason).slice(0, 80) }, 'closed; will reconnect');
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    log.warn({ err: String(err) }, 'ws error');
    // 'close' will fire after error, no need to reconnect here
  });
}

function scheduleReconnect(): void {
  const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempt++;
  setTimeout(connect, delay);
}

// =====================================================================
// MAIN
// =====================================================================
async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  log.info({ once, sol_usd: SOL_USD }, 'pumpportal collector start');

  await refreshSolPrice();
  setInterval(() => { void refreshSolPrice(); }, SOL_PRICE_REFRESH_MS);

  connect();

  // periodic flush
  setInterval(() => { void flushBuffer(); }, FLUSH_MS);

  // periodic eviction + stats
  let lastEvents = 0;
  let lastInserted = 0;
  setInterval(() => {
    const evicted = tradePoolEvictExpired();
    if (evicted.length > 0) unsubscribeTrades(evicted);

    const evRate = (totalEvents - lastEvents) / (STATS_MS / 1000);
    const insRate = (totalInserted - lastInserted) / (STATS_MS / 1000);
    lastEvents = totalEvents;
    lastInserted = totalInserted;
    log.info({
      events_total: totalEvents,
      events_per_sec: evRate.toFixed(1),
      swaps_total: totalInserted,
      swaps_per_sec: insRate.toFixed(1),
      pool_size: tradePool.size,
      buf: swapBuf.length,
      sol_usd: SOL_USD.toFixed(2),
      evicted: evicted.length,
    }, 'stats');
  }, STATS_MS);

  if (once) {
    log.info('--once mode: running for 60 sec');
    setTimeout(async () => {
      await flushBuffer();
      log.info({
        events: totalEvents,
        inserted: totalInserted,
        pool: tradePool.size,
      }, 'once finished');
      try { ws?.close(); } catch {}
      process.exit(0);
    }, 60_000);
  }

  process.on('SIGINT', async () => {
    log.info('SIGINT received');
    await flushBuffer();
    try { ws?.close(); } catch {}
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch(e => { log.error({ err: String(e) }, 'fatal'); process.exit(1); });
