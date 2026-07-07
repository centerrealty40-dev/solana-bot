/**
 * Shared collector health assessment for Oscar Telegram status/alerts.
 * Pure helpers — no I/O except where noted in the main script.
 */

export const DEFAULT_DEX_COLLECTORS = ['raydium', 'meteora', 'moonshot', 'pumpswap'];

export const DEFAULT_PM2_COLLECTORS = DEFAULT_DEX_COLLECTORS.map((n) => `sa-${n}`);

export const DEFAULT_SNAPSHOT_SOURCES = [
  { source: 'pumpswap', table: 'pumpswap_pair_snapshots' },
  { source: 'raydium', table: 'raydium_pair_snapshots' },
  { source: 'meteora', table: 'meteora_pair_snapshots' },
  { source: 'moonshot', table: 'moonshot_pair_snapshots' },
];

/** Default tick-stale limits aligned with ecosystem *_COLLECTOR_INTERVAL_MS (+ slack). */
export const DEFAULT_COLLECTOR_TICK_STALE_MS = {
  raydium: 300_000,
  meteora: 300_000,
  moonshot: 300_000,
  pumpswap: 240_000,
};

/**
 * Parse `COLLECTOR_HEALTH_TICK_STALE_BY_COLLECTOR=pumpswap=240000,meteora=300000`.
 * @param {string|undefined} raw
 */
export function parseCollectorTickStaleOverrides(raw) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const part of String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const ms = Number(part.slice(eq + 1).trim());
    if (!key || !Number.isFinite(ms) || ms < 30_000) continue;
    out[key] = ms;
  }
  return out;
}

/**
 * @param {string} collector
 * @param {Record<string, number>|undefined} overrides
 * @param {number} fallbackMs
 */
export function resolveCollectorTickStaleMs(collector, overrides, fallbackMs) {
  const key = String(collector).toLowerCase();
  const override = overrides?.[key];
  if (override != null && Number.isFinite(override)) return override;
  const preset = DEFAULT_COLLECTOR_TICK_STALE_MS[key];
  if (preset != null && Number.isFinite(preset)) return preset;
  return fallbackMs;
}

