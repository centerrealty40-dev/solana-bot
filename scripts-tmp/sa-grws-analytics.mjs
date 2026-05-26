/**
 * SA-GRWS — сводная аналитика пилота: кошельки по времени (Postgres), RPC/Gecko за UTC‑сутки (budget state),
 * последние тики (JSONL), сравнение с лимитами QuickNode и Gecko Terminal.
 *
 * Usage:
 *   DATABASE_URL=... node scripts-tmp/sa-grws-analytics.mjs
 *   node scripts-tmp/sa-grws-analytics.mjs --no-db
 *   node scripts-tmp/sa-grws-analytics.mjs --hours=48 --tick-lines=80
 *   node scripts-tmp/sa-grws-analytics.mjs --assume-daemon
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const { Pool } = pg;

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

const DATABASE_URL = process.env.DATABASE_URL || process.env.SA_PG_DSN;
const COLLECTOR_ID = envStr('SA_GRWS_COLLECTOR_ID', 'sa-grws');
const QN_CREDITS_PER_RPC_CALL = Math.max(1, envNum('QUICKNODE_CREDITS_PER_SOLANA_RPC', 30));
const SA_GRWS_MAX_QN_CREDITS_PER_DAY = Math.max(1000, envNum('SA_GRWS_MAX_QUICKNODE_CREDITS_PER_DAY', 1_500_000));
const SA_GRWS_RPC_BUDGET_HEADROOM = Math.min(1, Math.max(0.5, envNum('SA_GRWS_RPC_BUDGET_HEADROOM', 0.94)));
const SA_GRWS_MAX_RPC_CALLS_PER_TICK = Math.max(0, envNum('SA_GRWS_MAX_RPC_CALLS_PER_TICK', 0));
const SA_GRWS_GECKO_TARGET_CPM = Math.max(1, Math.min(60, envNum('SA_GRWS_GECKO_TARGET_CALLS_PER_MINUTE', 28)));
const SA_GRWS_GECKO_MIN_INTERVAL_MS_RAW = Math.max(0, envNum('SA_GRWS_GECKO_MIN_INTERVAL_MS', 0));
function geckoMinIntervalMs() {
  if (SA_GRWS_GECKO_MIN_INTERVAL_MS_RAW > 0) return SA_GRWS_GECKO_MIN_INTERVAL_MS_RAW;
  return Math.ceil(60000 / SA_GRWS_GECKO_TARGET_CPM);
}
const SA_GRWS_MAX_GECKO_HTTP_PER_DAY = Math.max(10, envNum('SA_GRWS_MAX_GECKO_HTTP_PER_DAY', 40_000));
/** Для блока «плановый кап RPC/тик» считать режим как у `sa-grws-collector --daemon`. */
const DAEMON_ASSUMED =
  process.argv.includes('--assume-daemon') || process.env.SA_GRWS_ANALYTICS_ASSUME_DAEMON === '1';
const INTERVAL_MS = Math.max(60_000, envNum('SA_GRWS_INTERVAL_MS', 600_000));

const NO_DB = process.argv.includes('--no-db');
const argvHours = (() => {
  const a = process.argv.find((x) => x.startsWith('--hours='));
  if (!a) return 72;
  const n = Number(a.slice('--hours='.length));
  return Number.isFinite(n) && n > 0 ? Math.min(168, n) : 72;
})();
const TICK_LINES = (() => {
  const a = process.argv.find((x) => x.startsWith('--tick-lines='));
  if (!a) return 120;
  const n = Number(a.slice('--tick-lines='.length));
  return Number.isFinite(n) && n > 0 ? Math.min(500, n) : 120;
})();

function budgetStatePath() {
  return envStr('SA_GRWS_BUDGET_STATE_PATH', path.join(process.cwd(), 'data', 'sa-grws-budget-state.json'));
}

