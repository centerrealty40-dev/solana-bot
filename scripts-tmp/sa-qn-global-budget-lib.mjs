/**
 * W6.12 S01 — глобальный дневной учёт QuickNode-кредитов (Postgres, FOR UPDATE).
 * Используется оркестратором и другими процессами с общим DATABASE_URL.
 *
 * Reserve перед billable RPC → refund при ошибке ответа RPC (кредиты не списываем за неуспех).
 */

/** @typedef {'wallet_orchestrator' | 'wallet_backfill' | 'sigseed_worker' | 'wallet_trace_worker' | 'scam_farm_rpc_probe' | 'bot_pattern_analyzer'} QnComponentId */

export function utcUsageDateString(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function qnGlobalDailyCapCredits(env = process.env) {
  const raw =
    env.SA_QN_GLOBAL_CREDITS_PER_DAY ??
    env.SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY ??
    '1500000';
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(10_000, Math.floor(n)) : 1_500_000;
}

export function qnCreditsPerRpc(env = process.env) {
  const raw = env.QUICKNODE_CREDITS_PER_SOLANA_RPC ?? '30';
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 30;
}

export function qnGlobalLedgerEnabled(env = process.env) {
  const v = (env.SA_QN_GLOBAL_LEDGER_ENABLED ?? '1').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {import('pg').Pool} pool
 * @param {{ componentId: string, credits: number }} opts
 * @returns {Promise<{ ok: true, creditsUsed: number, creditsRemaining: number } | { ok: false, code: 'QN_GLOBAL_DAY_CAP', creditsUsed: number, creditsRemaining: number, dailyCap: number }>}
 */
export async function qnGlobalReserveCredits(pool, opts) {
  const { componentId, credits } = opts;
  const dailyCap = qnGlobalDailyCapCredits();
  const c = Math.max(0, Math.floor(credits));
  if (c <= 0) return { ok: true, creditsUsed: 0, creditsRemaining: dailyCap };

  const day = utcUsageDateString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO sa_qn_global_daily (usage_date, credits_used, by_component)
       VALUES ($1::date, 0, '{}'::jsonb)
       ON CONFLICT (usage_date) DO NOTHING`,
      [day],
    );
    const locked = await client.query(
      `SELECT credits_used, by_component FROM sa_qn_global_daily WHERE usage_date = $1::date FOR UPDATE`,
      [day],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'QN_GLOBAL_DAY_CAP',
        creditsUsed: 0,
        creditsRemaining: 0,
        dailyCap,
      };
    }
    const used = Number(row.credits_used) || 0;
    if (used + c > dailyCap) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: 'QN_GLOBAL_DAY_CAP',
        creditsUsed: used,
        creditsRemaining: Math.max(0, dailyCap - used),
        dailyCap,
      };
    }
    const bc = { ...(typeof row.by_component === 'object' && row.by_component ? row.by_component : {}) };
    const prevComp = Number(bc[componentId]) || 0;
    bc[componentId] = prevComp + c;
    await client.query(
      `UPDATE sa_qn_global_daily
       SET credits_used = credits_used + $2,
           by_component = $3::jsonb,
           updated_at = now()
       WHERE usage_date = $1::date`,
      [day, c, JSON.stringify(bc)],
    );
    await client.query('COMMIT');
    const nextUsed = used + c;
    return {
      ok: true,
      creditsUsed: nextUsed,
      creditsRemaining: Math.max(0, dailyCap - nextUsed),
    };
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Откат резерва (ошибка RPC до успешного ответа).
 * @param {import('pg').Pool} pool
 * @param {{ componentId: string, credits: number }} opts
 */
export async function qnGlobalRefundCredits(pool, opts) {
  const { componentId, credits } = opts;
  const c = Math.max(0, Math.floor(credits));
  if (c <= 0) return;

  const day = utcUsageDateString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT credits_used, by_component FROM sa_qn_global_daily WHERE usage_date = $1::date FOR UPDATE`,
      [day],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return;
    }
    const used = Math.max(0, Number(row.credits_used) || 0);
    const bc = { ...(typeof row.by_component === 'object' && row.by_component ? row.by_component : {}) };
    const prevComp = Math.max(0, Number(bc[componentId]) || 0);
    const dec = Math.min(c, prevComp, used);
    bc[componentId] = prevComp - dec;
    const nextUsed = Math.max(0, used - dec);
    await client.query(
      `UPDATE sa_qn_global_daily
       SET credits_used = $2,
           by_component = $3::jsonb,
           updated_at = now()
       WHERE usage_date = $1::date`,
      [day, nextUsed, JSON.stringify(bc)],
    );
    await client.query('COMMIT');
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Снимок строки за UTC-день (для CLI).
 * @param {import('pg').Pool} pool
 * @param {string} [usageDate] YYYY-MM-DD
 */
export async function qnGlobalReadSnapshot(pool, usageDate) {
  const day = usageDate || utcUsageDateString();
  const res = await pool.query(
    `SELECT usage_date, credits_used, by_component, updated_at
     FROM sa_qn_global_daily WHERE usage_date = $1::date`,
    [day],
  );
  const row = res.rows[0];
  const dailyCap = qnGlobalDailyCapCredits();
  const used = row ? Number(row.credits_used) || 0 : 0;
  return {
    usageDate: day,
    creditsUsed: used,
    creditsCap: dailyCap,
    creditsRemaining: Math.max(0, dailyCap - used),
    byComponent: row?.by_component && typeof row.by_component === 'object' ? row.by_component : {},
    updatedAt: row?.updated_at ?? null,
  };
}

/** W6.13 — целевой операционный потолок (доля от полного дневного лимита), по умолчанию 70%. */
export function qnOperationalPoolCeilingCredits(env = process.env) {
  const globalCap = qnGlobalDailyCapCredits(env);
  const raw = env.SA_QN_OPERATIONAL_POOL_PCT ?? '70';
  const n = Number(raw);
  const pct = Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 70;
  return Math.floor((globalCap * pct) / 100);
}

export function parseEnvCreditsFloor(env, key, defaultVal = 0) {
  const v = env[key];
  if (v === undefined || v === '') return defaultVal;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : defaultVal;
}

function isTruthyEnv(v) {
  if (v === undefined || v === '') return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

/**
 * Оценка верхней границы кредитов за один прогон backfill (если оператор не задал SA_BACKFILL_MAX_CREDITS_PER_DAY).
 */
export function estimateBackfillRunCreditsCeiling(env = process.env) {
  const cp = qnCreditsPerRpc(env);
  const maxWallets = parseEnvCreditsFloor(env, 'SA_BACKFILL_MAX_WALLETS_PER_RUN', 500) || 500;
  const sigPages = parseEnvCreditsFloor(env, 'SA_BACKFILL_SIG_PAGES_MAX', 3) || 3;
  const maxTx = parseEnvCreditsFloor(env, 'SA_BACKFILL_MAX_TX_PER_WALLET', 40) || 40;
  const perWalletRpc = sigPages + maxTx;
  return maxWallets * perWalletRpc * cp;
}

/**
 * Сводка объявленных потолков для оператора (W6.13 §6–7).
 * @returns {{
 *   globalCap: number,
 *   operationalCeiling: number,
 *   reserveCeiling: number,
 *   orch: number,
 *   backfill: number,
 *   sigseed: number,
 *   walletTrace: number,
 *   scamFarmRpc: number,
 *   botAnalyzer: number,
 *   sumOperationalDeclared: number,
 *   operationalOver: boolean,
 *   reserveOver: boolean,
 *   totalDeclaredOverGlobal: boolean,
 * }}
 */
export function auditOperationalBudgetDeclared(env = process.env) {
  const globalCap = qnGlobalDailyCapCredits(env);
  const operationalCeiling = qnOperationalPoolCeilingCredits(env);
  const reserveCeiling = globalCap - operationalCeiling;

  const orch = parseEnvCreditsFloor(env, 'SA_ORCH_MAX_QUICKNODE_CREDITS_PER_DAY', 1_500_000);

  let backfill = parseEnvCreditsFloor(env, 'SA_BACKFILL_MAX_CREDITS_PER_DAY', 0);
  if (backfill <= 0 && isTruthyEnv(env.SA_BACKFILL_ENABLED)) {
    backfill = estimateBackfillRunCreditsCeiling(env);
  }

  const sigseed = parseEnvCreditsFloor(env, 'SA_SIGSEED_MAX_CREDITS_PER_DAY', 0);
  const walletTrace = parseEnvCreditsFloor(env, 'SA_WALLET_TRACE_MAX_CREDITS_PER_DAY', 0);

  let scamFarmRpc = 0;
  if (isTruthyEnv(env.SCAM_FARM_ENABLE_RPC)) {
    const declared = parseEnvCreditsFloor(env, 'SCAM_FARM_MAX_RPC_CREDITS_PER_DAY', 0);
    if (declared > 0) scamFarmRpc = declared;
    else {
      const budgetCalls = parseEnvCreditsFloor(env, 'SCAM_FARM_RPC_BUDGET', 40);
      scamFarmRpc = budgetCalls * qnCreditsPerRpc(env);
    }
  }

  const botAnalyzer = parseEnvCreditsFloor(env, 'SA_BOT_ANALYZER_MAX_CREDITS_PER_DAY', 0);

  const sumOperationalDeclared = orch + backfill + sigseed + walletTrace + scamFarmRpc;
  const operationalOver = sumOperationalDeclared > operationalCeiling;
  const reserveOver = botAnalyzer > reserveCeiling;
  const totalDeclaredOverGlobal = sumOperationalDeclared + botAnalyzer > globalCap;

  return {
    globalCap,
    operationalCeiling,
    reserveCeiling,
    orch,
    backfill,
    sigseed,
    walletTrace,
    scamFarmRpc,
    botAnalyzer,
    sumOperationalDeclared,
    operationalOver,
    reserveOver,
    totalDeclaredOverGlobal,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {{ component?: string }} ctx
 */
export function logOperationalBudgetWarnings(env = process.env, ctx = {}) {
  const tag = ctx.component ? `[${ctx.component}]` : '[budget]';
  const a = auditOperationalBudgetDeclared(env);
  if (a.operationalOver) {
    console.warn(
      `${tag} W6.13: сумма объявленных операционных потолков (${a.sumOperationalDeclared}) превышает целевой операционный потолок 70% (${a.operationalCeiling}) при SA_QN_GLOBAL_CREDITS_PER_DAY=${a.globalCap}. Снизите ENV-потолки или частоту cron.`,
    );
  }
  if (a.reserveOver && a.botAnalyzer > 0) {
    console.warn(
      `${tag} W6.13: SA_BOT_ANALYZER_MAX_CREDITS_PER_DAY=${a.botAnalyzer} превышает резерв ~30% (${a.reserveCeiling}) от глобального лимита.`,
    );
  }
  if (a.totalDeclaredOverGlobal && a.botAnalyzer > 0) {
    console.warn(
      `${tag} W6.13: операционные потолки + резерв анализатора (${a.sumOperationalDeclared}+${a.botAnalyzer}) превышают SA_QN_GLOBAL_CREDITS_PER_DAY=${a.globalCap}.`,
    );
  }
  return a;
}