/** @param {string} raw */
export function parseSkipSources(raw) {
  return new Set(
    String(raw ?? 'orca,moonshot')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** @param {unknown} apps */
export function indexPm2Apps(apps) {
  /** @type {Map<string, { status: string, uptime: number|null, restarts: number|null }>} */
  const out = new Map();
  if (!Array.isArray(apps)) return out;
  for (const app of apps) {
    const name = app?.name;
    if (!name) continue;
    out.set(String(name), {
      status: String(app?.pm2_env?.status ?? 'unknown'),
      uptime: typeof app?.pm2_env?.pm_uptime === 'number' ? app.pm2_env.pm_uptime : null,
      restarts: typeof app?.pm2_env?.restart_time === 'number' ? app.pm2_env.restart_time : null,
    });
  }
  return out;
}

/**
 * @param {Map<string, { status: string }>} pm2
 * @param {string[]} names
 */
export function assessPm2Processes(pm2, names) {
  return names.map((name) => {
    const row = pm2.get(name);
    const status = row?.status ?? 'missing';
    const online = status === 'online';
    return { name, status, online, blind: !online };
  });
}

/**
 * @param {Record<string, number>|undefined} lastTickCompletedAt
 * @param {string[]} collectors — short names (raydium, …)
 * @param {number} nowMs
 * @param {number} maxStaleMs — global fallback when no per-collector preset/override
 * @param {Record<string, number>|undefined} perCollectorStaleMs — env overrides
 */
export function assessCollectorTickAges(
  lastTickCompletedAt,
  collectors,
  nowMs,
  maxStaleMs,
  perCollectorStaleMs = undefined,
) {
  const map = lastTickCompletedAt && typeof lastTickCompletedAt === 'object' ? lastTickCompletedAt : {};
  return collectors.map((coll) => {
    const ts = map[coll];
    const ageMs = typeof ts === 'number' && ts > 0 ? Math.max(0, nowMs - ts) : null;
    const limitMs = resolveCollectorTickStaleMs(coll, perCollectorStaleMs, maxStaleMs);
    const stale = ageMs == null || ageMs > limitMs;
    return {
      collector: coll,
      lastTickMs: typeof ts === 'number' ? ts : null,
      ageMs,
      maxStaleMs: limitMs,
      stale,
      blind: stale,
    };
  });
}

/**
 * @param {Array<{ source: string, ageSec: number|null, ok: boolean, error?: string }>} rows
 * @param {number} maxAgeSec
 * @param {Set<string>} skipSources
 */
export function assessSnapshotRows(rows, maxAgeSec, skipSources) {
  const monitored = rows.filter((r) => !skipSources.has(String(r.source).toLowerCase()));
  const staleRows = monitored.filter(
    (r) => !r.ok || r.ageSec == null || !Number.isFinite(r.ageSec) || r.ageSec > maxAgeSec,
  );
  const worstAgeSec = monitored.reduce((acc, r) => {
    if (r.ageSec == null || !Number.isFinite(r.ageSec)) return acc;
    return acc == null || r.ageSec > acc ? r.ageSec : acc;
  }, /** @type {number|null} */ (null));
  return {
    rows: monitored,
    staleRows,
    worstAgeSec,
    blind: staleRows.length > 0,
  };
}

/**
 * @param {{ enabled: boolean, maxRpm: number, nextAllowedMs?: number, updatedAt?: number }} gate
 * @param {number} nowMs
 */
export function assessDexscreenerGate(gate, nowMs) {
  if (!gate.enabled) {
    return { enabled: false, throttled: false, maxRpm: gate.maxRpm, blind: false, note: 'gate_off' };
  }
  const next = gate.nextAllowedMs ?? 0;
  const throttled = next > nowMs + 500;
  const waitMs = throttled ? next - nowMs : 0;
  return {
    enabled: true,
    throttled,
    waitMs,
    maxRpm: gate.maxRpm,
    blind: false,
    warn: throttled && waitMs > 30_000,
  };
}

/**
 * @param {{ shadowEnabled: boolean, primaryEnabled: boolean, defiMcapEnabled: boolean, lastStatus: string|null, lastStatusAgeMs: number|null, maxStaleMs: number }} input
 */
export function assessShyftStatus(input) {
  const active = input.shadowEnabled || input.primaryEnabled || input.defiMcapEnabled;
  if (!active) {
    return { active: false, blind: false, status: 'off', detail: null, ageMs: null };
  }
  const status = input.lastStatus ?? 'unknown';
  const ageMs = input.lastStatusAgeMs;
  const badStatus = status !== 'connected';
  const stale = ageMs == null || ageMs > input.maxStaleMs;
  const blind = input.primaryEnabled && (badStatus || stale);
  return {
    active: true,
    primaryEnabled: input.primaryEnabled,
    shadowEnabled: input.shadowEnabled,
    defiMcapEnabled: input.defiMcapEnabled,
    status,
    ageMs,
    blind,
    warn: active && (badStatus || stale) && !input.primaryEnabled,
  };
}

/** @param {{ birdeyePrimary: boolean, birdeyeCollector: boolean }} flags */
export function assessBirdeyeConfig(flags) {
  const enabled = flags.birdeyePrimary || flags.birdeyeCollector;
  return {
    enabled,
    primary: flags.birdeyePrimary,
    collector: flags.birdeyeCollector,
    wouldBlindIfOff: !enabled,
    note: enabled ? 'on' : 'off (DexScreener covers Oscar)',
  };
}

/** @param {{ updatedAt?: string, discovered?: number, evaluated?: number, opened?: number }|null} data @param {number|null} fileAgeMs @param {number} maxAgeMs @param {boolean} strategyOnline */
export function assessDiscoveryHealthFile(data, fileAgeMs, maxAgeMs, strategyOnline) {
  if (!strategyOnline) {
    return { present: !!data, fileAgeMs, blind: false, skipped: true };
  }
  const stale = fileAgeMs == null || fileAgeMs > maxAgeMs;
  return {
    present: !!data,
    fileAgeMs,
    discovered: data?.discovered ?? null,
    evaluated: data?.evaluated ?? null,
    opened: data?.opened ?? null,
    stale,
    blind: stale,
    skipped: false,
  };
}

/** @param {Array<{ source: string, total: number, mcapNullPct: number|null, volNullPct: number|null }>} rows @param {number} warnPct */
export function assessNullRates(rows, warnPct = 40) {
  const flagged = rows.filter(
    (r) =>
      r.total > 0 &&
      ((r.mcapNullPct != null && r.mcapNullPct >= warnPct) ||
        (r.volNullPct != null && r.volNullPct >= warnPct)),
  );
  return { rows, flagged, warn: flagged.length > 0 };
}

/**
 * @param {Array<{ name: string, status: string, heartbeatAgeMs: number|null, maxStaleMs: number }>} strategies
 */
export function assessStrategyHeartbeats(strategies) {
  return strategies.map((s) => {
    const online = s.status === 'online';
    const hbStale =
      online &&
      (s.heartbeatAgeMs == null || s.heartbeatAgeMs > s.maxStaleMs);
    return {
      name: s.name,
      status: s.status,
      heartbeatAgeMs: s.heartbeatAgeMs,
      blind: !online || hbStale,
      warn: hbStale,
    };
  });
}

/** @param {{ blind: boolean, warns?: boolean, reasons?: string[] }} summary */
export function computeOverall(summary) {
  return {
    ok: !summary.blind && !summary.warns,
    blind: summary.blind,
    degraded: summary.blind || !!summary.warns,
  };
}

export function formatAgeShort(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return '?';
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s`;
  return `${Math.round(ageMs / 60_000)}m`;
}

export function formatAgeSec(ageSec) {
  if (ageSec == null || !Number.isFinite(ageSec)) return '?';
  if (ageSec < 120) return `${Math.round(ageSec)}s`;
  return `${Math.round(ageSec / 60)}m`;
}

/**
 * Build compact Telegram body.
 * @param {object} ctx
 */
export function buildCollectorHealthBody(ctx) {
  const lines = [];
  const head = ctx.blind
    ? '🚨 Oscar collectors BLIND / degraded'
    : ctx.warn
      ? '⚠️ Oscar collectors — warnings'
      : '✅ Oscar collectors OK';
  lines.push(head);

  const dexLines = ctx.collectors.map((c) => {
    const pm2 = ctx.pm2.find((p) => p.name === `sa-${c.collector}`) ?? ctx.pm2.find((p) => p.name === c.collector);
    const icon = c.blind || pm2?.blind ? '❌' : '✅';
    const tick = formatAgeShort(c.ageMs);
    const st = pm2?.status ?? '?';
    return `${icon} ${c.collector}: pm2=${st} tick=${tick}`;
  });
  lines.push(`DEX:\n${dexLines.join('\n')}`);

  const snapParts = ctx.snapshots.rows.map(
    (r) => `${r.source}=${formatAgeSec(r.ageSec)}${r.ok ? '' : ' STALE'}`,
  );
  lines.push(
    `PG: worst=${formatAgeSec(ctx.snapshots.worstAgeSec)}${ctx.snapshots.blind ? ' BLIND' : ''} ${snapParts.join(' ')}`,
  );

  const shyft = ctx.shyft;
  lines.push(
    `Shyft: ${shyft.active ? `primary=${shyft.primaryEnabled ? 'on' : 'off'} stream=${shyft.status} age=${formatAgeShort(shyft.ageMs)}${shyft.blind ? ' BLIND' : ''}` : 'off'}`,
  );

  const dexGate = ctx.dexscreener;
  lines.push(
    `DexScreener: ${dexGate.enabled ? `rpm≤${dexGate.maxRpm}${dexGate.throttled ? ` throttled ${formatAgeShort(dexGate.waitMs)}` : ' ok'} 429(15m)=${ctx.rate429Total ?? 0}` : 'gate off'}`,
  );

  lines.push(
    `Birdeye: ${ctx.birdeye.enabled ? 'on' : 'off'}${ctx.birdeye.wouldBlindIfOff ? ' (premium off — PG gaps possible on birdeye-only paths)' : ''}`,
  );

  const disc = ctx.discovery;
  if (!disc.skipped) {
    lines.push(
      `Discovery: file=${formatAgeShort(disc.fileAgeMs)} cand=${disc.discovered ?? '?'} eval=${disc.evaluated ?? '?'}${disc.blind ? ' BLIND' : ''}`,
    );
  }

  if (ctx.strategies?.length) {
    const st = ctx.strategies
      .map((s) => `${s.name}=${s.status}${s.heartbeatAgeMs != null ? `@${formatAgeShort(s.heartbeatAgeMs)}` : ''}`)
      .join(' | ');
    lines.push(`Strategies: ${st}`);
  }

  if (ctx.nullRates?.flagged?.length) {
    const parts = ctx.nullRates.flagged.map(
      (r) => `${r.source} mcap_null=${r.mcapNullPct ?? '?'}% vol_null=${r.volNullPct ?? '?'}%`,
    );
    lines.push(`Data quality (15m): ${parts.join('; ')}`);
  }

  if (ctx.reasons?.length) {
    lines.push(`Issues:\n${ctx.reasons.map((r) => `• ${r}`).join('\n')}`);
  }

  if (ctx.blind) {
    lines.push('Action: pm2 restart sa-pumpswap sa-raydium sa-meteora sa-moonshot; check pm2 logs');
  }

  return lines.join('\n');
}

/**
 * @param {boolean} prevBlind
 * @param {boolean} nowBlind
 * @param {number} lastAlertAt
 * @param {number} nowMs
 * @param {number} repeatMs
 */
export function shouldSendBlindAlert(prevBlind, nowBlind, lastAlertAt, nowMs, repeatMs) {
  if (nowBlind && !prevBlind) return true;
  if (nowBlind && prevBlind && nowMs - lastAlertAt >= repeatMs) return true;
  return false;
}

/**
 * @param {boolean} degraded
 * @param {number} lastStatusAt
 * @param {number} nowMs
 * @param {number} intervalMs
 * @param {boolean} forceOnRecovery
 * @param {boolean} wasBlind
 */
export function shouldSendStatusReport(degraded, lastStatusAt, nowMs, intervalMs, forceOnRecovery, wasBlind) {
  if (forceOnRecovery && wasBlind && !degraded) return true;
  if (nowMs - lastStatusAt >= intervalMs) return true;
  return false;
}

/** Parse tail of live JSONL for last Shyft status event. */
export function parseLastShyftStatusFromJsonlTail(text, nowMs = Date.now()) {
  if (!text) return { status: null, detail: null, ageMs: null, eventTsMs: null };
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const j = JSON.parse(lines[i]);
      if (j?.kind !== 'live_shyft_shadow_status') continue;
      const eventTsMs =
        typeof j.ts === 'number'
          ? j.ts
          : typeof j.ts === 'string'
            ? Date.parse(j.ts)
            : null;
      const ageMs =
        eventTsMs != null && Number.isFinite(eventTsMs) ? Math.max(0, nowMs - eventTsMs) : null;
      return {
        status: j.status != null ? String(j.status) : null,
        detail: j.detail != null ? String(j.detail) : null,
        ageMs,
        eventTsMs,
      };
    } catch {
      /* skip bad line */
    }
  }
  return { status: null, detail: null, ageMs: null, eventTsMs: null };
}
