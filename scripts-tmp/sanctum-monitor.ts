/**
 * Sanctum LST Arb Monitor — Strategy B / Edge #1.
 *
 * Что делает:
 *   - Берёт top-N Solana LST (jitoSOL, mSOL, bSOL, jupSOL, dSOL, INF, ...)
 *   - Для каждого LST:
 *       1) запрашивает true par-value у Sanctum extra-api  (бесплатно, без key):
 *          https://extra-api.sanctum.so/v1/sol-value/current?lst=<sym>...
 *          → 1 LST = X SOL (внутренняя стоимость)
 *       2) запрашивает Jupiter quote LST→SOL для размеров [10, 100, 1000] SOL
 *          → 1 LST = Y SOL (рыночная цена с учётом маршрутизации/slippage)
 *       3) считает arb_pct = (Y/X − 1)·100
 *          - arb_pct < 0  →  LST продаётся НИЖЕ par → buy LST cheap, instant unstake/redeem → profit
 *          - arb_pct ≥ 0  →  нет arb для нас (premium / fair)
 *   - Сохраняет каждый sample в `sanctum_snapshots`
 *   - Печатает live alerts если arb_pct < ALERT_PCT
 *
 * Edge формула (профит ПОСЛЕ всех fees):
 *   real_profit = −arb_pct − sanctum_unstake_fee − jupiter_implied_fee − slippage_buffer
 *
 *   - jupiter_implied_fee УЖЕ включён в Y (Jupiter уже показывает чистый outAmount после AMM-fees)
 *   - sanctum_unstake_fee типично 8-50 bps (0.08%-0.5%) для нормального состояния пула,
 *     поднимается до 800 bps (8%) когда Reserve опустошён
 *
 * Режимы:
 *   --once          (default) одна итерация, выход
 *   --loop          бесконечный цикл с --interval секунд (default 30)
 *   --interval N    секунд между итерациями
 *   --no-save       не сохранять в БД (dry run)
 *   --alert-pct X   (default 0.10) печатать alert при arb_pct < -X
 *
 * Запуск:
 *   npx tsx scripts-tmp/sanctum-monitor.ts                  # одна итерация
 *   npx tsx scripts-tmp/sanctum-monitor.ts --loop           # вечный мониторинг
 *   pm2 start "npx tsx scripts-tmp/sanctum-monitor.ts --loop" --name sa-sanctum
 */
import 'dotenv/config';
import { db, schema } from '../src/core/db/client.js';

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

const SANCTUM_SOL_VALUE_URL = 'https://extra-api.sanctum.so/v1/sol-value/current';
const JUPITER_QUOTE_URL = 'https://api.jup.ag/swap/v1/quote';

/**
 * Top Solana LSTs by TVL (ranked from public data, late 2025/early 2026).
 *
 * symbol = used as Sanctum API key (case-insensitive in their API).
 * mint   = SPL mint address (used by Jupiter).
 *
 * Если какой-то mint окажется битым — Jupiter вернёт ошибку и мы скипнем строку.
 * Decimals у всех LSTs = 9 (как у SOL).
 */
