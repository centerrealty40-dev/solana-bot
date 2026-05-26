/**
 * Пилотная диагностика SA-GRWS: серия контролируемых прогонов с паузами,
 * дельты budget-state (RPC/Gecko), разбор воронки Gecko→Raydium и полных тиков,
 * экстраполяция «безопасной» нагрузки на Gecko Terminal и QuickNode.
 *
 * Usage (из корня solana-alpha, с .env):
 *   node scripts-tmp/sa-grws-pilot-diagnose.mjs
 *   SA_GRWS_PILOT_PAUSE_MS=60000 node scripts-tmp/sa-grws-pilot-diagnose.mjs
 */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'timers/promises';

function envNum(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function envStr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const CWD = process.cwd();
const COLLECTOR = path.join(CWD, 'scripts-tmp', 'sa-grws-collector.mjs');
const BUDGET_PATH = process.env.SA_GRWS_PILOT_BUDGET_PATH?.trim()
  ? path.resolve(CWD, process.env.SA_GRWS_PILOT_BUDGET_PATH.trim())
  : path.join(CWD, 'data', 'sa-grws-budget-state.json');
const PAUSE_MS = Math.max(5000, envNum('SA_GRWS_PILOT_PAUSE_MS', 90_000));
const QN_CREDITS_DAY = Math.max(1000, envNum('SA_GRWS_MAX_QUICKNODE_CREDITS_PER_DAY', 1_500_000));
const QN_PER_RPC = Math.max(1, envNum('QUICKNODE_CREDITS_PER_SOLANA_RPC', 30));
const GECKO_SOFT_DAY = Math.max(10, envNum('SA_GRWS_MAX_GECKO_HTTP_PER_DAY', 40_000));
const GECKO_REF_CPM = 30;
const GECKO_TARGET_CPM = Math.max(1, Math.min(60, envNum('SA_GRWS_GECKO_TARGET_CALLS_PER_MINUTE', 28)));
const TICK_LOG = envStr('SA_GRWS_TICK_LOG_PATH', 'data/sa-grws-ticks.jsonl');

function readBudget() {
  try {
    return JSON.parse(fs.readFileSync(BUDGET_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function parseLastCollectorJson(output) {
  const lines = output.split(/\n/).filter(Boolean);
  /** @type {object[]} */
  const hits = [];
  for (const ln of lines) {
    if (!ln.includes('"component":"sa-grws-collector"')) continue;
    try {
      const j = JSON.parse(ln);
      if (
        j.msg === 'tick completed' ||
        j.msg === 'pilot diagnose gecko funnel (no RPC)' ||
        j.msg === 'daily rpc budget exhausted, skip tick'
      ) {
        hits.push(j);
      }
    } catch {
      /* skip */
    }
  }
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * @param {string} name
 * @param {Record<string, string>} envOverrides
 */
function runScenario(name, envOverrides) {
  const before = readBudget();
  const env = { ...process.env };
  delete env.SA_GRWS_SEED_POOLS_PATH;
  delete env.SA_GRWS_SEED_POOLS_JSON;
  Object.assign(env, envOverrides);
  env.SA_GRWS_TICK_LOG_PATH = TICK_LOG;

  const started = Date.now();
  const r = spawnSync(process.execPath, [COLLECTOR], {
    cwd: CWD,
    env,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
  });
  const elapsedMs = Date.now() - started;
  const after = readBudget();
  const combined = `${r.stdout || ''}\n${r.stderr || ''}`;
  const logJson = parseLastCollectorJson(combined);

  const rpcBefore = Number(before?.rpcCallsDay) || 0;
  const rpcAfter = Number(after?.rpcCallsDay) || 0;
  const geckoBefore = Number(before?.geckoCallsDay) || 0;
  const geckoAfter = Number(after?.geckoCallsDay) || 0;

  return {
    name,
    exitCode: r.status,
    elapsedMs,
    budgetDelta: {
      rpcCalls: rpcAfter - rpcBefore,
      geckoHttp: geckoAfter - geckoBefore,
    },
    budgetAfterSnapshot: after,
    logMsg: logJson?.msg ?? null,
    metrics: {
      poolsRaydium: logJson?.poolsRaydium,
      geckoHttpCallsThisTick: logJson?.geckoHttpCallsThisTick,
      rpcBillableCalls: logJson?.rpcBillableCalls,
      walletsInserted: logJson?.walletsInserted,
      walletsUnique: logJson?.walletsUnique,
      estimatedQuicknodeCredits: logJson?.estimatedQuicknodeCredits,
      txFetchedTotal: logJson?.txFetchedTotal,
    },
  };
}

function extrapolate(results) {
  const maxRpcDay = Math.floor(QN_CREDITS_DAY / QN_PER_RPC);
  const geckoOnly = results.filter((x) => x.name.startsWith('gecko_funnel_'));
  const fullTicks = results.filter((x) => x.name.startsWith('full_tick_'));

  const avgPoolsGecko = geckoOnly.length
    ? geckoOnly.reduce((s, x) => s + (Number(x.metrics.poolsRaydium) || 0), 0) / geckoOnly.length
    : null;
  const avgGeckoHttpPerGeckoTick = geckoOnly.length
    ? geckoOnly.reduce((s, x) => s + (Number(x.budgetDelta.geckoHttp) || 0), 0) / geckoOnly.length
    : null;

  function rpcFullObserved(x) {
    const m = Number(x.metrics.rpcBillableCalls);
    if (Number.isFinite(m) && m >= 0) return m;
    const d = Number(x.budgetDelta?.rpcCalls);
    return Number.isFinite(d) && d >= 0 ? d : null;
  }
  const rpcVals = fullTicks.map(rpcFullObserved).filter((v) => v !== null && v >= 0);
  const avgRpcFull =
    rpcVals.length > 0 ? rpcVals.reduce((s, x) => s + x, 0) / rpcVals.length : null;
  const avgCreditsFull = avgRpcFull !== null ? avgRpcFull * QN_PER_RPC : null;
  const insVals = fullTicks
    .map((x) => Number(x.metrics.walletsInserted))
    .filter((v) => Number.isFinite(v));
  const avgInsFull = insVals.length > 0 ? insVals.reduce((s, x) => s + x, 0) / insVals.length : null;

  const avgGeckoHttpPerFullTick =
    fullTicks.length > 0
      ? fullTicks.reduce((s, x) => s + (Number(x.budgetDelta.geckoHttp) || 0), 0) / fullTicks.length
      : null;

  const ticksPerDayIfGeckoLimitedGeckoOnly =
    avgGeckoHttpPerGeckoTick && avgGeckoHttpPerGeckoTick > 0
      ? Math.floor(Math.min(GECKO_SOFT_DAY, GECKO_REF_CPM * 60 * 24) / avgGeckoHttpPerGeckoTick)
      : null;

  const ticksPerDayIfGeckoLimitedFull =
    avgGeckoHttpPerFullTick && avgGeckoHttpPerFullTick > 0
      ? Math.floor(Math.min(GECKO_SOFT_DAY, GECKO_REF_CPM * 60 * 24) / avgGeckoHttpPerFullTick)
      : null;

  const ticksPerDayIfQnLimited =
    avgRpcFull && avgRpcFull > 0 ? Math.floor(maxRpcDay / avgRpcFull) : null;

  const geckoBindFull = ticksPerDayIfGeckoLimitedFull;

  let safeTicksPerDayConservative = null;
  if (geckoBindFull != null && ticksPerDayIfQnLimited != null) {
    safeTicksPerDayConservative = Math.min(geckoBindFull, ticksPerDayIfQnLimited);
  } else if (ticksPerDayIfQnLimited != null) {
    safeTicksPerDayConservative = ticksPerDayIfQnLimited;
  } else if (geckoBindFull != null) {
    safeTicksPerDayConservative = geckoBindFull;
  }

  return {
    referenceLimits: {
      quicknodeCreditsPerDay: QN_CREDITS_DAY,
      quicknodeBillableRpcPerDayApprox: maxRpcDay,
      creditsPerRpcAssumed: QN_PER_RPC,
      geckoSoftHttpPerDay: GECKO_SOFT_DAY,
      geckoPublicReferenceCallsPerMinute: GECKO_REF_CPM,
      geckoConfiguredTargetCpm: GECKO_TARGET_CPM,
    },
    observedAverages: {
      geckoOnlyScenarios: geckoOnly.length,
      avgRaydiumPoolsWhenGeckoOnly: avgPoolsGecko !== null ? Math.round(avgPoolsGecko * 100) / 100 : null,
      avgGeckoHttpPerGeckoOnlyTick:
        avgGeckoHttpPerGeckoTick !== null ? Math.round(avgGeckoHttpPerGeckoTick * 100) / 100 : null,
      avgGeckoHttpPerFullTick:
        avgGeckoHttpPerFullTick !== null ? Math.round(avgGeckoHttpPerFullTick * 100) / 100 : null,
      fullTickScenarios: fullTicks.length,
      avgRpcBillablePerFullTick: avgRpcFull !== null ? Math.round(avgRpcFull * 100) / 100 : null,
      avgCreditsEstPerFullTick: avgCreditsFull !== null ? Math.round(avgCreditsFull * 100) / 100 : null,
      avgWalletsInsertedPerFullTick: avgInsFull !== null ? Math.round(avgInsFull * 100) / 100 : null,
    },
    extrapolatedTicksPerDay: {
      ifLimitedByGecko_usingGeckoOnlyTickAvgHttp: ticksPerDayIfGeckoLimitedGeckoOnly,
      ifLimitedByGecko_usingFullTickAvgHttp: ticksPerDayIfGeckoLimitedFull,
      ifLimitedByQuicknodeRpcCounterOnly: ticksPerDayIfQnLimited,
      conservativeMinOfBoth: safeTicksPerDayConservative,
      note:
        'Оценка тиков/сутки по средним фактическим дельтам этого прогона. Реальный биллинг QN может включать другие процессы на ключе.',
    },
  };
}

function summaryRu(results, extrap) {
  const lines = [];
  lines.push(
    `Сценариев: ${results.length}. Пауза между ними: ${PAUSE_MS} ms (Gecko throttle / разгрузка API).`,
  );
  const z = results.filter((r) => (r.metrics.poolsRaydium ?? 0) === 0 && r.name.startsWith('gecko_funnel'));
  if (z.length > 0) {
    lines.push(
      `Внимание: в ${z.length} gecko-only прогонах после фильтра было 0 пулов Raydium — воронка Gecko→Raydium может быть пустой на коротком окне; нужны большие страницы/частота тиков/другие страницы API для прод-режима.`,
    );
  }
  if (extrap.observedAverages.avgRpcBillablePerFullTick != null) {
    lines.push(
      `Средний полный тик (эта серия): ~${extrap.observedAverages.avgRpcBillablePerFullTick} billable RPC (~${extrap.observedAverages.avgCreditsEstPerFullTick} кредитов оценочно), вставок wallets ~${extrap.observedAverages.avgWalletsInsertedPerFullTick ?? 0}/тик.`,
    );
    lines.push(
      `Экстраполяция по QuickNode (счётчик RPC): до ~${extrap.extrapolatedTicksPerDay.ifLimitedByQuicknodeRpcCounterOnly ?? 'n/a'} полных тиков/сутки при ~${extrap.referenceLimits.quicknodeBillableRpcPerDayApprox} RPC/день.`,
    );
    lines.push(
      `Экстраполяция по Gecko HTTP: gecko-only среднее ~${extrap.observedAverages.avgGeckoHttpPerGeckoOnlyTick ?? 'n/a'} запросов/тик → ~${extrap.extrapolatedTicksPerDay.ifLimitedByGecko_usingGeckoOnlyTickAvgHttp ?? 'n/a'} тиков/день (теор. потолок по HTTP); полный тик среднее ~${extrap.observedAverages.avgGeckoHttpPerFullTick ?? 'n/a'} Gecko HTTP → ~${extrap.extrapolatedTicksPerDay.ifLimitedByGecko_usingFullTickAvgHttp ?? 'n/a'} тиков/день.`,
    );
    lines.push(
      `Консервативная оценка «что режет раньше»: min(QN, Gecko по полному тику) ≈ ~${extrap.extrapolatedTicksPerDay.conservativeMinOfBoth ?? 'n/a'} тиков/сутки (без учёта других процессов на ключе QN).`,
    );
  }
  lines.push(
    `Это не разовый замер: сохраните отчёт и сравнивайте прогоны по времени суток (выдача new_pools меняется).`,
  );
  return lines;
}

async function main() {
  if (!fs.existsSync(COLLECTOR)) {
    console.error(JSON.stringify({ fatal: 'collector not found', COLLECTOR }));
    process.exit(1);
  }

  /** @type {{ name: string, env: Record<string, string> }[]} */
  const scenarios = [
    {
      name: 'gecko_funnel_p1',
      env: {
        SA_GRWS_GECKO_ONLY_DIAGNOSTIC: '1',
        SA_GRWS_GECKO_PAGES_MAX: '1',
        SA_GRWS_MAX_POOLS_PER_RUN: '15',
      },
    },
    {
      name: 'gecko_funnel_p2',
      env: {
        SA_GRWS_GECKO_ONLY_DIAGNOSTIC: '1',
        SA_GRWS_GECKO_PAGES_MAX: '2',
        SA_GRWS_MAX_POOLS_PER_RUN: '15',
      },
    },
    {
      name: 'gecko_funnel_p4',
      env: {
        SA_GRWS_GECKO_ONLY_DIAGNOSTIC: '1',
        SA_GRWS_GECKO_PAGES_MAX: '4',
        SA_GRWS_MAX_POOLS_PER_RUN: '15',
      },
    },
    {
      name: 'full_tick_shallow',
      env: {
        SA_GRWS_GECKO_PAGES_MAX: '2',
        SA_GRWS_MAX_POOLS_PER_RUN: '8',
        SA_GRWS_SIG_PAGES_MAX: '2',
        SA_GRWS_MAX_TX_FETCHES_PER_POOL: '6',
        SA_GRWS_MAX_RPC_CALLS_PER_TICK: '150',
        SA_GRWS_RPC_SLEEP_MS: '280',
      },
    },
    {
      name: 'full_tick_mid',
      env: {
        SA_GRWS_GECKO_PAGES_MAX: '2',
        SA_GRWS_MAX_POOLS_PER_RUN: '10',
        SA_GRWS_SIG_PAGES_MAX: '3',
        SA_GRWS_MAX_TX_FETCHES_PER_POOL: '12',
        SA_GRWS_MAX_RPC_CALLS_PER_TICK: '280',
        SA_GRWS_RPC_SLEEP_MS: '250',
      },
    },
  ];

  const started = new Date().toISOString();
  /** @type {ReturnType<typeof runScenario>[]} */
  const results = [];

  for (let i = 0; i < scenarios.length; i += 1) {
    const sc = scenarios[i];
    results.push(runScenario(sc.name, sc.env));
    if (i < scenarios.length - 1) await sleep(PAUSE_MS);
  }

  const extrap = extrapolate(results);
  const report = {
    component: 'sa-grws-pilot-diagnose',
    generatedAtUtc: started,
    finishedAtUtc: new Date().toISOString(),
    cwd: CWD,
    pauseMsBetweenScenarios: PAUSE_MS,
    budgetStatePath: BUDGET_PATH,
    scenarios: results,
    extrapolation: extrap,
    summaryRu: summaryRu(results, extrap),
  };

  const outPath = path.join(CWD, 'data', 'sa-grws-pilot-diagnose-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ component: 'sa-grws-pilot-diagnose', err: String(e) }));
  process.exit(1);
});
