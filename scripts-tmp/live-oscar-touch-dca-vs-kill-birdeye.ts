/**
 * Все закрытые live-сделки (те же фильтры журнала, что в kill-grid): по **минутным** свечам Birdeye OHLCV USD
 * смотрим путь цены относительно **текущей средней только по ногам open+scale_in** (журнальный DCA в среднюю не входит —
 * это база «если усредняем отдельно на −4%»).
 *
 * Метрики:
 * - touchDcaPct: первая линия «усреднения» — цена коснулась ≤ −dcaPct% от средней на баре (low свечи).
 * - touchKillPct: «kill» — коснулась ≤ −killPct% от средней на баре.
 * - Сделки в корзине **touchDca && !touchKill**: коснулись уровня усреднения, но не −8% (при killPct=8).
 * - **recoveredAboveAvg**: после первого бара, где зафиксировано касание −dcaPct%, существует последующий бар,
 *   где high ≥ средняя на начало этого бара (после применения ног) — грубый признак «отход вверх от средней».
 *
 * Почему не «сырой» Solana RPC: исторические USD-свечи по mint из RPC напрямую не даются; в репозитории уже
 * принят Birdeye OHLCV (см. live-oscar-killstop-birdeye-ohlcv.mjs). Нужен **BIRDEYE_API_KEY** в `.env`.
 *
 * VPS:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && \
 *     npx tsx scripts-tmp/live-oscar-touch-dca-vs-kill-birdeye.ts data/live/pt1-oscar-live.jsonl
 *
 * Флаги: --dca-pct 4 --kill-pct 8 --sleep-ms 220 --per-trade
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';

const TABLES_ALLOW = new Set(['pumpswap', 'raydium', 'orca', 'meteora', 'moonshot']);

interface Leg {
  ts: number;
  price: number;
  sizeUsd: number;
  reason: string;
}

interface CloseRow {
  mint: string;
  entryTs: number;
  exitTs: number;
  netPnlUsd: number;
  exitReason: string;
  dex: string;
  legs: Leg[];
}

interface Candle {
  unix_time: number;
  l: number;
  h: number;
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  if (i === -1 || process.argv[i + 1] == null) return def;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : def;
}

function argFlag(name: string): boolean {
  return process.argv.includes(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function applyLeg(inv: number, avg: number, leg: Leg): { inv: number; avg: number } {
  if (!(leg.price > 0) || !(leg.sizeUsd > 0)) return { inv, avg };
  const tokens = inv / avg;
  const addTokens = leg.sizeUsd / leg.price;
  const newInv = inv + leg.sizeUsd;
  const newAvg = newInv / (tokens + addTokens);
  return { inv: newInv, avg: newAvg };
}

function sortLegs(legs: Leg[]): Leg[] {
  return [...legs].sort((a, b) => a.ts - b.ts || 0);
}

function openScaleLegs(c: CloseRow): Leg[] {
  return sortLegs(c.legs.filter((l) => l.reason === 'open' || l.reason === 'scale_in'));
}

async function loadCloses(jsonlPath: string): Promise<{ rows: CloseRow[]; excludedAbsurd: number }> {
  const out: CloseRow[] = [];
  let excludedAbsurd = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(jsonlPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.kind !== 'live_position_close') continue;
    const ct = o.closedTrade as Record<string, unknown> | undefined;
    if (!ct) continue;

    const legsRaw = ct.legs as unknown;
    if (!Array.isArray(legsRaw)) continue;
    const legs: Leg[] = [];
    for (const lr of legsRaw) {
      const x = lr as Record<string, unknown>;
      legs.push({
        ts: Number(x.ts ?? 0),
        price: Number(x.price ?? 0),
        sizeUsd: Number(x.sizeUsd ?? 0),
        reason: String(x.reason ?? ''),
      });
    }

    const mint = String(ct.mint ?? '');
    const entryTs = Number(ct.entryTs ?? 0);
    const exitTs = Number(ct.exitTs ?? 0);
    const net = ct.netPnlUsd;
    const totalInvestedUsd = Number(ct.totalInvestedUsd ?? 0);
    const exitReason = String(ct.exitReason ?? '');

    let dex = String(ct.dex ?? ct.source ?? 'pumpswap').toLowerCase().trim();
    if (!TABLES_ALLOW.has(dex)) dex = 'pumpswap';

    if (!mint || !(entryTs > 0) || !(exitTs > 0) || typeof net !== 'number' || !(totalInvestedUsd > 0))
      continue;

    const absurd =
      !Number.isFinite(net) ||
      Math.abs(net) > Math.max(500_000, totalInvestedUsd * 50) ||
      exitReason === 'PERIODIC_HEAL';
    if (absurd) {
      excludedAbsurd++;
      continue;
    }

    out.push({ mint, entryTs, exitTs, netPnlUsd: net, exitReason, dex, legs });
  }

  return { rows: out, excludedAbsurd };
}

const API_KEY = process.env.BIRDEYE_API_KEY?.trim() ?? '';

async function fetchOhlcv(params: {
  address: string;
  type: string;
  timeFromSec: number;
  timeToSec: number;
  sleepMs: number;
  maxRetries: number;
}): Promise<Candle[]> {
  const u = new URL('https://public-api.birdeye.so/defi/v3/ohlcv');
  u.searchParams.set('address', params.address);
  u.searchParams.set('type', params.type);
  u.searchParams.set('currency', 'usd');
  u.searchParams.set('time_from', String(params.timeFromSec));
  u.searchParams.set('time_to', String(params.timeToSec));

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt < params.maxRetries; attempt++) {
    const r = await fetch(u.toString(), {
      headers: {
        'X-API-KEY': API_KEY,
        'x-chain': 'solana',
        Accept: 'application/json',
      },
    });
    const text = await r.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      lastErr = new Error(`non-json ${r.status}`);
      if (r.status === 429 || r.status >= 500) {
        await sleep(params.sleepMs * (attempt + 2) * 4);
        continue;
      }
      throw lastErr;
    }
    if (r.status === 429 || r.status === 503) {
      await sleep(params.sleepMs * (attempt + 2) * 4);
      continue;
    }
    if (!r.ok) {
      lastErr = new Error(String(json?.message ?? `${r.status}`));
      if (r.status >= 500) {
        await sleep(params.sleepMs * (attempt + 1));
        continue;
      }
      throw lastErr;
    }
    if (!json?.success) {
      throw new Error(String(json?.message ?? 'birdeye success=false'));
    }
    const items = json?.data as { items?: unknown } | undefined;
    const arr = items?.items;
    if (!Array.isArray(arr)) return [];
    const candles: Candle[] = [];
    for (const x of arr) {
      const it = x as Record<string, unknown>;
      const unix_time = Number(it.unix_time);
      const l = Number(it.l);
      const h = Number(it.h);
      if (Number.isFinite(unix_time) && Number.isFinite(l) && Number.isFinite(h)) {
        candles.push({ unix_time, l, h });
      }
    }
    return candles.sort((a, b) => a.unix_time - b.unix_time);
  }
  throw lastErr ?? new Error('fetchOhlcv retries exhausted');
}

function analyzeWindow(
  candles: Candle[],
  legsQueue: Leg[],
  entrySec: number,
  exitSec: number,
  dcaPct: number,
  killPct: number,
): {
  touchDca: boolean;
  touchKill: boolean;
  touchDcaNotKill: boolean;
  recoveredAboveAvg: boolean;
  firstTouchDcaUnix: number | null;
  minLowVsAvgPct: number | null;
  maxHighVsAvgPct: number | null;
  barsUsed: number;
} {
  const sorted = candles.filter((c) => c.unix_time >= entrySec && c.unix_time <= exitSec);
  const dcaFrac = -dcaPct / 100;
  const killFrac = -killPct / 100;

  let legIdx = 0;
  let inv = 0;
  let avg = 0;

  let touchDca = false;
  let touchKill = false;
  let firstTouchDcaUnix: number | null = null;
  let recoveredAboveAvg = false;

  let minLowVsAvgPct: number | null = null;
  let maxHighVsAvgPct: number | null = null;

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const tEndMs = c.unix_time * 1000;

    while (legIdx < legsQueue.length && legsQueue[legIdx]!.ts <= tEndMs) {
      const leg = legsQueue[legIdx]!;
      legIdx++;
      if (inv <= 0 || avg <= 0) {
        const n = applyLeg(0, leg.price, leg);
        inv = n.inv;
        avg = n.avg;
      } else {
        const n = applyLeg(inv, avg, leg);
        inv = n.inv;
        avg = n.avg;
      }
    }

    if (!(inv > 0) || !(avg > 0)) continue;

    const lowPct = (c.l - avg) / avg;
    const highPct = (c.h - avg) / avg;

    minLowVsAvgPct = minLowVsAvgPct === null ? lowPct : Math.min(minLowVsAvgPct, lowPct);
    maxHighVsAvgPct = maxHighVsAvgPct === null ? highPct : Math.max(maxHighVsAvgPct, highPct);

    if (lowPct <= killFrac + 1e-12) touchKill = true;
    if (lowPct <= dcaFrac + 1e-12) {
      if (!touchDca) firstTouchDcaUnix = c.unix_time;
      touchDca = true;
    }

    if (touchDca && firstTouchDcaUnix !== null && c.unix_time >= firstTouchDcaUnix && highPct >= -1e-12) {
      recoveredAboveAvg = true;
    }
  }

  const touchDcaNotKill = touchDca && !touchKill;

  return {
    touchDca,
    touchKill,
    touchDcaNotKill,
    recoveredAboveAvg: touchDcaNotKill ? recoveredAboveAvg : false,
    firstTouchDcaUnix,
    minLowVsAvgPct,
    maxHighVsAvgPct,
    barsUsed: sorted.length,
  };
}

async function main(): Promise<void> {
  const posArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const jsonlPath =
    posArgs[0]?.trim() && fs.existsSync(path.resolve(posArgs[0]))
      ? path.resolve(posArgs[0])
      : path.join(process.cwd(), 'data/live/pt1-oscar-live.jsonl');

  const dcaPct = argNum('--dca-pct', 4);
  const killPct = argNum('--kill-pct', 8);
  const sleepMs = argNum('--sleep-ms', 220);
  const maxRetries = argNum('--retries', 4);
  const perTrade = argFlag('--per-trade');

  if (!API_KEY) {
    console.error('Missing BIRDEYE_API_KEY in environment (.env).');
    process.exit(1);
  }

  const { rows: closes, excludedAbsurd } = await loadCloses(jsonlPath);

  const perTradeOut: Array<Record<string, unknown>> = [];

  let ok = 0;
  let fail = 0;
  let touchDcaNotKill = 0;
  let touchDcaNotKillRecovered = 0;
  let touchBoth = 0;
  let touchNeither = 0;
  let touchKillOnly = 0;

  for (const c of closes) {
    const legsQ = openScaleLegs(c);
    const entrySec = Math.floor(c.entryTs / 1000);
    const exitSec = Math.floor(c.exitTs / 1000);

    let candles: Candle[] = [];
    let err: string | null = null;
    try {
      candles = await fetchOhlcv({
        address: c.mint,
        type: '1m',
        timeFromSec: entrySec - 60,
        timeToSec: exitSec + 60,
        sleepMs,
        maxRetries,
      });
      ok++;
    } catch (e) {
      fail++;
      err = e instanceof Error ? e.message : String(e);
    }

    await sleep(sleepMs);

    const r =
      candles.length > 0
        ? analyzeWindow(candles, legsQ, entrySec, exitSec, dcaPct, killPct)
        : {
            touchDca: false,
            touchKill: false,
            touchDcaNotKill: false,
            recoveredAboveAvg: false,
            firstTouchDcaUnix: null,
            minLowVsAvgPct: null,
            maxHighVsAvgPct: null,
            barsUsed: 0,
          };

    if (r.touchDca && r.touchKill) touchBoth++;
    else if (r.touchDca && !r.touchKill) {
      touchDcaNotKill++;
      if (r.recoveredAboveAvg) touchDcaNotKillRecovered++;
    } else if (!r.touchDca && !r.touchKill) touchNeither++;
    else if (!r.touchDca && r.touchKill) touchKillOnly++;

    if (perTrade) {
      perTradeOut.push({
        mint: c.mint,
        exitReason: c.exitReason,
        actualNetPnlUsd: +c.netPnlUsd.toFixed(4),
        barsUsed: r.barsUsed,
        touchDcaPct: r.touchDca,
        touchKillPct: r.touchKill,
        touchDcaNotKill: r.touchDcaNotKill,
        recoveredAboveAvgAfterTouchDca: r.recoveredAboveAvg,
        minLowVsAvgPct:
          r.minLowVsAvgPct != null ? +(r.minLowVsAvgPct * 100).toFixed(4) : null,
        maxHighVsAvgPct:
          r.maxHighVsAvgPct != null ? +(r.maxHighVsAvgPct * 100).toFixed(4) : null,
        fetchErr: err,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        jsonlPath,
        priceSource: 'birdeye_defi_v3_ohlcv_1m_usd',
        noteWhyNotSolanaRpc:
          'Исторические OHLCV USD по mint через обычный JSON-RPC не стандартизованы; используется Birdeye API как в других scripts-tmp.',
        avgBasis:
          'Средняя только по ногам open+scale_in по времени (журнальный DCA не смешивается — отвечает на вопрос «уровень усреднения −4% от базовой позиции»).',
        dcaTouchPct: dcaPct,
        killTouchPct: killPct,
        closesUsed: closes.length,
        excludedJournalRows: excludedAbsurd,
        birdeyeFetchOk: ok,
        birdeyeFetchFail: fail,
        counts: {
          touchDcaNotKill_noKill8BeforeExitWindow:
            touchDcaNotKill,
          amongThose_recoveredHighGteAvgAfterFirstTouchDca:
            touchDcaNotKillRecovered,
          touchBothDcaAndKill:
            touchBoth,
          touchNeither:
            touchNeither,
          touchKillButNotDca:
            touchKillOnly,
        },
        fractionsOfAllCloses: {
          touchDcaNotKill: closes.length ? +(touchDcaNotKill / closes.length).toFixed(4) : 0,
          touchDcaNotKillAndRecovered:
            closes.length ? +(touchDcaNotKillRecovered / closes.length).toFixed(4) : 0,
        },
        whyNoJournalDcaOftenWinsInPriorBacktest:
          'Журнальные DCA увеличивают размер до более глубоких минусов при том же kill; без них средняя ниже на дампе и модельный полный выход иногда менее отрицательный — это артефакт упрощённой модели без частичных TP.',
        perTrade: perTrade ? perTradeOut : undefined,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