const LST_REGISTRY: Array<{ symbol: string; mint: string; decimals: number }> = [
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', decimals: 9 },
  { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  decimals: 9 },
  { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  decimals: 9 },
  { symbol: 'jupSOL',  mint: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',  decimals: 9 },
  { symbol: 'dSOL',    mint: 'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ',  decimals: 9 },
  { symbol: 'INF',     mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', decimals: 9 },
];

const SAMPLE_SIZES_SOL = [10, 100, 1000];

// ────────────────────────────────────────────────────────────────────────────
// Args
// ────────────────────────────────────────────────────────────────────────────

interface Args {
  loop: boolean;
  intervalSec: number;
  noSave: boolean;
  alertPct: number;  // positive number; alert fires when arb_pct < -alertPct
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    loop: argv.includes('--loop'),
    intervalSec: Number(get('--interval') ?? 30),
    noSave: argv.includes('--no-save'),
    alertPct: Number(get('--alert-pct') ?? 0.10),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ────────────────────────────────────────────────────────────────────────────

async function fetchJson<T = unknown>(url: string, timeoutMs = 8_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}: ${body.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Sanctum: par-value batch fetch
// ────────────────────────────────────────────────────────────────────────────

interface SanctumSolValueResp {
  solValues: Record<string, string>; // symbol → lamports per 1 LST (string for big-int safety)
  errs: Record<string, string>;
}

async function fetchSanctumPars(symbols: string[]): Promise<Map<string, number>> {
  const qs = symbols.map((s) => `lst=${encodeURIComponent(s)}`).join('&');
  const url = `${SANCTUM_SOL_VALUE_URL}?${qs}`;
  const json = await fetchJson<SanctumSolValueResp>(url);
  const out = new Map<string, number>();
  for (const sym of symbols) {
    const lamportsStr = json.solValues?.[sym];
    if (!lamportsStr) {
      const err = json.errs?.[sym];
      console.warn(`[sanctum] no sol-value for ${sym}: ${err ?? 'missing'}`);
      continue;
    }
    out.set(sym, Number(lamportsStr) / LAMPORTS_PER_SOL);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Jupiter: LST → SOL quote
// ────────────────────────────────────────────────────────────────────────────

interface JupQuoteResp {
  inputMint: string;
  inAmount: string;   // lamports of inputMint
  outputMint: string;
  outAmount: string;  // lamports of outputMint
  otherAmountThreshold?: string;
  priceImpactPct?: string;
  routePlan?: Array<{
    swapInfo?: { label?: string; ammKey?: string };
  }>;
}

/**
 * Quote how many SOL we receive for selling `lstAmountUi` units of LST.
 * Returns sol_per_lst (UI), price_impact_pct, route_label.
 */
async function quoteLstToSol(
  lstMint: string,
  lstDecimals: number,
  lstAmountUi: number,
): Promise<{
  solPerLst: number;
  priceImpactPct: number | null;
  routeLabel: string;
} | null> {
  const amountRaw = Math.round(lstAmountUi * 10 ** lstDecimals);
  const url =
    `${JUPITER_QUOTE_URL}?inputMint=${lstMint}&outputMint=${SOL_MINT}` +
    `&amount=${amountRaw}&slippageBps=50&swapMode=ExactIn&onlyDirectRoutes=false`;
  try {
    const r = await fetchJson<JupQuoteResp>(url);
    const outSol = Number(r.outAmount) / LAMPORTS_PER_SOL;
    const inLst = Number(r.inAmount) / 10 ** lstDecimals;
    const solPerLst = outSol / inLst;
    const labels = (r.routePlan ?? [])
      .map((p) => p.swapInfo?.label ?? p.swapInfo?.ammKey ?? '?')
      .join('→');
    return {
      solPerLst,
      priceImpactPct: r.priceImpactPct != null ? Number(r.priceImpactPct) * 100 : null,
      routeLabel: labels || 'unknown',
    };
  } catch (e) {
    console.warn(`[jup] quote failed for ${lstMint} amount=${lstAmountUi}: ${(e as Error).message}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main iteration
// ────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  ts: Date;
  symbol: string;
  mint: string;
  sizeSol: number;
  sanctumSolValue: number;
  jupiterSolPerLst: number;
  jupiterPriceImpactPct: number | null;
  arbPct: number;
  arbSolGross: number;
  routeLabel: string;
}

async function runIteration(args: Args): Promise<Snapshot[]> {
  const t0 = Date.now();
  const symbols = LST_REGISTRY.map((l) => l.symbol);

  // Step 1: Sanctum pars
  let pars: Map<string, number>;
  try {
    pars = await fetchSanctumPars(symbols);
  } catch (e) {
    console.error(`[sanctum] batch fetch failed: ${(e as Error).message}`);
    return [];
  }

  const ts = new Date();
  const snapshots: Snapshot[] = [];

  // Step 2: per-LST × per-size Jupiter quotes
  for (const lst of LST_REGISTRY) {
    const par = pars.get(lst.symbol);
    if (!par) continue;

    for (const sizeSol of SAMPLE_SIZES_SOL) {
      // amount of LST equivalent to `sizeSol` SOL at par
      const lstUi = sizeSol / par;
      const q = await quoteLstToSol(lst.mint, lst.decimals, lstUi);
      if (!q) continue;

      const arbPct = (q.solPerLst / par - 1) * 100;
      const arbSolGross = (q.solPerLst - par) * lstUi; // negative if discount

      snapshots.push({
        ts,
        symbol: lst.symbol,
        mint: lst.mint,
        sizeSol,
        sanctumSolValue: par,
        jupiterSolPerLst: q.solPerLst,
        jupiterPriceImpactPct: q.priceImpactPct,
        arbPct,
        arbSolGross,
        routeLabel: q.routeLabel,
      });
    }
  }

  // Step 3: persist
  if (!args.noSave && snapshots.length > 0) {
    try {
      await db.insert(schema.sanctumSnapshots).values(
        snapshots.map((s) => ({
          ts: s.ts,
          lstSymbol: s.symbol,
          lstMint: s.mint,
          sizeSol: s.sizeSol,
          sanctumSolValue: s.sanctumSolValue,
          jupiterSolPerLst: s.jupiterSolPerLst,
          jupiterPriceImpactPct: s.jupiterPriceImpactPct,
          arbPct: s.arbPct,
          arbSolGross: s.arbSolGross,
          meta: { route: s.routeLabel },
        })),
      );
    } catch (e) {
      console.error(`[db] insert failed: ${(e as Error).message}`);
    }
  }

  // Step 4: print
  printIteration(snapshots, args, Date.now() - t0);
  return snapshots;
}

function printIteration(snapshots: Snapshot[], args: Args, elapsedMs: number): void {
  if (snapshots.length === 0) {
    console.log('[iter] empty (no quotes)');
    return;
  }

  const ts = snapshots[0].ts.toISOString().replace('T', ' ').slice(0, 19);
  console.log(`\n=== ${ts}  (collected ${snapshots.length} samples in ${elapsedMs}ms) ===`);
  console.log(
    'symbol   size_sol  par         market      arb_pct    impact   alert  route',
  );
  for (const s of snapshots) {
    const isAlert = s.arbPct < -args.alertPct;
    const arbStr = `${s.arbPct >= 0 ? '+' : ''}${s.arbPct.toFixed(3)}%`;
    const impactStr = s.jupiterPriceImpactPct != null
      ? `${s.jupiterPriceImpactPct.toFixed(2)}%`
      : '   -';
    const flag = isAlert ? '<<ARB>>' : '       ';
    const route = s.routeLabel.length > 40 ? s.routeLabel.slice(0, 37) + '...' : s.routeLabel;
    console.log(
      `${s.symbol.padEnd(8)} ${String(s.sizeSol).padStart(8)}  ` +
        `${s.sanctumSolValue.toFixed(7)}  ${s.jupiterSolPerLst.toFixed(7)}  ` +
        `${arbStr.padStart(9)}  ${impactStr.padStart(6)}  ${flag}  ${route}`,
    );
  }

  const alerts = snapshots.filter((s) => s.arbPct < -args.alertPct);
  if (alerts.length > 0) {
    console.log(
      `\n>>> ${alerts.length} alert(s) below ${-args.alertPct}% par.` +
        ` Investigate before assuming profit (Sanctum unstake fee may eat it).`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Entry
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log('Sanctum monitor starting');
  console.log(
    `mode=${args.loop ? 'loop' : 'once'} interval=${args.intervalSec}s ` +
      `save=${!args.noSave} alert<${-args.alertPct}% LSTs=${LST_REGISTRY.length}`,
  );

  if (!args.loop) {
    await runIteration(args);
    return;
  }

  let stop = false;
  process.on('SIGINT', () => {
    console.log('\n[shutdown] SIGINT — finishing current iteration then exit');
    stop = true;
  });

  while (!stop) {
    try {
      await runIteration(args);
    } catch (e) {
      console.error(`[iter] crashed: ${(e as Error).stack ?? (e as Error).message}`);
    }
    if (stop) break;
    await new Promise((r) => setTimeout(r, args.intervalSec * 1_000));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[fatal]', e);
    process.exit(1);
  });