function tickLogPath() {
  const p = envStr('SA_GRWS_TICK_LOG_PATH', '').trim();
  return p ? path.resolve(process.cwd(), p) : path.join(process.cwd(), 'data', 'sa-grws-ticks.jsonl');
}

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function utcMidnightIso() {
  const n = new Date();
  const y = n.getUTCFullYear();
  const mo = String(n.getUTCMonth() + 1).padStart(2, '0');
  const d = String(n.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}T00:00:00.000Z`;
}

function minutesSinceUtcMidnight() {
  const n = new Date();
  const ms =
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes(), n.getUTCSeconds()) -
    Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  return Math.max(1 / 60, ms / 60000);
}

function readBudgetStateFile() {
  const p = budgetStatePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    return {
      path: p,
      exists: true,
      day: typeof j.day === 'string' ? j.day : null,
      rpcCallsDay: Number(j.rpcCallsDay) || 0,
      geckoCallsDay: Number(j.geckoCallsDay) || 0,
      updatedAtMs: Number(j.updatedAtMs) || null,
    };
  } catch {
    return {
      path: p,
      exists: false,
      day: null,
      rpcCallsDay: 0,
      geckoCallsDay: 0,
      updatedAtMs: null,
    };
  }
}

function readRecentTicks(filePath, maxLines) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, lines: [], aggregates: null };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\n/).filter(Boolean);
  const slice = lines.slice(-maxLines);
  /** @type {object[]} */
  const parsed = [];
  for (const ln of slice) {
    try {
      parsed.push(JSON.parse(ln));
    } catch {
      /* skip */
    }
  }
  const completed = parsed.filter((x) => x.kind === 'tick_completed');
  const skipped = parsed.filter((x) => x.kind === 'tick_skipped');
  let sumRpc = 0;
  let sumCredits = 0;
  let sumIns = 0;
  let sumUnique = 0;
  let sumGecko = 0;
  for (const t of completed) {
    sumRpc += Number(t.rpcBillableCalls) || 0;
    sumCredits += Number(t.estimatedQuicknodeCredits) || 0;
    sumIns += Number(t.walletsInserted) || 0;
    sumUnique += Number(t.walletsUnique) || 0;
    sumGecko += Number(t.geckoHttpCallsThisTick) || 0;
  }
  const n = completed.length || 1;
  return {
    path: filePath,
    exists: true,
    linesRead: slice.length,
    ticksCompletedInWindow: completed.length,
    ticksSkippedInWindow: skipped.length,
    lastSkippedReasons: skipped.slice(-5).map((s) => s.reason),
    lastTick: completed[completed.length - 1] ?? parsed[parsed.length - 1] ?? null,
    aggregates:
      completed.length > 0
        ? {
            avgRpcPerTick: Math.round((sumRpc / n) * 100) / 100,
            avgCreditsPerTick: Math.round((sumCredits / n) * 100) / 100,
            avgWalletsInsertedPerTick: Math.round((sumIns / n) * 100) / 100,
            avgWalletsUniquePerTick: Math.round((sumUnique / n) * 100) / 100,
            avgGeckoHttpPerTick: Math.round((sumGecko / n) * 100) / 100,
            sumRpcLastN: sumRpc,
            sumCreditsLastN: sumCredits,
            sumWalletsInsertedLastN: sumIns,
          }
        : null,
  };
}

async function queryWalletRollups(pool) {
  const id = COLLECTOR_ID;
  const utcStart = utcMidnightIso();
  const hours = argvHours;

  const [
    total,
    n15m,
    n1h,
    n6h,
    n24h,
    nHours,
    nUtcDay,
    hourly,
  ] = await Promise.all([
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1`,
      [id],
    ),
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1
       AND first_seen_at >= now() - interval '15 minutes'`,
      [id],
    ),
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1
       AND first_seen_at >= now() - interval '1 hour'`,
      [id],
    ),
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1
       AND first_seen_at >= now() - interval '6 hours'`,
      [id],
    ),
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1
       AND first_seen_at >= now() - interval '24 hours'`,
      [id],
    ),
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1
       AND first_seen_at >= now() - make_interval(hours => $2::int)`,
      [id, hours],
    ),
    pool.query(
      `SELECT count(*)::bigint AS c FROM wallets WHERE coalesce(metadata->>'collector_id','') = $1
       AND first_seen_at >= $2::timestamptz`,
      [id, utcStart],
    ),
    pool.query(
      `SELECT to_char(
                date_trunc('hour', first_seen_at AT TIME ZONE 'UTC'),
                'YYYY-MM-DD"T"HH24:00:00"Z"'
              ) AS hour_start_utc,
              count(*)::int AS n
       FROM wallets
       WHERE coalesce(metadata->>'collector_id','') = $1
         AND first_seen_at >= now() - make_interval(hours => $2::int)
       GROUP BY 1
       ORDER BY 1 ASC`,
      [id, hours],
    ),
  ]);

  const totalN = Number(total.rows[0]?.c ?? 0);
  const n15 = Number(n15m.rows[0]?.c ?? 0);
  const n1 = Number(n1h.rows[0]?.c ?? 0);
  const n6 = Number(n6h.rows[0]?.c ?? 0);
  const n24 = Number(n24h.rows[0]?.c ?? 0);
  const nH = Number(nHours.rows[0]?.c ?? 0);
  const nDay = Number(nUtcDay.rows[0]?.c ?? 0);

  return {
    collectorId: id,
    total: totalN,
    newWallets: {
      last15Minutes: n15,
      last1Hour: n1,
      last6Hours: n6,
      last24Hours: n24,
      lastHoursWindow: nH,
      hoursWindow: hours,
      sinceUtcMidnight: nDay,
      utcMidnightIso: utcStart,
      ratesPerHour: {
        derivedFromLast15Min: n15 > 0 ? Math.round((n15 / 0.25) * 100) / 100 : 0,
        derivedFromLast1Hour: n1,
        derivedFromLast24Hours: n24 > 0 ? Math.round((n24 / 24) * 100) / 100 : 0,
      },
    },
    hourlyBucketsUtc: hourly.rows.map((r) => ({
      hourStartUtc: r.hour_start_utc,
      count: r.n,
    })),
  };
}

function buildReport(dbPart, budgetFile, tickPart) {
  const maxRpcPerDay = Math.floor(SA_GRWS_MAX_QN_CREDITS_PER_DAY / QN_CREDITS_PER_RPC_CALL);
  const ticksPerDay = DAEMON_ASSUMED ? Math.max(1, Math.floor(86400000 / INTERVAL_MS)) : 1;
  const autoTickCap = DAEMON_ASSUMED
    ? Math.max(1, Math.floor((maxRpcPerDay / ticksPerDay) * SA_GRWS_RPC_BUDGET_HEADROOM))
    : maxRpcPerDay;
  const effectiveTickCap =
    SA_GRWS_MAX_RPC_CALLS_PER_TICK > 0
      ? Math.min(SA_GRWS_MAX_RPC_CALLS_PER_TICK, maxRpcPerDay)
      : autoTickCap;

  const rpcToday = budgetFile.rpcCallsDay;
  const creditsEst = rpcToday * QN_CREDITS_PER_RPC_CALL;
  const creditsRemaining = Math.max(0, SA_GRWS_MAX_QN_CREDITS_PER_DAY - creditsEst);
  const rpcRemaining = Math.max(0, maxRpcPerDay - rpcToday);
  const qnPct = SA_GRWS_MAX_QN_CREDITS_PER_DAY > 0 ? (creditsEst / SA_GRWS_MAX_QN_CREDITS_PER_DAY) * 100 : 0;

  const geckoToday = budgetFile.geckoCallsDay;
  const geckoSoftPct = SA_GRWS_MAX_GECKO_HTTP_PER_DAY > 0 ? (geckoToday / SA_GRWS_MAX_GECKO_HTTP_PER_DAY) * 100 : 0;
  const mins = minutesSinceUtcMidnight();
  const sustainedCeilingSinceMidnight = mins * SA_GRWS_GECKO_TARGET_CPM;
  const geckoVsThrottleModel =
    sustainedCeilingSinceMidnight > 0 ? geckoToday / sustainedCeilingSinceMidnight : null;

  const stateDayMatchesUtc = budgetFile.day === utcDayKey();

  /** @type {string[]} */
  const summaryRu = [];

  if (dbPart) {
    summaryRu.push(
      `Кошельки (${dbPart.collectorId}): всего в БД ${dbPart.total}; за последние 15 мин — ${dbPart.newWallets.last15Minutes}; за 1 ч — ${dbPart.newWallets.last1Hour}; за 24 ч — ${dbPart.newWallets.last24Hours}; с начала UTC‑суток — ${dbPart.newWallets.sinceUtcMidnight}.`,
    );
    summaryRu.push(
      `Оценка скорости: до ${dbPart.newWallets.ratesPerHour.derivedFromLast15Min} кош/ч (из 15‑мин окна, шумно при малых N); среднее за 24 ч — ${dbPart.newWallets.ratesPerHour.derivedFromLast24Hours} кош/ч.`,
    );
  } else {
    summaryRu.push('БД не запрашивалась (--no-db или нет DATABASE_URL): счётчики кошельков по времени недоступны.');
  }

  summaryRu.push(
    `QuickNode (оценка по счётчику коллектора): сегодня UTC ~${creditsEst} кредитов из лимита ${SA_GRWS_MAX_QN_CREDITS_PER_DAY} (${qnPct.toFixed(1)}%); billable RPC ${rpcToday}/${maxRpcPerDay}; осталось ~${creditsRemaining} кредитов (~${rpcRemaining} RPC).`,
  );

  summaryRu.push(
    `Gecko HTTP (факт из state): ${geckoToday} вызовов за UTC‑день; soft‑cap ${SA_GRWS_MAX_GECKO_HTTP_PER_DAY} (${geckoSoftPct.toFixed(1)}%). Ориентир провайдера ~30 вызовов/мин; в конфиге цель ${SA_GRWS_GECKO_TARGET_CPM}/мин (интервал ~${geckoMinIntervalMs()} ms).`,
  );

  if (geckoVsThrottleModel !== null) {
    summaryRu.push(
      `Модель «если бы крутились ровно с целевым CPM с UTC‑полуночи»: потолок ~${Math.round(sustainedCeilingSinceMidnight)} вызовов; факт/модель = ${(geckoVsThrottleModel * 100).toFixed(1)}% (≈1.0 — постоянная нагрузка на троттлинг; <<1 — редкие тики или обход Gecko через seed).`,
    );
  }

  if (!budgetFile.exists) {
    summaryRu.push(
      `Файл бюджета не найден (${budgetFile.path}) — после первого тика коллектора появятся rpcCallsDay/geckoCallsDay.`,
    );
  } else if (!stateDayMatchesUtc) {
    summaryRu.push(
      `Внимание: в state указан day=${budgetFile.day}, сегодня UTC ${utcDayKey()} — возможно коллектор не работал с полуночи или файл старый.`,
    );
  }

  if (tickPart.exists && tickPart.aggregates) {
    summaryRu.push(
      `Последние ${tickPart.ticksCompletedInWindow} завершённых тиков (JSONL): в среднем ~${tickPart.aggregates.avgCreditsPerTick} кредитов/тик, ~${tickPart.aggregates.avgRpcPerTick} RPC/тик, вставлено кошельков ~${tickPart.aggregates.avgWalletsInsertedPerTick}/тик (уникальных в тике ~${tickPart.aggregates.avgWalletsUniquePerTick}).`,
    );
  } else if (!tickPart.exists) {
    summaryRu.push(
      `Журнал тиков не найден (${tickPart.path}). Включите SA_GRWS_TICK_LOG_PATH=data/sa-grws-ticks.jsonl в env коллектора для траектории тиков.`,
    );
  }

  const geckoHittingSoftCap = geckoSoftPct >= 95;
  const geckoSaturatingThrottle =
    geckoVsThrottleModel !== null && geckoVsThrottleModel >= 0.92 && geckoToday >= 30;
  const qnNearCap = qnPct >= 95;

  return {
    component: 'sa-grws-analytics',
    generatedAtUtc: new Date().toISOString(),
    utcCalendarDay: utcDayKey(),
    configEcho: {
      collectorId: COLLECTOR_ID,
      QUICKNODE_CREDITS_PER_SOLANA_RPC: QN_CREDITS_PER_RPC_CALL,
      SA_GRWS_MAX_QUICKNODE_CREDITS_PER_DAY: SA_GRWS_MAX_QN_CREDITS_PER_DAY,
      SA_GRWS_GECKO_TARGET_CALLS_PER_MINUTE: SA_GRWS_GECKO_TARGET_CPM,
      SA_GRWS_GECKO_MIN_INTERVAL_MS: SA_GRWS_GECKO_MIN_INTERVAL_MS_RAW || null,
      geckoMinIntervalMsComputed: geckoMinIntervalMs(),
      SA_GRWS_MAX_GECKO_HTTP_PER_DAY: SA_GRWS_MAX_GECKO_HTTP_PER_DAY,
      SA_GRWS_INTERVAL_MS: INTERVAL_MS,
      assumeDaemonForTickCap: DAEMON_ASSUMED,
      effectiveRpcCallsPerTickCapPlan: effectiveTickCap,
      GECKO_PUBLIC_REF_LIMIT_CALLS_PER_MINUTE: 30,
    },
    walletsFromDb: dbPart,
    budgetStateFile: budgetFile,
    minutesSinceUtcMidnightApprox: Math.round(mins * 100) / 100,
    quicknodeEstimate: {
      billableRpcCallsTodayUtc: rpcToday,
      maxBillableRpcCallsPerDay: maxRpcPerDay,
      estimatedCreditsConsumedToday: creditsEst,
      maxCreditsPerDay: SA_GRWS_MAX_QN_CREDITS_PER_DAY,
      estimatedCreditsRemainingToday: creditsRemaining,
      budgetUsedPct: Math.round(qnPct * 100) / 100,
      creditsPerRpcAssumed: QN_CREDITS_PER_RPC_CALL,
      note:
        'Это оценка по локальному счётчику коллектора, не замена биллинга QuickNode. Другие процессы на том же ключе добавляют расход.',
    },
    gecko: {
      httpCallsTodayUtc: geckoToday,
      softCapPerDay: SA_GRWS_MAX_GECKO_HTTP_PER_DAY,
      softCapUsedPct: Math.round(geckoSoftPct * 100) / 100,
      targetCallsPerMinuteConfigured: SA_GRWS_GECKO_TARGET_CPM,
      referencePublicApiCallsPerMinute: 30,
      sustainedCeilingCallsSinceUtcMidnightIfContinuous: Math.round(sustainedCeilingSinceMidnight),
      actualToSustainedModelRatio: geckoVsThrottleModel !== null ? Math.round(geckoVsThrottleModel * 1000) / 1000 : null,
      interpretation: {
        nearDailySoftCap: geckoHittingSoftCap,
        likelyContinuouslyThrottleLimited: geckoSaturatingThrottle,
        note429Risk:
          '429 от Gecko возможны при ретраях или если лимит провайдера ниже ожидаемого; смотрите логи коллектора и geckoHttpCallsThisTick.',
      },
    },
    tickLog: tickPart,
    diagnosisFlags: {
      quicknodeBudgetNearlyExhausted: qnNearCap,
      geckoDailySoftCapNearlyExhausted: geckoHittingSoftCap,
      budgetStateDayAlignedWithUtcToday: budgetFile.exists ? stateDayMatchesUtc : null,
      budgetStateFilePresent: budgetFile.exists,
    },
    summaryRu,
  };
}

async function main() {
  if (!NO_DB && !DATABASE_URL) {
    console.error(
      JSON.stringify({
        component: 'sa-grws-analytics',
        level: 'error',
        msg: 'Set DATABASE_URL or SA_PG_DSN, or run with --no-db for budget/ticks-only report.',
      }),
    );
    process.exit(2);
  }

  const budgetFile = readBudgetStateFile();
  const tickPart = readRecentTicks(tickLogPath(), TICK_LINES);

  /** @type {Awaited<ReturnType<typeof queryWalletRollups>> | null} */
  let dbPart = null;
  if (!NO_DB && DATABASE_URL) {
    const pool = new Pool({ connectionString: DATABASE_URL });
    try {
      dbPart = await queryWalletRollups(pool);
    } finally {
      await pool.end();
    }
  }

  const report = buildReport(dbPart, budgetFile, tickPart);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ component: 'sa-grws-analytics', level: 'error', err: String(e) }));
  process.exit(1);
});
