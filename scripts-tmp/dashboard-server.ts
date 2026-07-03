/**
 * Live Paper-Trader Dashboard
 *
 * - Читает /tmp/paper-trades.jsonl на каждый запрос /api/state
 * - Восстанавливает open / closed / metrics
 * - Догружает текущий market cap для open позиций с pump.fun (с кэшем 30s)
 * - Отдаёт статичный HTML dashboard на /
 *
 * Запуск:
 *   PORT=3007 tsx scripts-tmp/dashboard-server.ts
 *
 * Nginx прокидывает laivy.ru → http://127.0.0.1:3007
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch } from 'undici';
import postgres from 'postgres';
import { jupiterJsonHeaders, jupiterPriceV3Url } from '../src/core/jupiter-http.js';
import { lamportsFromGetBalanceResult, qnCall, qnUsageSnapshot } from '../src/core/rpc/qn-client.js';
import { liveOscarRpcHttpUrlFromEnv, resolveSolanaRpcUrl } from '../src/core/rpc/resolve-solana-rpc-url.js';
import { buildPriorityFeeMonitorApiPayload } from '../src/papertrader/pricing/priority-fee.js';
import {
  legTimelineLabelFromLeg,
  liveOscarEntryContextNoteLegacy,
  liveOscarEntryContextNoteV2,
  liveStagedOpenLabelFromState,
} from '../src/papertrader/executor/live-staged-entry-labels.js';
import {
  liveOscarHybridStrategyNoteRu,
  liveOscarScratchStrategyNoteRu,
  variantAExitTagLabel,
  type VariantAExitTag,
} from '../src/papertrader/executor/exit-policy-variant-a.js';
import type { PaperTraderConfig } from '../src/papertrader/config.js';
import { startQuickNodeUsageReporting } from '../src/stream/quicknode-usage-loop.js';
import {
  fetchLatestSnapshotMcap,
  type DexSnapshotSource,
} from '../src/papertrader/pricing.js';
import { iterJsonlLinesBounded } from './jsonl-line-reader.js';
import {
  loadCopyLeaderOpensForLiveOscarDashboard,
  loadCopyTraderJsonlForDashboard,
  mergeCopyLeaderOpensIntoLiveOscarLoad,
  type CopyTraderDashboardStats,
} from './copytrader-dashboard.js';
import { loadDcTraderForDashboard, type DcTraderDashboardStats } from './dc-trader-dashboard.js';
import { loadBasePulseForDashboard, basePulseDashboardJsonlPath } from './basepulse-dashboard.js';
import { loadBscPulseForDashboard, bscPulseDashboardJsonlPath } from './bscpulse-dashboard.js';
import {
  hlOscarMajorsDashboardJsonlPath,
  hlOscarMajorsHeartbeatPath,
  hlOscarPerpDashboardJsonlPath,
  hlOscarPerpHeartbeatPath,
  loadHlOscarMajorsForDashboard,
  loadHlOscarPerpForDashboard,
  resolveHlOscarCoinFromRow,
} from './hl-oscar-perp-dashboard.js';
import { loadHyperliquidMarketCache } from '../src/hyperliquid/twap/hyperliquid-meta.js';
import { loadSuperbotJsonlForDashboard, type SuperbotDashboardLoad } from './superbot-dashboard.js';
import {
  hlTwapDashboardJsonlPath,
} from '../src/hyperliquid/twap/dashboard-aggregate.js';
import {
  isLiveOpenSnapshotFresh,
  readLiveOpenSnapshot,
} from '../src/live/open-snapshot.js';
import { isRunnerProbeTrade } from '../src/papertrader/live-oscar-runner-probe.js';
import { isLiveOscarScalpWaveTrade } from '../src/papertrader/live-oscar-scalp-wave.js';

/** Empty paper2 load when optional panel loader fails. */
function emptyPaper2FileLoad(): Paper2FileLoad {
  return {
    open: [],
    closed: [],
    firstTs: Date.now(),
    lastTs: Date.now(),
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map<string, TimelineEvent[]>(),
  };
}

async function loadDcaliveDashboardSafe(jsonlPath: string): Promise<Paper2FileLoad> {
  try {
    const mod = await import('./dcalive-dashboard.js');
    return await mod.loadDcaliveForDashboard(pgPool(), jsonlPath);
  } catch (e) {
    console.warn('[dashboard] dca-live unavailable', String(e).slice(0, 200));
    return emptyPaper2FileLoad();
  }
}

/** Tail replay for huge live journals (align with LIVE_REPLAY_MAX_FILE_BYTES default 200MB). */
const DASHBOARD_JSONL_TAIL_BYTES = Number(
  process.env.DASHBOARD_JSONL_TAIL_BYTES ?? 200 * 1024 * 1024,
);
/** Live Oscar main journal — smaller tail OK when open snapshot sidecar is fresh. */
const DASHBOARD_LIVE_OSCAR_TAIL_BYTES = Number(
  process.env.DASHBOARD_LIVE_OSCAR_TAIL_BYTES ?? DASHBOARD_JSONL_TAIL_BYTES,
);
/** Files at or below this size are scanned fully; larger files use tail-only replay. */
const DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES = Number(
  process.env.DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES ?? 32 * 1024 * 1024,
);
/** Max closed rows enriched for UI (`recentClosed`); metrics still use full tail replay set. */
const DASHBOARD_RECENT_CLOSED_LIMIT = Number(process.env.DASHBOARD_RECENT_CLOSED_LIMIT ?? 20);
const DASHBOARD_PAPER2_CACHE_MS = Number(process.env.DASHBOARD_PAPER2_CACHE_MS ?? 45_000);
/** Fast refresh for live-oscar open rows only (`GET /api/paper2/opens`). */
const DASHBOARD_PAPER2_OPENS_CACHE_MS = Number(process.env.DASHBOARD_PAPER2_OPENS_CACHE_MS ?? 15_000);
/** Serve last good payload while rebuilding (avoid 5min browser wait on cache miss mid-build). */
const DASHBOARD_PAPER2_STALE_SERVE_MS = Number(
  process.env.DASHBOARD_PAPER2_STALE_SERVE_MS ?? 30 * 60_000,
);

/** Substrings checked before JSON.parse — skips noisy live-oscar audit lines in dashboard tail scans. */
const DASHBOARD_JSONL_SKIP_KIND_MARKERS = [
  '"kind":"live_discovery_eval"',
  '"kind":"live_discovery_tick_skip"',
  '"kind":"live_discovery_universe_miss"',
] as const;

/** Pre-parse filter for dashboard JSONL tail scans (live-oscar audit dominates multi-GB journals). */
export function dashboardJsonlLineFastSkip(line: string): boolean {
  for (const marker of DASHBOARD_JSONL_SKIP_KIND_MARKERS) {
    if (line.includes(marker)) return true;
  }
  return false;
}

export function dashboardRecentClosedLimit(): number {
  return Number.isFinite(DASHBOARD_RECENT_CLOSED_LIMIT) && DASHBOARD_RECENT_CLOSED_LIMIT > 0
    ? Math.floor(DASHBOARD_RECENT_CLOSED_LIMIT)
    : 20;
}

function isHlOscarSid(sid: string): boolean {
  return sid === 'hl-oscar-perp' || sid === 'hl-oscar-majors';
}

function paper2EnrichModeForSid(sid: string): 'full' | 'lite' {
  const mode = (process.env.DASHBOARD_ENRICH_MODE || 'lite').trim().toLowerCase();
  if (mode === 'full') return 'full';
  if (mode === 'lite') return 'lite';
  return sid === 'live-oscar' ||
    sid === 'superbot' ||
    sid === 'base-pulse' ||
    sid === 'bsc-pulse' ||
    isHlOscarSid(sid)
    ? 'full'
    : 'lite';
}

function isEvmPulseSid(sid: string): boolean {
  return sid === 'base-pulse' || sid === 'bsc-pulse';
}

function evmChainForSid(sid: string): 'base' | 'bsc' | null {
  if (sid === 'base-pulse') return 'base';
  if (sid === 'bsc-pulse') return 'bsc';
  return null;
}

type Paper2ApiCache = { expiresAt: number; builtAt: number; payload: unknown };
let paper2ApiCache: Paper2ApiCache | null = null;
let paper2ApiBuild: Promise<unknown> | null = null;
type Paper2OpensApiCache = { expiresAt: number; payload: unknown };
let paper2OpensApiCache: Paper2OpensApiCache | null = null;
let paper2OpensApiBuild: Promise<unknown> | null = null;

function startPaper2ApiBuild(): Promise<unknown> {
  if (paper2ApiBuild) return paper2ApiBuild;
  paper2ApiBuild = buildPaper2ApiPayload()
    .then((payload) => {
      paper2ApiCache = {
        expiresAt: Date.now() + DASHBOARD_PAPER2_CACHE_MS,
        builtAt: Date.now(),
        payload,
      };
      return payload;
    })
    .finally(() => {
      paper2ApiBuild = null;
    });
  return paper2ApiBuild;
}

function* dashboardJsonlLines(filePath: string, tailBytes = DASHBOARD_JSONL_TAIL_BYTES): Generator<string> {
  for (const line of iterJsonlLinesBounded(
    filePath,
    tailBytes,
    DASHBOARD_JSONL_FULL_SCAN_MAX_BYTES,
  )) {
    if (dashboardJsonlLineFastSkip(line)) continue;
    yield line;
  }
}

function* liveOscarDashboardJsonlLines(filePath: string): Generator<string> {
  yield* dashboardJsonlLines(filePath, DASHBOARD_LIVE_OSCAR_TAIL_BYTES);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT ?? 3007);
const HOST = process.env.HOST ?? '0.0.0.0';
const STORE_PATH = process.env.STORE_PATH ?? '/tmp/paper-trades.jsonl';
/** Cursor file только для журнала организатора (не путать с другими стратегиями в той же папке). */
function isOrganizerPaperStorePath(p: string): boolean {
  const b = path.basename(p).toLowerCase();
  return b === 'organizer-paper.jsonl' || (b.startsWith('organizer') && b.endsWith('.jsonl'));
}

function resolvedOrgCursorPath(): string | null {
  if (!isOrganizerPaperStorePath(STORE_PATH)) return null;
  return (
    process.env.DASHBOARD_ORG_CURSOR_PATH?.trim() ||
    path.join(path.dirname(STORE_PATH), 'runner-organizer-paper-cursor.txt')
  );
}
const HTML_PATH = path.join(__dirname, 'dashboard.html');
const VISITS_PATH = process.env.VISITS_PATH ?? '/tmp/dashboard-visits.jsonl';
const PAPER2_DIR = process.env.PAPER2_DIR ?? '/opt/solana-alpha/data/paper2';
/** Live Oscar JSONL for /api/paper2 first panel (W8.0-p4 dashboard); never scan from PAPER2_DIR. */
const DASHBOARD_LIVE_OSCAR_JSONL =
  process.env.DASHBOARD_LIVE_OSCAR_JSONL?.trim() ||
  path.resolve(PAPER2_DIR, '..', 'live', 'pt1-oscar-live.jsonl');
/** Sidecar open list from live-oscar process (source of truth when fresh). */
const DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT =
  process.env.DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT?.trim() ||
  path.resolve(PAPER2_DIR, '..', 'live', 'live-oscar-open-snapshot.json');
const DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS = Number(
  process.env.DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS ?? 24 * 3_600_000,
);
/** Copy-trader journal — панель вместо Live Oscar Risky на `/papertrader2`. */
const DASHBOARD_COPY_TRADER_JSONL =
  process.env.DASHBOARD_COPY_TRADER_JSONL?.trim() ||
  path.resolve(PAPER2_DIR, '..', 'copytrader', 'journal.jsonl');
const DASHBOARD_COPY_TRADER_STATE_PATH =
  process.env.DASHBOARD_COPY_TRADER_STATE_PATH?.trim() ||
  path.resolve(PAPER2_DIR, '..', 'copytrader', 'state.json');
/** Leader wallet mirrored on Live Oscar open rows (`COPY` badge). */
const DASHBOARD_COPY_TRADER_LEADER_WALLET = (
  process.env.DASHBOARD_COPY_TRADER_LEADER_WALLET?.trim() ||
  process.env.COPY_TRADER_TARGET_WALLET?.trim() ||
  ''
).trim();
/** DCA Trader Risky (dc-trader) — tile 3 on `/papertrader2`. */
const DASHBOARD_DC_TRADER_JSONL =
  process.env.DASHBOARD_DC_TRADER_JSONL?.trim() || '/opt/dc-trader/data/trader-journal.jsonl';
const DASHBOARD_DC_TRADER_STATE_PATH =
  process.env.DASHBOARD_DC_TRADER_STATE_PATH?.trim() || '/opt/dc-trader/data/trader-state.json';
/** SuperBot (pumpswap-flow-sniper) journal — isolated repo on future VPS. */
const DASHBOARD_SUPERBOT_JSONL =
  process.env.DASHBOARD_SUPERBOT_JSONL?.trim() ||
  process.env.DASHBOARD_PUMPSWAP_FLOW_SNIPER_JSONL?.trim() ||
  '/opt/pumpswap-flow-sniper/data/pumpswap-flow-sniper/journal.jsonl';
/** PumpSwap dip bot — isolated journal (not Oscar / copy-trader). */
/** @deprecated alias — тот же execution wallet (Copy Trader). */
const DASHBOARD_LIVE_OSCAR_RISKY_JSONL = DASHBOARD_COPY_TRADER_JSONL;
/** Paper Oscar IDEALIZED V2.1 — отдельный jsonl; панель рядом с live на `/papertrader2`. */
const DASHBOARD_PAPER_OSCAR_V21_JSONL =
  process.env.DASHBOARD_PAPER_OSCAR_V21_JSONL?.trim() || path.join(PAPER2_DIR, 'paper-oscar-v21.jsonl');
/** Paper Oscar V2.2 — клон v2.1, более рискованные гейты входа; отдельный jsonl. */
const DASHBOARD_PAPER_OSCAR_V22_JSONL =
  process.env.DASHBOARD_PAPER_OSCAR_V22_JSONL?.trim() || path.join(PAPER2_DIR, 'paper-oscar-v22.jsonl');
/** Paper Oscar Risky — бумажный паритет live-осскара по выходам; гейты входа как v2.2. */
const DASHBOARD_PAPER_OSCAR_RISKY_JSONL =
  process.env.DASHBOARD_PAPER_OSCAR_RISKY_JSONL?.trim() || path.join(PAPER2_DIR, 'paper-oscar-risky.jsonl');
/** DCA Live (dcafr-live) — PG + optional JSONL on dca-frontrun host. */
const DASHBOARD_DCA_LIVE_JSONL =
  process.env.DASHBOARD_DCA_LIVE_JSONL?.trim() ||
  '/home/dcabot/dca-frontrun/data/dcalive-trades.jsonl';
const HTML2_PATH = path.join(__dirname, 'dashboard-paper2.html');
const HTML_SMLOT_PATH = path.join(__dirname, 'dashboard-smart-lottery.html');
/** Paper Smart Lottery JSONL — excluded from `/api/paper2` scan; own `/api/smart-lottery`. */
const DASHBOARD_SMLOT_JSONL =
  process.env.DASHBOARD_SMLOT_JSONL?.trim() || path.join(PAPER2_DIR, 'pt1-smart-lottery.jsonl');
const POSITION_USD_DEFAULT = Number(process.env.POSITION_USD ?? 100);
/** Legacy pumpswap-flow-sniper journal fallback (Preset C scalp: $50 single leg). */
const PUMPSWAP_DIP_POSITION_USD_DEFAULT = 3;
const PRESET_C_POSITION_USD_DEFAULT = 50;
const PRESET_C_STAGED_LEG_USD_DEFAULT = 50;

/** Dashboard + journal id for SuperBot tile / live-oscar-preset-c PM2. */
export const LIVE_OSCAR_PRESET_C_STRATEGY_ID = 'live-oscar-preset-c';

export function resolveLiveOscarDashboardStrategyId(filePath: string): string {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  if (
    lower.includes('preset-c') ||
    lower.includes('preset_c') ||
    lower.includes('live-oscar-preset-c')
  ) {
    return LIVE_OSCAR_PRESET_C_STRATEGY_ID;
  }
  if (lower.includes('risky')) return 'live-oscar-risky';
  return 'live-oscar';
}

/** SuperBot panel reads live-oscar JSONL (Preset C) vs legacy pumpswap race journal. */
export function superbotJsonlIsLiveOscarFormat(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, '/');
  if (
    lower.includes('preset-c') ||
    lower.includes('preset_c') ||
    lower.includes('live-oscar-preset-c')
  ) {
    return true;
  }
  if (!fs.existsSync(filePath)) return false;
  if (lower.includes('superbot-journal') || lower.includes('pumpswap-flow-sniper')) {
    return false;
  }
  try {
    const head = fs.readFileSync(filePath, { encoding: 'utf8' }).slice(0, 96_000);
    if (head.includes('"live_position_open"') || head.includes('"channel":"live"')) return true;
    if (head.includes('"ext_sell_detected"') || head.includes('"race_buy_ok"')) return false;
  } catch {
    return false;
  }
  return false;
}

/** Open sidecar path paired with a live-oscar family journal (Preset C vs main Oscar). */
export function resolveLiveOscarOpenSnapshotPath(jsonlPath: string): string {
  const envPreset =
    process.env.DASHBOARD_LIVE_OSCAR_PRESET_C_OPEN_SNAPSHOT?.trim() ||
    process.env.LIVE_OSCAR_PRESET_C_OPEN_SNAPSHOT_PATH?.trim();
  const lower = jsonlPath.toLowerCase().replace(/\\/g, '/');
  if (
    lower.includes('live-oscar-preset-c') ||
    lower.includes('preset-c') ||
    lower.includes('preset_c')
  ) {
    return envPreset || path.resolve(path.dirname(jsonlPath), 'live-oscar-preset-c-open-snapshot.json');
  }
  return (
    process.env.DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT?.trim() ||
    path.resolve(PAPER2_DIR, '..', 'live', 'live-oscar-open-snapshot.json')
  );
}

function entryQuoteVerifyFromExecutionAttempt(o: Record<string, unknown>): {
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
} {
  const qs = o.quoteSnapshot;
  if (!qs || typeof qs !== 'object') {
    return {
      entryPriceVerifySlipPct: null,
      entryPriceVerifyImpactPct: null,
      entryPriceVerifySource: null,
    };
  }
  const snap = qs as Record<string, unknown>;
  const slipBps = Number(snap.slippageBps ?? 0);
  const impactRaw = Number(snap.priceImpactPct ?? 0);
  const impactPct =
    Number.isFinite(impactRaw) && impactRaw > 0
      ? impactRaw < 1
        ? +(impactRaw * 100).toFixed(4)
        : +impactRaw.toFixed(4)
      : null;
  const slipPct =
    Number.isFinite(slipBps) && slipBps > 0 ? +(slipBps / 100).toFixed(4) : null;
  const provider = String(snap.provider ?? '').trim().toLowerCase();
  const entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null =
    provider === 'jupiter' || provider === 'jup' ? 'jupiter' : slipPct != null || impactPct != null ? 'jupiter' : null;
  return {
    entryPriceVerifySlipPct: slipPct,
    entryPriceVerifyImpactPct: impactPct,
    entryPriceVerifySource,
  };
}

function presetCMcapTierRu(tier: unknown): string {
  const t = String(tier ?? '').trim();
  if (t === 'micro') return 'микро-капа ($500k–$1.3M)';
  if (t === 'low') return 'лоу-капа ($1.3M–$3M)';
  if (t === 'scalp_wave') return 'скальп-волна ($800k–$30M)';
  if (t === 'prod') return 'крупная капа (≥$3M)';
  return 'фаза по mcap';
}

function presetCOpenTimelineLabelRu(openTrade: Record<string, unknown>): string {
  const tier = presetCMcapTierRu(openTrade.liveOscarMcapTier);
  const legsArr = Array.isArray(openTrade.legs) ? (openTrade.legs as Record<string, unknown>[]) : [];
  const legUsd = Number(legsArr[0]?.sizeUsd ?? PRESET_C_POSITION_USD_DEFAULT);
  const usd = legUsd > 0 ? legUsd : PRESET_C_POSITION_USD_DEFAULT;
  return `Preset C · TG gate pullback/retrace/spike (1h) · mcap $3M–$30M · вход $${usd.toFixed(0)} deferred −10% от сигнала · ${tier}`;
}

function presetCStagedLegTimelineLabelRu(legUsd: number, tier: unknown): string {
  const u = legUsd > 0 ? legUsd : PRESET_C_STAGED_LEG_USD_DEFAULT;
  return `Preset C · добор $${u.toFixed(0)} · ${presetCMcapTierRu(tier)} · preset_c_scalp_v1`;
}

function presetCTimelineContextNote(evKind: string): string {
  const entry =
    'Preset C (SuperBot): TG gate pullback/retrace/spike, окно 1h; mcap кандидата $3M–$30M, пролив от пика 9–30%. Вход — одна нога $50, deferred −10% от цены TG-сигнала (без staged-доборов).';
  const exit =
    'Выход preset_c_scalp_v1: TP +5% / +10% / +15% к anchor сигнала; partial trail −2.5% от хая после +5%; kill −50% от цены сигнала.';
  if (
    evKind === 'open' ||
    evKind === 'scale_in_add' ||
    evKind === 'dca_add' ||
    evKind === 'entry_split_add' ||
    evKind === 'staged_avg_add'
  ) {
    return entry;
  }
  if (evKind === 'partial_sell' || evKind === 'close') return exit;
  return `${entry}\n${exit}`;
}

function closedRowNotionalUsd(c: Paper2ClosedRow): number {
  const sz = Number(c.sizeUsd ?? 0);
  if (Number.isFinite(sz) && sz > 0 && sz <= 50_000) return sz;
  const entrySizeUsd = Number(c.entrySizeUsd ?? 0);
  if (Number.isFinite(entrySizeUsd) && entrySizeUsd > 0 && entrySizeUsd <= 50_000) return entrySizeUsd;
  const inv = Number(c.totalInvestedUsd ?? 0);
  if (Number.isFinite(inv) && inv > 0 && inv <= 50_000) return inv;
  return POSITION_USD_DEFAULT;
}

function closedRowPnlUsd(c: Paper2ClosedRow): number {
  const pnlSolRaw = c.pnlSol;
  if (typeof pnlSolRaw === 'number' && Number.isFinite(pnlSolRaw)) {
    const m = Number(c.marketSolUsd ?? NaN);
    if (Number.isFinite(m) && m > 0) return pnlSolRaw * m;
    const entrySol = Number(c.entrySolSpent ?? NaN);
    const entryUsd = closedRowNotionalUsd(c);
    if (Number.isFinite(entrySol) && entrySol > 0) return (entryUsd * pnlSolRaw) / entrySol;
  }
  const exitReason = String(c.exitReason ?? '');
  const netUsd = c.netPnlUsd;
  if (typeof netUsd === 'number' && Number.isFinite(netUsd)) {
    if (exitReason === 'RECONCILE_ORPHAN' && netUsd === 0) {
      const gross = Number(c.grossPnlUsd ?? NaN);
      if (Number.isFinite(gross) && gross !== 0) return gross;
    } else {
      return netUsd;
    }
  }
  const raw = Number(c.pnlUsd ?? NaN);
  if (Number.isFinite(raw)) return raw;
  const pnlPct = Number(c.pnlPct ?? 0);
  return (closedRowNotionalUsd(c) * pnlPct) / 100;
}

/** Net realized % for closed rows (exported for dashboard regression tests). */
export function closedRowDisplayPnlPct(c: Paper2ClosedRow, pnlUsd: number): number {
  const pnlSolRaw = c.pnlSol;
  const entrySol = Number(c.entrySolSpent ?? NaN);
  if (typeof pnlSolRaw === 'number' && Number.isFinite(pnlSolRaw) && entrySol > 0) {
    return (pnlSolRaw / entrySol) * 100;
  }
  // Partial TP/trail unwinds: netPnlUsd / notional; % must match $ column after wallet-drain MTM repair.
  const notional = closedRowNotionalUsd(c);
  if (notional > 0 && Number.isFinite(pnlUsd)) return (pnlUsd / notional) * 100;
  const journalPct = Number(c.pnlPct ?? NaN);
  if (Number.isFinite(journalPct)) return journalPct;
  const entryPx = closedRowEntryPx(c);
  const exitPx = closedRowExitPx(c);
  if (entryPx > 0 && exitPx > 0) {
    const fillPct = (exitPx / entryPx - 1) * 100;
    if (Number.isFinite(fillPct)) return fillPct;
  }
  const grossPct = Number(c.grossPnlPct ?? NaN);
  if (
    String(c.exitReason ?? '') === 'RECONCILE_ORPHAN' &&
    Number(c.pnlPct ?? 0) === 0 &&
    Number.isFinite(grossPct) &&
    grossPct !== 0
  ) {
    return grossPct;
  }
  return Number(c.pnlPct ?? 0);
}

function closedRowEntryPx(c: Paper2ClosedRow): number {
  const direct = Number(c.entryPriceUsd ?? c.entryPx ?? 0);
  if (direct > 0) return direct;
  const theo = Number(c.theoretical_entry_price ?? 0);
  if (theo > 0) return theo;
  const avgM = Number(c.avgEntryMarket ?? 0);
  if (avgM > 0) return avgM;
  const eff = Number(c.effective_entry_price ?? 0);
  if (eff > 0) return eff;
  return Number(c.avgEntry ?? 0);
}

function closedRowExitPx(c: Paper2ClosedRow): number {
  const direct = Number(c.exitPriceUsd ?? c.exitPx ?? 0);
  if (direct > 0) return direct;
  const lastObs = Number(c.lastObservedPriceUsd ?? 0);
  if (lastObs > 0) return lastObs;
  const eff = Number(c.effective_exit_price ?? 0);
  if (eff > 0) return eff;
  return Number(c.theoretical_exit_price ?? 0);
}

/** Most recent N closed rows for dashboard enrichment (journal replay order is oldest-first). */
export function selectRecentClosedRowsForDashboard(
  closed: Paper2ClosedRow[],
  limit: number,
): Paper2ClosedRow[] {
  if (limit <= 0) return [];
  return [...closed]
    .sort((a, b) => Number(b.exitTs ?? 0) - Number(a.exitTs ?? 0))
    .slice(0, limit);
}

function normalizePaper2ExitReason(raw: string): string {
  const r = raw.trim() || 'NO_DATA';
  if (r === 'stop_loss') return 'SL';
  if (r === 'take_profit') return 'TP';
  if (r === 'timeout') return 'TIMEOUT';
  if (r === 'trail' || r === 'trailing') return 'TRAIL';
  return r;
}

/** Журналы плиток Oscar на `/papertrader2` (без сканирования каталога paper2). */
function dashboardOscarPanelJsonlFiles(): string[] {
  const out: string[] = [];
  if (fs.existsSync(DASHBOARD_LIVE_OSCAR_JSONL)) out.push(DASHBOARD_LIVE_OSCAR_JSONL);
  if (fs.existsSync(DASHBOARD_COPY_TRADER_JSONL)) out.push(DASHBOARD_COPY_TRADER_JSONL);
  if (fs.existsSync(DASHBOARD_PAPER_OSCAR_RISKY_JSONL)) out.push(DASHBOARD_PAPER_OSCAR_RISKY_JSONL);
  if (fs.existsSync(DASHBOARD_PAPER_OSCAR_V21_JSONL)) out.push(DASHBOARD_PAPER_OSCAR_V21_JSONL);
  if (fs.existsSync(DASHBOARD_PAPER_OSCAR_V22_JSONL)) out.push(DASHBOARD_PAPER_OSCAR_V22_JSONL);
  return out;
}

let pgSql: ReturnType<typeof postgres> | null = null;
function pgPool(): ReturnType<typeof postgres> {
  const url = process.env.SA_PG_DSN || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'SA_PG_DSN or DATABASE_URL is required for /api/stream/health, /api/parser/health, /api/atlas/health',
    );
  }
  if (!pgSql) {
    pgSql = postgres(url, { max: 2, idle_timeout: 20 });
  }
  return pgSql;
}

interface OpenTrade {
  mint: string;
  symbol: string;
  entryTs: number;
  entryMcUsd: number;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  entryMetrics?: any;
}
interface ClosedTrade extends OpenTrade {
  exitTs: number;
  exitMcUsd: number;
  exitReason: 'TP' | 'SL' | 'TRAIL' | 'TIMEOUT' | 'NO_DATA' | 'FAST_DUMP' | 'LIQ_DROP' | 'FLAT_LOSS';
  pnlPct: number;
  durationMin: number;
}

// ---------------------------------------------------------
// market cap cache (pump.fun frontend api)
// ---------------------------------------------------------
type PumpCoinMarket = {
  mcUsd: number | null;
  priceUsd: number | null;
  supplyTokens: number | null;
};

const mcCache = new Map<string, { mc: number; ts: number }>();
const pumpCoinMarketCache = new Map<string, { market: PumpCoinMarket; ts: number }>();
const MC_TTL_MS = 30_000;

function normalizePumpSupplyTokens(rawSupply: number): number | null {
  if (!(rawSupply > 0) || !Number.isFinite(rawSupply)) return null;
  // pump.fun returns SPL atomic supply; migrated tokens may be 6- or 9-decimal.
  if (rawSupply >= 100_000_000_000_000_000) return rawSupply / 1_000_000_000;
  if (rawSupply >= 1_000_000_000_000) return rawSupply / 1_000_000;
  return rawSupply;
}

async function getPumpCoinMarket(mint: string): Promise<PumpCoinMarket | null> {
  const cached = pumpCoinMarketCache.get(mint);
  if (cached && Date.now() - cached.ts < MC_TTL_MS) return cached.market;
  try {
    const r = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const mcUsdRaw = Number(j?.usd_market_cap ?? 0);
    const rawSupply = Number(j?.total_supply ?? j?.total_supply_str ?? 0);
    const supplyTokens = normalizePumpSupplyTokens(rawSupply);
    const mcUsd = mcUsdRaw > 0 && Number.isFinite(mcUsdRaw) ? mcUsdRaw : null;
    const priceUsd =
      mcUsd != null && supplyTokens != null && supplyTokens > 0 ? mcUsd / supplyTokens : null;
    const market = {
      mcUsd,
      priceUsd: priceUsd != null && priceUsd > 0 && Number.isFinite(priceUsd) ? priceUsd : null,
      supplyTokens,
    };
    pumpCoinMarketCache.set(mint, { market, ts: Date.now() });
    return market.mcUsd != null || market.priceUsd != null ? market : null;
  } catch {
    /* ignore */
  }
  return null;
}

async function getCurrentMc(mint: string): Promise<number | null> {
  const cached = mcCache.get(mint);
  if (cached && Date.now() - cached.ts < MC_TTL_MS) return cached.mc;
  const market = await getPumpCoinMarket(mint);
  if (market?.mcUsd != null && market.mcUsd > 0) {
    mcCache.set(mint, { mc: market.mcUsd, ts: Date.now() });
    return market.mcUsd;
  }
  return null;
}

// ---------------------------------------------------------
// live mcap fallback: read most recent row from *_pair_snapshots
// (used for AMM mints where pump.fun frontend returns nothing)
// ---------------------------------------------------------
const dexMcCache = new Map<string, { mc: number; ts: number }>();
const DEX_MC_TTL_MS = 30_000;
const DEX_SNAPSHOT_TABLES = [
  'raydium_pair_snapshots',
  'meteora_pair_snapshots',
  'orca_pair_snapshots',
  'moonshot_pair_snapshots',
  'pumpswap_pair_snapshots',
] as const;

/** W7.5 — align with paper-trader `PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS` for live liq badge freshness. */
const PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS = Number(process.env.PAPER_LIQ_WATCH_SNAPSHOT_MAX_AGE_MS ?? 120_000);

/**
 * Latest pool `liquidity_usd` for dashboard open rows (same tables as executor liq-watch).
 */
async function fetchPairLiquidityUsdFromPg(
  pairAddress: string | null | undefined,
  source: string | null | undefined,
): Promise<number | null> {
  const pa = pairAddress?.trim();
  if (!pa) return null;
  const src = (source || 'raydium').toLowerCase();
  let sqlPg: ReturnType<typeof postgres>;
  try {
    sqlPg = pgPool();
  } catch {
    return null;
  }
  const maxAge =
    Number.isFinite(PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS) && PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS > 0
      ? PAPER2_LIQ_SNAPSHOT_MAX_AGE_MS
      : 120_000;
  const now = Date.now();
  try {
    let row: { liquidity_usd: unknown; ts: Date } | undefined;
    if (src === 'raydium') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM raydium_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'meteora') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM meteora_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'orca') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM orca_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'moonshot') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM moonshot_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else if (src === 'pumpswap') {
      const rows = await sqlPg<{ liquidity_usd: unknown; ts: Date }[]>`
        SELECT liquidity_usd, ts FROM pumpswap_pair_snapshots
        WHERE pair_address = ${pa}
        ORDER BY ts DESC LIMIT 1
      `;
      row = rows[0];
    } else {
      return null;
    }
    if (!row) return null;
    const ageMs = Math.max(0, now - new Date(row.ts).getTime());
    if (ageMs > maxAge) return null;
    const liq = row.liquidity_usd != null ? Number(row.liquidity_usd) : NaN;
    return Number.isFinite(liq) && liq > 0 ? liq : null;
  } catch {
    return null;
  }
}

/** Solana base58 mint — safe single-quoted literal for raw SQL fragments. */
function sqlMintQuoted(mint: string): string | null {
  if (!mint || mint.length > 64) return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(mint)) return null;
  return `'${mint.replace(/'/g, "''")}'`;
}

/** Pool row may index the traded mint as base or quote depending on collector/orientation. */
function sqlMintPoolMatch(mq: string): string {
  return `(base_mint = ${mq} OR quote_mint = ${mq})`;
}

const jupPxCache = new Map<string, { px: number; ts: number }>();
const JUP_PX_TTL_MS = 15_000;

/** Jupiter v3 — same family as v1-style dashboards when PG pair rows lag or miss the mint side. */
async function getJupiterTokenPriceUsd(mint: string): Promise<number | null> {
  if (!sqlMintQuoted(mint)) return null;
  const hit = jupPxCache.get(mint);
  if (hit && Date.now() - hit.ts < JUP_PX_TTL_MS) return hit.px;
  try {
    const r = await fetch(jupiterPriceV3Url(mint), {
      headers: jupiterJsonHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, { usdPrice?: number }> & {
      data?: Record<string, { price?: number }>;
    };
    const px = Number(j[mint]?.usdPrice ?? j?.data?.[mint]?.price ?? 0);
    if (px > 0 && Number.isFinite(px)) {
      jupPxCache.set(mint, { px, ts: Date.now() });
      return px;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function entryMcapFromOpenTimelineEvent(tl: TimelineEvent[]): number | null {
  const ev = tl.find((e) => e.kind === 'open');
  const n = Number(ev?.mcUsd ?? 0);
  return n > 0 && Number.isFinite(n) ? n : null;
}

function exitMcapFromCloseTimelineEvent(tl: TimelineEvent[]): number | null {
  const closes = tl.filter((e) => e.kind === 'close');
  const last = closes[closes.length - 1];
  const n = Number(last?.mcUsd ?? 0);
  return n > 0 && Number.isFinite(n) ? n : null;
}

function dexSourceFromTradeSource(source: string | null | undefined): DexSnapshotSource | undefined {
  const s = (source || '').toLowerCase();
  if (s === 'raydium' || s === 'meteora' || s === 'orca' || s === 'moonshot' || s === 'pumpswap') {
    return s;
  }
  return undefined;
}

async function resolveEntryMcapAtBuyUsd(
  mint: string,
  entryTs: number,
  timelineSorted: TimelineEvent[],
  source?: string | null,
): Promise<number | null> {
  const fromTl = entryMcapFromOpenTimelineEvent(timelineSorted);
  if (fromTl != null) return fromTl;
  if (entryTs > 0) {
    const dexSrc = dexSourceFromTradeSource(source);
    return await fetchLatestSnapshotMcap(
      mint,
      dexSrc,
      Math.floor(entryTs / 1000),
    ).catch(() => null);
  }
  return null;
}

async function getDexLiveMc(mint: string, source?: string | null): Promise<number | null> {
  const dexSrc = dexSourceFromTradeSource(source);
  const cacheKey = `${mint}|${dexSrc ?? 'any'}`;
  const cached = dexMcCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DEX_MC_TTL_MS) return cached.mc;
  const mc = await fetchLatestSnapshotMcap(mint, dexSrc).catch(() => null);
  if (mc != null && mc > 0) {
    dexMcCache.set(cacheKey, { mc, ts: Date.now() });
    return mc;
  }
  return null;
}

/** Per-(mint, event-second) cache for timeline mcap back-fill only. */
const timelineEventMcapCache = new Map<string, number | null | undefined>();
function getDexMcapNearestBeforeCached(
  mint: string,
  beforeMs: number,
  source?: string | null,
): Promise<number | null> {
  const k = `${mint}\t${Math.floor(beforeMs / 1000)}\t${source ?? ''}`;
  if (timelineEventMcapCache.has(k)) return Promise.resolve(timelineEventMcapCache.get(k) ?? null);
  return getDexMcapNearestBefore(mint, beforeMs, source)
    .then((v) => {
      timelineEventMcapCache.set(k, v);
      return v;
    })
    .catch(() => {
      timelineEventMcapCache.set(k, null);
      return null;
    });
}

async function getDexMcapNearestBefore(
  mint: string,
  beforeMs: number,
  source?: string | null,
): Promise<number | null> {
  const dexSrc = dexSourceFromTradeSource(source);
  return fetchLatestSnapshotMcap(mint, dexSrc, Math.floor(beforeMs / 1000)).catch(() => null);
}

/**
 * repair / same-ms JSONL: spurious dca_add right after open (same ts, +0% trigger, same notional) — drop from UI.
 */
export function filterSpuriousDcaOpenDuplicate(timeline: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const ev of timeline) {
    if (ev.kind === 'dca_add' && out.length) {
      const prev = out[out.length - 1]!;
      if (prev.kind === 'open' && ev.ts === prev.ts) {
        const lab = String(ev.label || '');
        if (/уровень\s*\+0%|уровень\s*0%|\+0%\s*\(от первой ноги\)/.test(lab)) {
          const a0 = Number(prev.amountUsd ?? 0);
          const a1 = Number(ev.amountUsd ?? 0);
          if (a0 > 0 && a1 > 0 && Math.abs(a0 - a1) / Math.max(a0, a1) < 0.02) {
            continue;
          }
        }
      }
    }
    out.push(ev);
  }
  return out;
}

export async function enrichTimelineMcapGaps(
  mint: string,
  timeline: TimelineEvent[],
  source?: string | null,
  maxEvents = 32,
): Promise<TimelineEvent[]> {
  if (!mint?.trim()) return timeline;
  const n = Math.min(timeline.length, maxEvents);
  const head = await Promise.all(
    timeline.slice(0, n).map(async (ev) => {
      if (Number(ev.mcUsd) > 0) return ev;
      const mc = await getDexMcapNearestBeforeCached(mint, ev.ts, source);
      if (mc != null && mc > 0) return { ...ev, mcUsd: mc };
      return ev;
    }),
  );
  return n < timeline.length ? head.concat(timeline.slice(n)) : head;
}

const tokenSymbolByMint = new Map<string, { s: string; at: number }>();
const TOKEN_SYMBOL_TTL_MS = 6 * 3_600_000;

function shortTokenForUi(mint: string | null | undefined): string {
  const s = String(mint ?? '').trim();
  if (!s) return '?';
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** Journal/loader placeholder that is really a truncated EVM address — not a ticker. */
function isAddressLikeSymbol(sym: string | null | undefined): boolean {
  const s = String(sym ?? '').trim();
  if (!s || s === '?') return false;
  if (/^0x[0-9a-f]{4}/i.test(s)) return true;
  return false;
}

function dexscreenerQuoteFromPair(p: Record<string, unknown>, tokenAddrLower: string): DexscreenerEvmQuote {
  const priceUsd = Number(p.priceUsd ?? 0);
  const fdvUsd = Number(p.fdv ?? 0);
  const marketCapUsd = Number(p.marketCap ?? 0);
  const liquidityUsd = Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0);
  const volume24hUsd = Number((p.volume as { h24?: number } | undefined)?.h24 ?? 0);
  const baseTok = p.baseToken as { address?: string; symbol?: string } | undefined;
  const quoteTok = p.quoteToken as { address?: string; symbol?: string } | undefined;
  const sym =
    baseTok?.address?.toLowerCase() === tokenAddrLower
      ? String(baseTok.symbol ?? '').trim()
      : quoteTok?.address?.toLowerCase() === tokenAddrLower
        ? String(quoteTok.symbol ?? '').trim()
        : '';
  return {
    priceUsd: priceUsd > 0 ? priceUsd : null,
    fdvUsd: fdvUsd > 0 ? fdvUsd : null,
    marketCapUsd: marketCapUsd > 0 ? marketCapUsd : null,
    liquidityUsd: liquidityUsd > 0 ? liquidityUsd : null,
    volume24hUsd: volume24hUsd > 0 ? volume24hUsd : null,
    symbol: sym || null,
  };
}

/** Implied mark from latest partial/close pnlPct vs entry (journal fallback when DexScreener is down). */
function evmImpliedMarkPxFromTimeline(timeline: TimelineEvent[], entryPx: number | null): number | null {
  if (!(entryPx && entryPx > 0)) return null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i];
    const pnl = ev.pnlPct;
    if (pnl != null && Number.isFinite(pnl) && (ev.kind === 'partial_sell' || ev.kind === 'close')) {
      return entryPx * (1 + pnl / 100);
    }
  }
  return null;
}

export type EvmPulseOpenPnl = {
  /** Total position PnL % vs full `totalInvestedUsd` (Oscar-style). */
  pnlPct: number;
  /** Net mark-to-market PnL in USD (remaining + realized partial proceeds − invested). */
  pnlUsd: number;
  /** Unrealized price change on remaining slice only (legacy display). */
  pricePnlPct: number;
  realizedProceedsUsd: number;
  currentValueUsd: number;
};

/**
 * Oscar-style open PnL for BasePulse / BscPulse: denominator is full entry notional,
 * numerator includes realized partial proceeds plus mark on the remaining fraction.
 */
export function computeEvmPulseOpenPnl(args: {
  totalInvestedUsd: number;
  entryPx: number;
  livePx: number;
  remainingFraction: number;
  timeline: TimelineEvent[];
}): EvmPulseOpenPnl | null {
  const { totalInvestedUsd, entryPx, livePx, timeline } = args;
  if (!(totalInvestedUsd > 0 && entryPx > 0 && livePx > 0)) return null;

  const rem = Math.max(0, Math.min(1, args.remainingFraction ?? 1));
  const pricePnlPct = ((livePx / entryPx - 1) * 100);

  let remWalk = 1;
  let realizedProceedsUsd = 0;
  for (const ev of timeline) {
    if (ev.kind !== 'partial_sell') continue;
    const amountUsd = Number(ev.amountUsd ?? NaN);
    if (Number.isFinite(amountUsd) && amountUsd > 0) {
      realizedProceedsUsd += amountUsd;
      const rf = Number(ev.remainingFraction ?? NaN);
      if (Number.isFinite(rf) && rf >= 0 && rf <= 1) remWalk = rf;
      else {
        const sellFrac = Number(ev.sizePct ?? NaN);
        if (Number.isFinite(sellFrac) && sellFrac > 0 && sellFrac <= 1) remWalk *= 1 - sellFrac;
      }
      continue;
    }
    const pnlUsd = Number(ev.pnlUsd ?? NaN);
    const sellFrac = Number(ev.sizePct ?? NaN);
    if (Number.isFinite(pnlUsd)) {
      const soldOriginalFrac = Number.isFinite(sellFrac) && sellFrac > 0 ? remWalk * sellFrac : NaN;
      const costBasis =
        Number.isFinite(soldOriginalFrac) && soldOriginalFrac > 0
          ? totalInvestedUsd * soldOriginalFrac
          : totalInvestedUsd * Math.max(0, remWalk - (Number(ev.remainingFraction ?? remWalk)));
      if (costBasis > 0) realizedProceedsUsd += costBasis + pnlUsd;
      const rf = Number(ev.remainingFraction ?? NaN);
      if (Number.isFinite(rf) && rf >= 0 && rf <= 1) remWalk = rf;
      else if (Number.isFinite(sellFrac) && sellFrac > 0 && sellFrac <= 1) remWalk *= 1 - sellFrac;
      continue;
    }
    if (!(Number.isFinite(sellFrac) && sellFrac > 0 && sellFrac <= 1)) continue;
    const soldOriginalFrac = remWalk * sellFrac;
    const costBasis = totalInvestedUsd * soldOriginalFrac;
    const partialPnlPct = Number(ev.pnlPct ?? 0);
    realizedProceedsUsd += costBasis * (1 + partialPnlPct / 100);
    const rf = Number(ev.remainingFraction ?? NaN);
    if (Number.isFinite(rf) && rf >= 0 && rf <= 1) remWalk = rf;
    else remWalk *= 1 - sellFrac;
  }

  const currentValueUsd = totalInvestedUsd * rem * (livePx / entryPx);
  const pnlUsd = currentValueUsd + realizedProceedsUsd - totalInvestedUsd;
  const pnlPct = (pnlUsd / totalInvestedUsd) * 100;
  if (!Number.isFinite(pnlPct) || !Number.isFinite(pnlUsd)) return null;

  return {
    pnlPct,
    pnlUsd,
    pricePnlPct,
    realizedProceedsUsd,
    currentValueUsd,
  };
}

async function resolveEvmPulseDisplaySymbol(
  mint: string,
  journalSymbol: string | null | undefined,
  evmQuote: DexscreenerEvmQuote | null,
): Promise<string> {
  if (evmQuote?.symbol) return evmQuote.symbol.slice(0, 32);
  const js = String(journalSymbol ?? '').trim();
  if (js && js !== '?' && !isAddressLikeSymbol(js)) return js.slice(0, 32);
  return resolveTokenSymbolForUi(mint, null);
}

/** When journal has `?` (repair / missing metadata), resolve from DexScreener token API. */
async function resolveTokenSymbolForUi(mint: string, fromJournal: string | null | undefined): Promise<string> {
  const t0 = (fromJournal ?? '').trim();
  if (t0 && t0 !== '?' && t0.length > 0 && !isAddressLikeSymbol(t0)) return t0.slice(0, 32);
  const c = tokenSymbolByMint.get(mint);
  if (c && Date.now() - c.at < TOKEN_SYMBOL_TTL_MS) return c.s;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return t0 || '?';
    const j = (await r.json()) as { pairs?: { baseToken?: { symbol?: string } }[] };
    const p = j?.pairs?.[0];
    const sym = String(p?.baseToken?.symbol || '').trim();
    if (sym) {
      tokenSymbolByMint.set(mint, { s: sym, at: Date.now() });
      return sym.slice(0, 32);
    }
  } catch {
    /* optional */
  }
  return t0 && t0 !== '?' ? t0 : '?';
}

type DexscreenerEvmQuote = {
  priceUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  symbol: string | null;
};

const dexscreenerEvmCache = new Map<string, { data: DexscreenerEvmQuote; ts: number }>();
const dexscreenerEvmInflight = new Map<string, Promise<DexscreenerEvmQuote | null>>();
const DEXSCREENER_EVM_TTL_MS = 120_000;
const DEXSCREENER_EVM_STALE_MS = 30 * 60_000;

/** Live quote for EVM tokens (BasePulse / BscPulse) via DexScreener public API. */
async function fetchDexscreenerEvmToken(
  tokenAddress: string,
  chainId: 'base' | 'bsc',
  preferredPair?: string | null,
): Promise<DexscreenerEvmQuote | null> {
  const addr = tokenAddress.trim().toLowerCase();
  if (!addr.startsWith('0x') || addr.length < 10) return null;
  const cacheKey = `${chainId}:${addr}:${preferredPair?.trim().toLowerCase() ?? ''}`;
  const cached = dexscreenerEvmCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DEXSCREENER_EVM_TTL_MS) return cached.data;

  const inflight = dexscreenerEvmInflight.get(cacheKey);
  if (inflight) return inflight;

  const work = (async (): Promise<DexscreenerEvmQuote | null> => {
    const staleFallback = (): DexscreenerEvmQuote | null => {
      if (cached && Date.now() - cached.ts < DEXSCREENER_EVM_STALE_MS) return cached.data;
      return null;
    };
    try {
      const pref = preferredPair?.trim();
      if (pref) {
        const pairR = await fetch(
          `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${encodeURIComponent(pref)}`,
          { signal: AbortSignal.timeout(7000) },
        );
        if (pairR.ok) {
          const j = (await pairR.json()) as { pair?: Record<string, unknown>; pairs?: Record<string, unknown>[] };
          const p = j.pair ?? j.pairs?.[0];
          if (p && typeof p === 'object') {
            const data = dexscreenerQuoteFromPair(p as Record<string, unknown>, addr);
            if (data.priceUsd != null || data.symbol != null || data.fdvUsd != null) {
              dexscreenerEvmCache.set(cacheKey, { data, ts: Date.now() });
              return data;
            }
          }
        } else if (pairR.status === 429) {
          const stale = staleFallback();
          if (stale) return stale;
        }
      }

      const r = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(addr)}`,
        { signal: AbortSignal.timeout(7000) },
      );
      if (!r.ok) {
        if (r.status === 429) return staleFallback();
        return null;
      }
      const j = (await r.json()) as { pairs?: Array<Record<string, unknown>> };
      const pairs = (j.pairs ?? []).filter((p) => String(p.chainId ?? '').toLowerCase() === chainId);
      if (!pairs.length) return staleFallback();
      const prefLower = preferredPair?.trim().toLowerCase();
      let best: Record<string, unknown> | null = null;
      if (prefLower) {
        best = pairs.find((p) => String(p.pairAddress ?? '').toLowerCase() === prefLower) ?? null;
      }
      if (!best) {
        let bestLiq = -1;
        for (const p of pairs) {
          const baseAddr = String((p.baseToken as { address?: string } | undefined)?.address ?? '').toLowerCase();
          const quoteAddr = String((p.quoteToken as { address?: string } | undefined)?.address ?? '').toLowerCase();
          if (baseAddr !== addr && quoteAddr !== addr) continue;
          const liq = Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0);
          if (liq > bestLiq) {
            bestLiq = liq;
            best = p;
          }
        }
      }
      if (!best) return staleFallback();
      const data = dexscreenerQuoteFromPair(best, addr);
      dexscreenerEvmCache.set(cacheKey, { data, ts: Date.now() });
      return data;
    } catch {
      return staleFallback();
    } finally {
      dexscreenerEvmInflight.delete(cacheKey);
    }
  })();

  dexscreenerEvmInflight.set(cacheKey, work);
  return work;
}

async function getCurrentMcAny(mint: string, source?: string | null): Promise<number | null> {
  const dex = await getDexLiveMc(mint, source);
  if (dex != null) return dex;
  if (dexSourceFromTradeSource(source)) return null;
  return await getCurrentMc(mint);
}

/** Latest token USD spot price from DEX snapshots (AMM strategies use metricType=price). */
const dexPxCache = new Map<string, { px: number; ts: number }>();
const DEX_PX_TTL_MS = 30_000;

async function getDexLivePrice(mint: string, source: string | null): Promise<number | null> {
  const cacheKey = `${mint}|${source || 'any'}`;
  const cached = dexPxCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DEX_PX_TTL_MS) return cached.px;
  const mq = sqlMintQuoted(mint);
  if (!mq) return null;
  let sql: ReturnType<typeof postgres>;
  try {
    sql = pgPool();
  } catch {
    return null;
  }
  const sources: readonly string[] = ['raydium', 'meteora', 'orca', 'moonshot', 'pumpswap'];
  const tableOrder =
    source && sources.includes(source) ? [`${source}_pair_snapshots`, ...sources.filter((s) => s !== source).map((s) => `${s}_pair_snapshots`)] : DEX_SNAPSHOT_TABLES.slice();
  /** Wider than mcap cache: pair collectors can lag; UI only needs a reasonable reference. */
  const subqueries = tableOrder.map(
    (t) => `
      SELECT ts, price_usd FROM ${t}
      WHERE ${sqlMintPoolMatch(mq)} AND ts >= now() - interval '7 days'
        AND price_usd IS NOT NULL AND price_usd > 0
      ORDER BY ts DESC LIMIT 1
    `,
  ).join(' UNION ALL ');
  try {
    const rows = await sql.unsafe(
      `SELECT ts, price_usd FROM (${subqueries}) sub ORDER BY ts DESC LIMIT 1`,
    );
    if (!rows.length) return null;
    const px = Number(rows[0].price_usd ?? 0);
    if (px > 0) {
      dexPxCache.set(cacheKey, { px, ts: Date.now() });
      return px;
    }
  } catch {
    /* swallow */
  }
  return null;
}

// ---------------------------------------------------------
// store reader
// ---------------------------------------------------------
function loadStore(): { open: OpenTrade[]; closed: ClosedTrade[]; firstTs: number; lastTs: number } {
  if (!fs.existsSync(STORE_PATH)) {
    return { open: [], closed: [], firstTs: Date.now(), lastTs: Date.now() };
  }
  const lines = fs.readFileSync(STORE_PATH, 'utf-8').split('\n').filter(Boolean);
  const openMap = new Map<string, OpenTrade>();
  const closed: ClosedTrade[] = [];
  let firstTs = Date.now();
  let lastTs = 0;

  for (const ln of lines) {
    let e: any;
    try {
      e = JSON.parse(ln);
    } catch {
      continue;
    }
    if (e.ts) {
      if (e.ts < firstTs) firstTs = e.ts;
      if (e.ts > lastTs) lastTs = e.ts;
    }
    if (e.kind === 'open') {
      openMap.set(e.mint, {
        mint: e.mint,
        symbol: e.symbol,
        entryTs: e.entryTs,
        entryMcUsd: e.entryMcUsd,
        peakMcUsd: e.entryMcUsd,
        peakPnlPct: 0,
        trailingArmed: false,
        entryMetrics: e.entryMetrics,
      });
    } else if (e.kind === 'peak' && openMap.has(e.mint)) {
      const ot = openMap.get(e.mint)!;
      ot.peakMcUsd = Math.max(ot.peakMcUsd, e.peakMcUsd ?? 0);
      ot.peakPnlPct = Math.max(ot.peakPnlPct, e.peakPnlPct ?? 0);
      ot.trailingArmed = ot.trailingArmed || !!e.trailingArmed;
    } else if (e.kind === 'close') {
      openMap.delete(e.mint);
      closed.push(e as ClosedTrade);
    }
  }
  return { open: [...openMap.values()], closed, firstTs, lastTs };
}

interface StoreMeta {
  storePath: string;
  exists: boolean;
  bytes: number;
  lineCount: number;
  mtimeIso: string | null;
  /** runner-organizer paper cursor (bigint id), only when journal is organizer-paper*.jsonl */
  paperCursorSignalId: string | null;
  /** Whether organizer cursor path applies to this STORE_PATH */
  organizerJournal: boolean;
  /** Count of JSONL rows by top-level `kind` (best-effort scan) */
  kindCounts: Record<string, number>;
  /** Short explanation: wired vs empty backlog vs waiting for signals */
  hint: string;
}

function computeStoreMeta(): StoreMeta {
  const storePath = path.resolve(STORE_PATH);
  const orgJournal = isOrganizerPaperStorePath(STORE_PATH);
  const out: StoreMeta = {
    storePath,
    exists: false,
    bytes: 0,
    lineCount: 0,
    mtimeIso: null,
    paperCursorSignalId: null,
    organizerJournal: orgJournal,
    kindCounts: {},
    hint: '',
  };
  const cursorPath = resolvedOrgCursorPath();
  try {
    if (cursorPath && fs.existsSync(cursorPath)) {
      const c = fs.readFileSync(cursorPath, 'utf8').trim();
      if (c && /^\d+$/.test(c)) out.paperCursorSignalId = c;
    }
  } catch {
    /* ignore */
  }

  try {
    if (!fs.existsSync(storePath)) {
      out.hint =
        'Файл журнала не найден по STORE_PATH — проверь путь или что бумажный PM2-процесс пишет в этот файл.';
      return out;
    }
    out.exists = true;
    const st = fs.statSync(storePath);
    out.bytes = st.size;
    out.mtimeIso = new Date(st.mtimeMs).toISOString();
    const raw = fs.readFileSync(storePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    out.lineCount = lines.length;
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln) as { kind?: string };
        const k = typeof o.kind === 'string' ? o.kind : '_other';
        out.kindCounts[k] = (out.kindCounts[k] ?? 0) + 1;
      } catch {
        out.kindCounts._parse_error = (out.kindCounts._parse_error ?? 0) + 1;
      }
    }
    const opens = out.kindCounts.open ?? 0;
    const closes = out.kindCounts.close ?? 0;
    const evals = out.kindCounts.eval ?? 0;
    const evSkip =
      (out.kindCounts['eval-skip'] ?? 0) +
      (out.kindCounts['eval-skip-open'] ?? 0);

    if (out.lineCount === 0) {
      out.hint =
        'Журнал пуст — бумажный трейдер ещё не записал ни одной строки (или файл только что создан).';
    } else if (opens === 0 && closes === 0) {
      out.hint =
        orgJournal && out.paperCursorSignalId != null
          ? `Журнал живой (есть строки), но ещё не было paper open/close. Курсор организатора на сигнале id=${out.paperCursorSignalId}: обычно ждём новых строк в runner_organizer_signals с id выше курсора и прохождения гейтов (смотри eval / eval-skip в JSONL и лог PM2).`
          : 'Журнал живой, но ещё не было открытий/закрытий — возможны только eval/heartbeat; проверь фильтры PM2 и причины eval-skip.';
    } else {
      out.hint = `Журнал OK: открытий=${opens}, закрытий=${closes}, eval=${evals}.`;
    }
    if (orgJournal && evals + evSkip > 0 && opens === 0 && out.paperCursorSignalId) {
      out.hint += ` За кадром: eval=${evals}, eval-skip=${evSkip} — часть сигналов отфильтрована до входа.`;
    }
  } catch (e) {
    out.hint = `Ошибка чтения журнала: ${String(e)}`;
  }
  if (!out.hint) out.hint = 'Метаданные журнала без текста — см. lines/bytes.';
  return out;
}

// ---------------------------------------------------------
// metrics
// ---------------------------------------------------------
function computeMetrics(closed: ClosedTrade[]) {
  if (closed.length === 0) {
    return {
      total: 0, wins: 0, losses: 0, winRate: 0,
      sumPnl: 0, avgPnl: 0, avgPeak: 0, bestPnl: 0, worstPnl: 0,
      exits: { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0, FAST_DUMP: 0, LIQ_DROP: 0, FLAT_LOSS: 0 },
      equityCurve: [] as { ts: number; cumPnl: number }[],
    };
  }
  const exits: Record<string, number> = { TP: 0, SL: 0, TRAIL: 0, TIMEOUT: 0, NO_DATA: 0, FAST_DUMP: 0, LIQ_DROP: 0, FLAT_LOSS: 0 };
  let sumPnl = 0;
  let sumPeak = 0;
  let wins = 0;
  let bestPnl = -Infinity;
  let worstPnl = Infinity;
  for (const c of closed) {
    sumPnl += c.pnlPct;
    sumPeak += c.peakPnlPct ?? 0;
    if (c.pnlPct > 0) wins++;
    if (c.pnlPct > bestPnl) bestPnl = c.pnlPct;
    if (c.pnlPct < worstPnl) worstPnl = c.pnlPct;
    exits[c.exitReason] = (exits[c.exitReason] ?? 0) + 1;
  }
  const sortedByExit = [...closed].sort((a, b) => a.exitTs - b.exitTs);
  let cum = 0;
  const equityCurve = sortedByExit.map(c => {
    cum += c.pnlPct;
    return { ts: c.exitTs, cumPnl: cum };
  });
  return {
    total: closed.length,
    wins,
    losses: closed.length - wins,
    winRate: (wins / closed.length) * 100,
    sumPnl,
    avgPnl: sumPnl / closed.length,
    avgPeak: sumPeak / closed.length,
    bestPnl,
    worstPnl,
    exits,
    equityCurve,
  };
}

// ---------------------------------------------------------
// fastify
// ---------------------------------------------------------
const app = Fastify({ logger: false });

// ---------------------------------------------------------
// HTTP Basic Auth (optional, opt-in via env)
//
// If DASHBOARD_BASIC_USER and DASHBOARD_BASIC_PASSWORD are set, every request
// except /api/health (used by external uptime monitors) requires correct
// HTTP Basic credentials. Empty / missing env disables auth (legacy behavior).
// ---------------------------------------------------------
const BASIC_USER = (process.env.DASHBOARD_BASIC_USER || '').trim();
const BASIC_PASS = (process.env.DASHBOARD_BASIC_PASSWORD || '').trim();
const BASIC_REALM = process.env.DASHBOARD_BASIC_REALM || 'Solana Alpha Dashboard';
const BASIC_AUTH_ENABLED = BASIC_USER.length > 0 && BASIC_PASS.length > 0;
const BASIC_AUTH_BYPASS = new Set<string>(['/api/health']);
const BASIC_AUTH_HTML_PATHS = new Set(['/', '/papertrader2', '/smart-lottery', '/SmartLottery']);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function parseBasicAuthHeader(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.toLowerCase().startsWith('basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

/** После успешного входа — HttpOnly cookie; мобильные браузеры часто не прикрепляют Authorization к fetch(/api/…). */
const DASH_SESSION_COOKIE = 'sa_dash_sess';
const DASH_SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60;

function dashSessionSecret(): crypto.BinaryLike {
  const raw = (process.env.DASHBOARD_SESSION_SECRET || '').trim();
  if (raw.length >= 16) return raw;
  return crypto.createHash('sha256').update(`sa-dash-sess|${BASIC_USER}|${BASIC_PASS}`, 'utf8').digest();
}

function signDashSession(): string {
  const exp = Math.floor(Date.now() / 1000) + DASH_SESSION_MAX_AGE_SEC;
  const payload = `${BASIC_USER}:${exp}`;
  const mac = crypto.createHmac('sha256', dashSessionSecret()).update(payload).digest();
  const inner = `${payload}:${mac.toString('base64url')}`;
  return Buffer.from(inner, 'utf8').toString('base64url');
}

function verifyDashSession(token: string): boolean {
  try {
    const inner = Buffer.from(token, 'base64url').toString('utf8');
    const sigSep = inner.lastIndexOf(':');
    if (sigSep < 0) return false;
    const payload = inner.slice(0, sigSep);
    const sigStr = inner.slice(sigSep + 1);
    const userSep = payload.indexOf(':');
    if (userSep < 0) return false;
    const u = payload.slice(0, userSep);
    const exp = Number(payload.slice(userSep + 1));
    if (u !== BASIC_USER || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const mac = crypto.createHmac('sha256', dashSessionSecret()).update(payload).digest();
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sigStr, 'base64url');
    } catch {
      return false;
    }
    if (sigBuf.length !== mac.length) return false;
    return crypto.timingSafeEqual(sigBuf, mac);
  } catch {
    return false;
  }
}

function parseCookieHeader(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (k) {
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      out[k] = v;
    }
  }
  return out;
}

function dashCookieSecure(req: { headers: Record<string, unknown> }): boolean {
  if ((process.env.DASHBOARD_COOKIE_SECURE || '').trim() === '0') return false;
  const xf = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (xf === 'https') return true;
  return process.env.NODE_ENV === 'production';
}

function buildDashSetCookie(token: string, req: { headers: Record<string, unknown> }): string {
  const parts = [
    `${DASH_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${DASH_SESSION_MAX_AGE_SEC}`,
  ];
  if (dashCookieSecure(req)) parts.push('Secure');
  return parts.join('; ');
}

if (BASIC_AUTH_ENABLED) {
  app.addHook('onRequest', async (req, reply) => {
    const url = (req.raw.url || '/').split('?')[0];
    if (BASIC_AUTH_BYPASS.has(url)) return;
    if (req.method === 'GET' && BASIC_AUTH_HTML_PATHS.has(url)) return;

    const cookies = parseCookieHeader(req.headers.cookie as string | undefined);
    const sessionTok = cookies[DASH_SESSION_COOKIE];
    const sessionOk = !!sessionTok && verifyDashSession(sessionTok);

    const creds = parseBasicAuthHeader(req.headers['authorization'] as string | undefined);
    const basicOk = !!creds && safeEqual(creds.user, BASIC_USER) && safeEqual(creds.pass, BASIC_PASS);

    if (sessionOk || basicOk) {
      reply.header('Set-Cookie', buildDashSetCookie(signDashSession(), req));
      return;
    }

    reply
      .header('WWW-Authenticate', `Basic realm="${BASIC_REALM.replace(/"/g, '')}", charset="UTF-8"`)
      .code(401)
      .send({ ok: false, error: 'unauthorized' });
  });
  console.log(
    `[dashboard] HTTP Basic Auth ENABLED (user=${BASIC_USER}, cookie=${DASH_SESSION_COOKIE}, bypass=${[...BASIC_AUTH_BYPASS].join(',')})`,
  );
} else {
  console.log('[dashboard] HTTP Basic Auth disabled (set DASHBOARD_BASIC_USER + DASHBOARD_BASIC_PASSWORD to enable)');
}

// ---------------------------------------------------------
// visit counter (privacy: store hashed IP prefix only)
// ---------------------------------------------------------
function hashIp(ip: string): string {
  const trimmed = ip.replace(/^::ffff:/, '').split(',')[0].trim();
  // оставляем только первые 2 октета IPv4 / первые 4 группы IPv6 + соль
  const trunc = trimmed.includes(':') ? trimmed.split(':').slice(0, 4).join(':') : trimmed.split('.').slice(0, 2).join('.');
  return crypto.createHash('sha256').update('laivy-salt|' + trunc).digest('hex').slice(0, 12);
}

interface VisitRow { ts: number; ip: string; ua: string; ref: string }

function loadVisits(): VisitRow[] {
  if (!fs.existsSync(VISITS_PATH)) return [];
  return fs.readFileSync(VISITS_PATH, 'utf-8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as VisitRow; } catch { return null; } })
    .filter(Boolean) as VisitRow[];
}

function recordVisit(ip: string, ua: string, ref: string): void {
  const row: VisitRow = { ts: Date.now(), ip: hashIp(ip), ua: (ua || '').slice(0, 120), ref: (ref || '').slice(0, 120) };
  try { fs.appendFileSync(VISITS_PATH, JSON.stringify(row) + '\n'); } catch {}
}

function visitStats() {
  const all = loadVisits();
  const now = Date.now();
  const hour = 3_600_000, day = 86_400_000;
  const uniqDay = new Set<string>();
  const uniqHour = new Set<string>();
  const uniq7d = new Set<string>();
  let pageviewsHour = 0, pageviewsDay = 0;
  for (const v of all) {
    const age = now - v.ts;
    if (age <= 7 * day) uniq7d.add(v.ip);
    if (age <= day) { uniqDay.add(v.ip); pageviewsDay++; }
    if (age <= hour) { uniqHour.add(v.ip); pageviewsHour++; }
  }
  return {
    total: all.length,
    pageviewsDay, pageviewsHour,
    uniqueDay: uniqDay.size,
    uniqueHour: uniqHour.size,
    unique7d: uniq7d.size,
  };
}

function getClientIp(req: any): string {
  return (req.headers['x-real-ip'] as string)
      || (req.headers['x-forwarded-for'] as string)
      || req.ip || req.socket?.remoteAddress || '0.0.0.0';
}

app.get('/', async (req, reply) => {
  recordVisit(getClientIp(req), req.headers['user-agent'] as string, req.headers['referer'] as string);
  const html = fs.readFileSync(HTML_PATH, 'utf-8');
  reply.header('content-type', 'text/html; charset=utf-8');
  return html;
});

app.get('/api/visits', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return visitStats();
});

app.get('/api/state', async (_req, reply) => {
  const { open, closed, firstTs, lastTs } = loadStore();

  const enriched = await Promise.all(
    open.map(async ot => {
      const curMc = await getCurrentMc(ot.mint);
      const cur = curMc ?? ot.peakMcUsd;
      const pnlPct = curMc ? ((curMc / ot.entryMcUsd) - 1) * 100 : 0;
      const ageMin = (Date.now() - ot.entryTs) / 60_000;
      const peakReached = Math.max(ot.peakPnlPct, pnlPct);
      return {
        mint: ot.mint,
        symbol: ot.symbol,
        entryTs: ot.entryTs,
        entryMcUsd: ot.entryMcUsd,
        currentMcUsd: cur,
        peakMcUsd: Math.max(ot.peakMcUsd, cur),
        pnlPct,
        peakPnlPct: peakReached,
        ageMin,
        trailingArmed: ot.trailingArmed || pnlPct >= 50,
        hasLiveMc: !!curMc,
      };
    })
  );

  const metrics = computeMetrics(closed);
  const recentClosed = [...closed].sort((a, b) => b.exitTs - a.exitTs).slice(0, 30);
  const topWinners = [...closed].sort((a, b) => b.pnlPct - a.pnlPct).slice(0, 5);
  const topLosers = [...closed].sort((a, b) => a.pnlPct - b.pnlPct).slice(0, 5);

  reply.header('cache-control', 'no-store');
  const storeMeta = computeStoreMeta();
  return {
    now: Date.now(),
    firstTs,
    lastTs,
    hoursOfData: (lastTs - firstTs) / 3_600_000,
    storeMeta,
    metrics,
    open: enriched,
    recentClosed,
    topWinners,
    topLosers,
    config: {
      tp: 3.0,
      sl: 0.3,
      trailTrigger: 1.5,
      trailDrop: 0.4,
      timeoutHours: 12,
      windowStartMin: 2,
      decisionAgeMin: 7,
    },
  };
});

app.get('/api/health', async () => ({ ok: true, ts: Date.now() }));

app.get('/api/qn/usage', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return qnUsageSnapshot();
});

function parserProgramId(): string {
  return (
    process.env.SA_PARSER_PROGRAM_ID?.trim() || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
  );
}

const ATLAS_CURSOR_NAME = 'swap-enrich';

app.get('/api/atlas/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM entity_wallets) AS ew_total,
        (SELECT count(*)::bigint FROM entity_wallets WHERE profile_updated_at > now() - interval '5 minutes') AS ew_m5,
        (SELECT count(*)::bigint FROM wallet_tags WHERE source = 'sa-atlas') AS atlas_tags_total,
        (SELECT count(*)::bigint FROM wallet_tags WHERE source = 'sa-atlas' AND added_at > now() - interval '5 minutes') AS atlas_tags_m5,
        (SELECT count(*)::bigint FROM money_flows WHERE observed_at > now() - interval '5 minutes' AND target_wallet LIKE 'pump:%') AS atlas_flows_m5,
        (SELECT last_swap_id FROM atlas_cursor WHERE name = ${ATLAS_CURSOR_NAME}) AS cursor_id,
        (SELECT count(*)::bigint FROM swaps WHERE id > coalesce((SELECT last_swap_id FROM atlas_cursor WHERE name = ${ATLAS_CURSOR_NAME}), 0)) AS lag_swaps
    `;
    return {
      ew_total: Number(row.ew_total),
      ew_m5: Number(row.ew_m5),
      atlas_tags_total: Number(row.atlas_tags_total),
      atlas_tags_m5: Number(row.atlas_tags_m5),
      atlas_flows_m5: Number(row.atlas_flows_m5),
      cursor_id: row.cursor_id != null ? String(row.cursor_id) : null,
      lag_swaps: Number(row.lag_swaps),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/parser/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const pid = parserProgramId();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM swaps) AS swaps_total,
        (SELECT count(*)::bigint FROM swaps WHERE created_at > now() - interval '1 minute') AS m1,
        (SELECT count(*)::bigint FROM swaps WHERE created_at > now() - interval '5 minutes') AS m5,
        (SELECT max(block_time) FROM swaps) AS last_block_time,
        (SELECT max(created_at) FROM swaps) AS last_inserted_at,
        (SELECT last_event_id FROM parser_cursor WHERE program_id = ${pid}) AS cursor_id,
        (SELECT count(*)::bigint FROM stream_events
           WHERE program_id = ${pid}
             AND id > coalesce((SELECT last_event_id FROM parser_cursor WHERE program_id = ${pid}), 0)) AS lag_events
    `;
    return {
      swaps_total: Number(row.swaps_total),
      m1: Number(row.m1),
      m5: Number(row.m5),
      last_block_time: row.last_block_time,
      last_inserted_at: row.last_inserted_at,
      cursor_id: row.cursor_id != null ? String(row.cursor_id) : null,
      lag_events: Number(row.lag_events),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/stream/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM stream_events) AS total,
        (SELECT count(*)::bigint FROM stream_events WHERE received_at > now() - interval '1 minute') AS m1,
        (SELECT count(*)::bigint FROM stream_events WHERE received_at > now() - interval '5 minutes') AS m5,
        (SELECT max(received_at) FROM stream_events) AS last_event_at,
        (SELECT count(DISTINCT program_id)::bigint FROM stream_events) AS distinct_programs
    `;
    return {
      total: Number(row.total),
      m1: Number(row.m1),
      m5: Number(row.m5),
      last_event_at: row.last_event_at,
      distinct_programs: Number(row.distinct_programs),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

const DEX_SOURCE_TABLES = {
  raydium: 'raydium_pair_snapshots',
  meteora: 'meteora_pair_snapshots',
  orca: 'orca_pair_snapshots',
  moonshot: 'moonshot_pair_snapshots',
  pumpswap: 'pumpswap_pair_snapshots',
} as const;

app.get<{ Params: { source: string } }>('/api/dex/:source/health', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  const src = String(req.params.source || '').toLowerCase();
  const table = DEX_SOURCE_TABLES[src as keyof typeof DEX_SOURCE_TABLES];
  if (!table) {
    reply.code(404);
    return { ok: false, error: `unknown source: ${src}` };
  }
  try {
    const sql = pgPool();
    const [row] = await sql.unsafe(
      `SELECT
        (SELECT count(*)::bigint FROM ${table}) AS total,
        (SELECT count(*)::bigint FROM ${table} WHERE created_at > now() - interval '1 minute') AS m1,
        (SELECT count(*)::bigint FROM ${table} WHERE created_at > now() - interval '5 minutes') AS m5,
        (SELECT max(ts) FROM ${table}) AS last_bucket_ts,
        (SELECT max(created_at) FROM ${table}) AS last_inserted_at,
        (SELECT count(DISTINCT base_mint)::bigint FROM ${table} WHERE ts > now() - interval '1 hour') AS distinct_mints_h1`,
    );
    return {
      source: src,
      total: Number(row.total),
      m1: Number(row.m1),
      m5: Number(row.m5),
      last_bucket_ts: row.last_bucket_ts,
      last_inserted_at: row.last_inserted_at,
      distinct_mints_h1: Number(row.distinct_mints_h1),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/jupiter/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM jupiter_route_snapshots) AS total,
        (SELECT count(*)::bigint FROM jupiter_route_snapshots WHERE created_at > now() - interval '5 minutes') AS m5,
        (SELECT count(*)::bigint FROM jupiter_route_snapshots WHERE created_at > now() - interval '5 minutes' AND routeable = true) AS routeable_m5,
        (SELECT max(ts) FROM jupiter_route_snapshots) AS last_bucket_ts,
        (SELECT count(DISTINCT mint)::bigint FROM jupiter_route_snapshots WHERE ts > now() - interval '1 hour') AS distinct_mints_h1
    `;
    return {
      total: Number(row.total),
      m5: Number(row.m5),
      routeable_m5: Number(row.routeable_m5),
      last_bucket_ts: row.last_bucket_ts,
      distinct_mints_h1: Number(row.distinct_mints_h1),
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

app.get('/api/direct-lp/health', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  try {
    const sql = pgPool();
    const [row] = await sql`
      SELECT
        (SELECT count(*)::bigint FROM direct_lp_events) AS total,
        (SELECT count(*)::bigint FROM direct_lp_events WHERE created_at > now() - interval '1 hour') AS h1,
        (SELECT max(ts) FROM direct_lp_events) AS last_event_ts,
        (SELECT count(DISTINCT base_mint)::bigint FROM direct_lp_events WHERE ts > now() - interval '24 hours') AS distinct_mints_d1,
        (SELECT avg(confidence)::float FROM direct_lp_events WHERE ts > now() - interval '24 hours') AS avg_confidence_d1
    `;
    return {
      total: Number(row.total),
      h1: Number(row.h1),
      last_event_ts: row.last_event_ts,
      distinct_mints_d1: Number(row.distinct_mints_d1),
      avg_confidence_d1: row.avg_confidence_d1 != null ? Number(row.avg_confidence_d1) : null,
    };
  } catch (e) {
    reply.code(503);
    return { ok: false, error: String(e) };
  }
});

// ---------------------------------------------------------
// /api/paper2 — фиксированный порядок плиток Oscar (`mergeDashboardStrategyPanels`, см. `DASHBOARD_PANEL_ORDER`).
// Uses W6.3c close.netPnlUsd directly (NOT pctToUsd(pnlPct)).
// ---------------------------------------------------------
export type Paper2OpenItem = {
  mint: string;
  symbol: string;
  entryTs: number;
  entryMcUsd: number;
  entryRealMcUsd: number | null;
  /** Entry spot USD/token from journal (`entryMarketPrice` / legs[0].marketPrice). Used when metricType=price. */
  baselinePriceUsd: number | null;
  openedAtIso: string | null;
  lane: string | null;
  source: string | null;
  metricType: string | null;
  features: unknown;
  btc: unknown;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  totalInvestedUsd: number;
  /** W7.3 — per-tx network fee snapshot from journal `open.priorityFee.usd`. */
  entryPriorityFeeUsd: number | null;
  /** W7.4 — Jupiter pre-entry quote vs snapshot (open row only; carried to closed via journal map). */
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
  /** W7.5 — pool address from journal open row / features. */
  pairAddress: string | null;
  /** W7.5 — entry liquidity USD baseline. */
  entryLiqUsd: number | null;
  /**
   * Fraction of the position still held (from last `partial_sell.remainingFraction`, else 1).
   * DCA rows reset the live tracker position to 100% remainder — we mirror that via `dca_add` handling.
   */
  remainingFraction: number;
  /** Live Oscar trade lane (`prod` / `scalp_wave` mutex; `runner_probe` parallel via composite open key). */
  liveOscarTradeLane: 'prod' | 'scalp_wave' | 'runner_probe' | null;
  /** True while position is actively managed as scalp_wave (false after phase escalation). */
  isScalpWave: boolean;
  /** Fresh runners 12–48h lane (`runner_probe_v1` exit). */
  isRunnerProbe: boolean;
  /** Parallel copy-leader leg on shared wallet — separate open row from Oscar on same mint. */
  isCopyLeader?: boolean;
  positionSource?: 'copy_leader' | 'runner_probe' | null;
  /** Truncated leader wallet for UI, e.g. `498S…aNma`. */
  copyLeaderWalletShort?: string | null;
};

type Paper2ClosedRow = Record<string, unknown>;

type PriceVerifyDtoFromJsonl = {
  kind: 'ok' | 'blocked' | 'skipped';
  slipPct?: number;
  priceImpactPct?: number;
};

function priceVerifyUiFields(pv: unknown): {
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
} {
  if (!pv || typeof pv !== 'object') {
    return {
      entryPriceVerifySlipPct: null,
      entryPriceVerifyImpactPct: null,
      entryPriceVerifySource: null,
    };
  }
  const p = pv as PriceVerifyDtoFromJsonl;
  const entryPriceVerifySlipPct =
    p.kind !== 'skipped' && Number.isFinite(p.slipPct) ? +Number(p.slipPct).toFixed(2) : null;
  const entryPriceVerifyImpactPct =
    p.kind !== 'skipped' && Number.isFinite(p.priceImpactPct)
      ? +Number(p.priceImpactPct).toFixed(2)
      : null;
  const entryPriceVerifySource: 'jupiter' | 'skipped' | 'blocked' | null =
    p.kind === 'ok' ? 'jupiter' : p.kind === 'blocked' ? 'blocked' : p.kind === 'skipped' ? 'skipped' : null;
  return { entryPriceVerifySlipPct, entryPriceVerifyImpactPct, entryPriceVerifySource };
}

const PAPER2_PRICE_VERIFY_AGG_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Плитки `/papertrader2`: Live Oscar · SuperBot · DCA · HL Oscar alts · BasePulse · BscPulse · HL Majors. */
export const DASHBOARD_PANEL_ORDER = [
  'live-oscar',
  'superbot',
  'dc-trader',
  'hl-oscar-perp',
  'base-pulse',
  'bsc-pulse',
  'hl-oscar-majors',
] as const;

export const DASHBOARD_PAPER2_BUILD_ID = '2026-07-01-dashboard-runner-probe-badge-v1';

export type DashboardPaper2StrategyRow = {
  strategyId: string;
  file: string;
  openCount: number;
  closedCount: number;
  startedAt: number;
  lastTs: number;
  hoursOfData: number;
  sumPnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  totalPnlUsd: number;
  winRate: number;
  avgPnl: number;
  avgPeak: number;
  bestPnlUsd: number;
  worstPnlUsd: number;
  unrealizedUsd: number;
  exits: Record<string, number>;
  exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }>;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  open: unknown[];
  recentClosed: unknown[];
  priorityFeeUsdTotal: number;
  priceVerify: {
    okCount: number;
    blockedCount: number;
    skippedCount: number;
    avgSlipPct: number | null;
    p90SlipPct: number | null;
  };
  liqDrain: { exits: number; avgDropPct: number | null; p90DropPct: number | null };
  /** Last boot reconcile fields from `heartbeat` (live-oscar / Phase 7). */
  liveReconcileBoot?: {
    status?: string;
    skipReason?: string;
    divergentCount?: number;
    chainOnlyCount?: number;
    journalTruncated?: boolean;
  };
  /** Last structured row from `live_reconcile_report` (`liveSchema: 2`). */
  liveReconcileReport?: {
    ts: number;
    ok: boolean;
    reconcileStatus: string;
    txAnchorMissing?: number;
    txAnchorRpcErrors?: number;
  };
  /** Copy-trader execution counters + pending queue (legacy; not a dashboard tile). */
  copyTrader?: CopyTraderDashboardStats;
  /** DCA Trader (dc-trader) vault counters — tile 3. */
  dcTrader?: DcTraderDashboardStats;
  /** dc-trader vaults in watch-only state (not open positions). */
  dcTraderWatching?: unknown[];
  /** SuperBot stream/race counters (pumpswap-flow-sniper journal). */
  superbot?: SuperbotDashboardLoad['superbot'];
  /** HL Oscar perp / majors bot meta (tiles 4 and 7). */
  hlOscar?: {
    mode: 'dry_run' | 'live';
    liveDryRun: boolean;
    openCount: number;
    universeSize: number;
    leverage: number;
    notionalUsd: number;
    marginUsd: number;
  };
};

function aggregatePriceVerifyFromJsonl(filePath: string, windowMs: number): {
  okCount: number;
  blockedCount: number;
  skippedCount: number;
  avgSlipPct: number | null;
  p90SlipPct: number | null;
} {
  const slips: number[] = [];
  let blocked = 0;
  let skipped = 0;
  if (!fs.existsSync(filePath)) {
    return { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null };
  }
  const cutoff = Date.now() - windowMs;
  for (const ln of dashboardJsonlLines(filePath)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts < cutoff) continue;
    if (ev.kind === 'open' && ev.priceVerify && typeof ev.priceVerify === 'object') {
      const pv = ev.priceVerify as { kind?: string; slipPct?: number };
      if (pv.kind === 'ok') {
        const s = Number(pv.slipPct);
        if (Number.isFinite(s)) slips.push(s);
      } else if (pv.kind === 'blocked') blocked += 1;
      else if (pv.kind === 'skipped') skipped += 1;
    } else if (
      ev.kind === 'eval-skip-open' &&
      typeof ev.reason === 'string' &&
      ev.reason.startsWith('price_verify:')
    ) {
      blocked += 1;
    }
  }
  const sortedSlips = [...slips].sort((a, b) => a - b);
  const avgSlipPct =
    slips.length > 0 ? +((slips.reduce((a, b) => a + b, 0) / slips.length).toFixed(3)) : null;
  const p90SlipPct =
    slips.length > 0
      ? sortedSlips[Math.min(sortedSlips.length - 1, Math.floor(sortedSlips.length * 0.9))]
      : null;
  return {
    okCount: slips.length,
    blockedCount: blocked,
    skippedCount: skipped,
    avgSlipPct,
    p90SlipPct,
  };
}

function priceVerifyStatsEndpointSlice(filePath: string, windowMs: number): {
  okCount: number;
  blockedCount: number;
  skippedCount: number;
  avgSlipPct: number | null;
  p90SlipPct: number | null;
  avgImpactPct: number | null;
} {
  const slips: number[] = [];
  const impacts: number[] = [];
  let blocked = 0;
  let skipped = 0;
  if (!fs.existsSync(filePath)) {
    return {
      okCount: 0,
      blockedCount: 0,
      skippedCount: 0,
      avgSlipPct: null,
      p90SlipPct: null,
      avgImpactPct: null,
    };
  }
  const cutoff = Date.now() - windowMs;
  for (const ln of dashboardJsonlLines(filePath)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts < cutoff) continue;
    if (ev.kind === 'open' && ev.priceVerify && typeof ev.priceVerify === 'object') {
      const pv = ev.priceVerify as { kind?: string; slipPct?: number; priceImpactPct?: number };
      if (pv.kind === 'ok') {
        if (Number.isFinite(pv.slipPct)) slips.push(Number(pv.slipPct));
        if (Number.isFinite(pv.priceImpactPct)) impacts.push(Number(pv.priceImpactPct));
      } else if (pv.kind === 'blocked') {
        blocked += 1;
      } else if (pv.kind === 'skipped') {
        skipped += 1;
      }
    } else if (
      ev.kind === 'eval-skip-open' &&
      typeof ev.reason === 'string' &&
      ev.reason.startsWith('price_verify:')
    ) {
      blocked += 1;
    }
  }
  const sorted = [...slips].sort((a, b) => a - b);
  const avgSlipPct =
    slips.length > 0 ? +((slips.reduce((a, b) => a + b, 0) / slips.length).toFixed(3)) : null;
  const p90SlipPct =
    slips.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] : null;
  const avgImpactPct =
    impacts.length > 0
      ? +((impacts.reduce((a, b) => a + b, 0) / impacts.length).toFixed(3))
      : null;
  return {
    okCount: slips.length,
    blockedCount: blocked,
    skippedCount: skipped,
    avgSlipPct,
    p90SlipPct,
    avgImpactPct,
  };
}

/**
 * Per-position audit timeline derived from jsonl events.
 * mcUsd is USD market cap when known (only when metricType === 'mc'),
 * null otherwise (so the UI can render "mcap n/a" exactly like the spec).
 */
export type TimelineEvent = {
  ts: number;
  kind: 'open' | 'dca_add' | 'scale_in_add' | 'partial_sell' | 'close' | 'strategy_note';
  label: string;
  mcUsd: number | null;
  /** Spot USD/token at event time when strategy tracks price not mcap */
  spotPxUsd: number | null;
  /** % of base position (DCA) or % of remaining position (partial_sell). */
  sizePct: number | null;
  pnlPct: number | null;
  pnlUsd: number | null;
  reason: string | null;
  remainingFraction: number | null;
  /**
   * Trade-flow USD for dashboard: buys (open / DCA); partial_sell = gross proceeds;
   * close = cost basis of closed slice. Not mark-to-market.
   */
  amountUsd: number | null;
  /** Set when live journal correlates an on-chain swap (`execution_result.txSignature`). */
  txSignature?: string | null;
  /** Copy-trader: leader order tx (primary Solscan link). */
  leaderTxSignature?: string | null;
  /** Copy-trader: our mirror execution tx. */
  ourTxSignature?: string | null;
  /** Доп. строки: TP-regime (paper), режим выхода A/B (live) — см. IDEALIZED_OSCAR_STACK_SPEC. */
  contextNote?: string | null;
};

/** Solana mainnet explorer link for a transaction signature. */
export function solscanTxUrl(signature: string): string {
  const s = String(signature ?? '').trim();
  return `https://solscan.io/tx/${encodeURIComponent(s)}`;
}

/** Open row shape returned by `/api/paper2` after live enrichment. */
export type Paper2ApiEnrichedOpen = {
  mint: string;
  symbol: string;
  entryTs: number;
  entryMcUsd: number;
  entryRealMcUsd: number | null;
  entryMcapAtBuyUsd: number | null;
  baselinePriceUsd: number | null;
  metricType: string | null;
  openedAtIso: string | null;
  lane: string | null;
  source: string | null;
  currentMcUsd: number;
  livePriceUsd: number | null;
  peakMcUsd: number;
  peakPnlPct: number;
  trailingArmed: boolean;
  pnlPct: number | null;
  pnlUsd: number | null;
  ageMin: number;
  hasLiveMc: boolean;
  hasLivePrice: boolean;
  livePriceStale: boolean;
  livePxProvenance: 'snapshots' | 'jupiter' | 'pump.fun' | 'journal' | 'dexscreener' | null;
  /** DexScreener 24h volume (EVM pulse panels). */
  vol24hUsd?: number | null;
  /** Live FDV / mcap from DexScreener (EVM pulse panels). */
  liveFdvUsd?: number | null;
  liveMcProvenance: 'snapshots' | 'pump.fun' | null;
  timeline: TimelineEvent[];
  entryPriorityFeeUsd: number | null;
  entryPriceVerifySlipPct: number | null;
  entryPriceVerifyImpactPct: number | null;
  entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
  /** Pool/pair address (EVM pulse panels — DexScreener ticker links). */
  pairAddress?: string | null;
  entryLiqUsd: number | null;
  currentLiqUsd: number | null;
  liqDropPct: number | null;
  remainingCostBasisUsd: number;
  liveOscarTradeLane: 'prod' | 'scalp_wave' | 'runner_probe' | null;
  isScalpWave: boolean;
  isRunnerProbe: boolean;
  isCopyLeader?: boolean;
  positionSource?: 'copy_leader' | 'runner_probe' | null;
  copyLeaderWalletShort?: string | null;
  copySizeUsd?: number | null;
};

const TIMELINE_SPOT_FALLBACK_MAX_AGE_MS = 48 * 3600 * 1000;

/**
 * Last known journal spot px (DCA / ladder / close) when pair_snapshots miss the mint.
 * IMPORTANT: skip the `open` event itself — its spot equals the entry price by construction,
 * which would yield pnlPct ≡ 0 and mask the real unrealized PnL.
 */
function latestTimelineSpotUsd(timeline: TimelineEvent[], maxAgeMs: number): number | null {
  const now = Date.now();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const ev = timeline[i];
    if (ev.kind === 'open') continue;
    const p = Number(ev.spotPxUsd ?? 0);
    if (!(p > 0)) continue;
    if (now - ev.ts <= maxAgeMs) return p;
  }
  return null;
}

function fmtSignedPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '';
  const sign = p >= 0 ? '+' : '';
  return `${sign}${p.toFixed(0)}%`;
}

/** Человекочитаемое пояснение к классу пути до входа (журнал `tpRegime`). */
function tpRegimeRu(tp: unknown): string | null {
  const raw = typeof tp === 'string' ? tp.trim().toLowerCase() : '';
  if (!raw) return null;
  const map: Record<string, string> = {
    down: 'вниз',
    up: 'вверх',
    sideways: 'флэт',
    unknown: 'не классифицирован',
  };
  return map[raw] ?? raw;
}

function fmtDropPctRaw(v: number): string {
  return Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1);
}

function liveStagedEntryState(e: Record<string, unknown>): Record<string, unknown> | null {
  const st = e.liveStagedEntry;
  return st != null && typeof st === 'object' ? (st as Record<string, unknown>) : null;
}

function liveStagedOpenLabelRu(strategyId: string, e: Record<string, unknown>): string | null {
  return liveStagedOpenLabelFromState(strategyId, e);
}

/** Контекст Variant A v2 hybrid (prod) для таймлайна live-oscar. */
function liveOscarHybridTimelineNote(): string {
  return liveOscarHybridStrategyNoteRu();
}

/** Контекст Variant A v3 scratch (in-flight) для таймлайна live-oscar. */
function liveOscarScratchTimelineNote(): string {
  const tail = Number(process.env.PAPER_LIVE_OSCAR_VARIANT_A_SCRATCH_GAP_TAIL_PCT ?? 0.03);
  return liveOscarScratchStrategyNoteRu({
    liveOscarVariantAScratchGapTailPct: tail,
  } as PaperTraderConfig);
}

function liveOscarExitPolicyIdFromJournal(e: Record<string, unknown>): string {
  const direct = e.liveExitPolicyId;
  if (typeof direct === 'string' && direct.length) return direct;
  const ot = e.openTrade;
  if (ot != null && typeof ot === 'object') {
    const id = (ot as Record<string, unknown>).liveExitPolicyId;
    if (typeof id === 'string' && id.length) return id;
  }
  return '';
}

/** Контекст для строк таймлайна open/close (paper + live). */
function timelineContextNoteFromJournal(e: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const tpRu = tpRegimeRu(e.tpRegime);
  if (tpRu) parts.push(`Класс пути до входа (TP-regime): ${tpRu} (${String(e.tpRegime)})`);
  const mode = e.liveExitProfileMode;
  const evKind = String(e.kind || '');
  const strategyId = String(e.strategyId || '');
  const isLiveOscar = strategyId === 'live-oscar';
  const isLiveOscarRisky = strategyId === 'live-oscar-risky';
  const isPresetC = strategyId === LIVE_OSCAR_PRESET_C_STRATEGY_ID;
  if (isPresetC) {
    parts.push(presetCTimelineContextNote(evKind));
    return parts.join('\n');
  }
  if (isLiveOscarRisky) {
    if (mode === 'A') {
      parts.push(
        'Режим A (Live Oscar Risky): позиция ещё без staged-добора; TP-сетка +3% к средней, продажа 10% остатка за ступень; signal kill-stop −18% от первоначального сигнала; trail `ladder_retrace` после TP.',
      );
    } else if (mode === 'B') {
      parts.push(
        'Режим B (Live Oscar Risky): включён после staged-добора. Доборы: $70 на −6% и $80 на −12% от сигнала, только первый час, пока не сработали оба добора или не накопилось две ступени TP-сетки (TP_LADDER); TP-сетка +3% к avg, продажа 10% остатка; signal kill-stop −18%; timeout B — 4 ч.',
      );
    } else if (evKind === 'open' || evKind === 'scale_in_add') {
      parts.push(
        'Вход Live Oscar Risky: первая нога $50 покупается сразу по сигналу; 10-мин recheck и Telegram-кандидаты выключены. План доборов: $70 на −6% и $80 на −12% от цены сигнала; whitelist выключен, остаются blacklist/denylist.',
      );
    }
    return parts.length ? parts.join('\n') : null;
  }
  if (isLiveOscar) {
    const exitPolicyId = liveOscarExitPolicyIdFromJournal(e);
    const scratchV3 = exitPolicyId === 'variant_a_v3';
    const hybridV2 = exitPolicyId === 'variant_a_v2' || exitPolicyId === '';
    if (mode === 'B' || mode === 'A') {
      parts.push(
        'Режим выхода ' +
          mode +
          ' (Live Oscar, legacy): сделка велась под историческими параметрами A/B. Текущая стратегия — Variant A v2 hybrid.',
      );
    } else if (evKind === 'open' || evKind === 'scale_in_add' || evKind === 'entry_split_add') {
      const st = liveStagedEntryState(e);
      parts.push(st?.entrySplitV2 === true ? liveOscarEntryContextNoteV2() : liveOscarEntryContextNoteLegacy());
      if (scratchV3) parts.push(liveOscarScratchTimelineNote());
      else if (hybridV2 || st?.entrySplitV2 === true) parts.push(liveOscarHybridTimelineNote());
    } else if (
      evKind === 'dca_add' ||
      evKind === 'staged_avg_add' ||
      evKind === 'entry_split_add'
    ) {
      const st = liveStagedEntryState(e);
      if (st?.entrySplitV2 === true) {
        parts.push(liveOscarEntryContextNoteV2());
        parts.push(scratchV3 ? liveOscarScratchTimelineNote() : liveOscarHybridTimelineNote());
      }
    } else if (
      evKind === 'partial_sell' &&
      (String(e.reason) === 'SCRATCH_FLUSH0' || String(e.reason) === 'SCRATCH_GAP_FLUSH')
    ) {
      parts.push(liveOscarScratchTimelineNote());
    } else if (scratchV3) {
      parts.push(liveOscarScratchTimelineNote());
    } else if (hybridV2 || evKind === 'close') {
      parts.push(liveOscarHybridTimelineNote());
    } else {
      parts.push(
        'Live Oscar: Variant A v2 hybrid — см. описание стратегии на плитке.',
      );
    }
    return parts.length ? parts.join('\n') : null;
  }
  if (mode === 'A') {
    parts.push(
      'Режим A: назначается при первой ступени лестницы TP (live-oscar) или аналогичном профиле; лестница и kill/trail — как в env режима A (`PAPER_TP_GRID_*`, `PAPER_DCA_KILLSTOP`).',
    );
  } else if (mode === 'B') {
    parts.push(
      'Режим B: после усреднения по `PAPER_DCA_LEVELS` или второй ноги. Сетка B берётся из `PAPER_LIVE_EXIT_MODE_B_TP_GRID_*`; kill/trail/timeout — из env B; трейл `ladder_retrace` — откат к предыдущей ступени. До закрытия не откатывается в A. Применимо к Paper Oscar V2.x и Live Oscar Risky; для основного Live Oscar A/B унифицированы (один режим).',
    );
  } else if (evKind === 'open' || evKind === 'scale_in_add') {
    parts.push(
      'Режим выхода A/B не назначен: либо стратегия с унифицированным профилем (основной Live Oscar), либо двухногий плановый сплит без DCA по просадке.',
    );
  }
  return parts.length ? parts.join('\n') : null;
}

function liveExitModeLabelSuffix(e: Record<string, unknown>): string {
  const mode = e.liveExitProfileMode;
  if (mode === 'B') return ' · режим B';
  if (mode === 'A') return ' · режим A';
  return '';
}

export function buildTimelineEvent(
  e: Record<string, unknown>,
  metricType: string | null,
  entryRealMcUsd: number | null,
): TimelineEvent | null {
  const ts = Number(e.ts ?? 0);
  if (!ts) return null;
  const kind = String(e.kind || '');
  const strategyId = String(e.strategyId || '');
  const isLiveOscarRisky = strategyId === 'live-oscar-risky';
  const isPresetC = strategyId === LIVE_OSCAR_PRESET_C_STRATEGY_ID;
  const isMcMetric = metricType === 'mc';
  const marketPrice = Number(e.marketPrice ?? 0);
  /** W7.2+ stamped mcap snapshot on each ledger row — takes precedence. */
  const mcFromJournal = (): number | null => {
    const j = Number(e.mcUsdLive ?? 0);
    return Number.isFinite(j) && j > 0 ? j : null;
  };

  const liveMc = (): number | null => mcFromJournal() ?? (isMcMetric && marketPrice > 0 ? marketPrice : null);
  const spotPxFromMetric = (): number | null =>
    mcFromJournal() != null ? null : !isMcMetric && marketPrice > 0 ? marketPrice : null;

  if (kind === 'open') {
    const openMc =
      entryRealMcUsd && entryRealMcUsd > 0
        ? entryRealMcUsd
        : mcFromJournal() ??
          (isMcMetric && Number(e.entryMcUsd ?? 0) > 0 ? Number(e.entryMcUsd) : null);
    const legs = Array.isArray(e.legs) ? (e.legs as Record<string, unknown>[]) : [];
    const legMp = legs[0] ? Number(legs[0].marketPrice ?? 0) : 0;
    const entryMp = Number(e.entryMarketPrice ?? 0);
    const spotPx = entryMp > 0 ? entryMp : legMp > 0 ? legMp : null;
    let amountOpen = Number(e.totalInvestedUsd ?? e.total_invested_usd ?? 0);
    if (!(amountOpen > 0) && legs.length) {
      amountOpen = legs.reduce((s, l) => s + Number(l.sizeUsd ?? l.size_usd ?? 0), 0);
    }
    const ruOpen =
      typeof e.timelineOpenLabelRu === 'string' && e.timelineOpenLabelRu.trim().length
        ? String(e.timelineOpenLabelRu).trim()
        : null;
    const openLabel = `${ruOpen ?? 'Open'}${liveExitModeLabelSuffix(e)}`;
    const ctxOpen = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'open',
      label: openLabel,
      mcUsd: openMc,
      spotPxUsd: spotPx != null && spotPx > 0 ? spotPx : null,
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: null,
      remainingFraction: 1,
      amountUsd: amountOpen > 0 ? amountOpen : null,
      ...(ctxOpen ? { contextNote: ctxOpen } : {}),
    };
  }
  if (kind === 'scale_in_add') {
    const fracFull = Number(e.secondLegFractionOfFull ?? 0);
    const pct =
      fracFull > 0 && fracFull <= 1 ? Math.round(fracFull * 100) : Number(e.scaleInPctRounded ?? NaN);
    const ru =
      typeof e.timelineLabelRu === 'string' && e.timelineLabelRu.trim().length
        ? String(e.timelineLabelRu).trim()
        : Number.isFinite(pct) && pct > 0
          ? `Докупка ${pct}% позиции`
          : 'Докупка второй ноги входа';
    const sizeUsd = Number(e.sizeUsd ?? e.size_usd ?? 0);
    const ctxScale = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'scale_in_add',
      label: ru,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: 'scale_in',
      remainingFraction: null,
      amountUsd: sizeUsd > 0 ? sizeUsd : null,
      ...(ctxScale ? { contextNote: ctxScale } : {}),
    };
  }
  if (kind === 'entry_split_add' || kind === 'staged_avg_add') {
    const sizeUsd = Number(e.sizeUsd ?? e.size_usd ?? 0);
    const ru =
      typeof e.timelineLabelRu === 'string' && e.timelineLabelRu.trim().length
        ? String(e.timelineLabelRu).trim()
        : kind === 'entry_split_add'
          ? 'Покупка · 2-я нога сплита входа'
          : 'Усреднение staged';
    const ctx = timelineContextNoteFromJournal(e);
    const timelineKind = kind === 'entry_split_add' ? 'scale_in_add' : 'dca_add';
    return {
      ts,
      kind: timelineKind,
      label: ru,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: kind === 'entry_split_add' ? 'entry_split' : 'staged_avg',
      remainingFraction: null,
      amountUsd: sizeUsd > 0 ? sizeUsd : null,
      ...(ctx ? { contextNote: ctx } : {}),
    };
  }
  if (kind === 'dca_add') {
    const triggerPct = Number(e.triggerPct ?? 0) * 100; // -7%, -15%, ...
    const sizeUsd = Number(e.sizeUsd ?? e.size_usd ?? 0);
    const addUsd =
      sizeUsd > 0 ? sizeUsd : Number(e.addUsd ?? e.add_usd ?? e.dcaUsd ?? e.dca_usd ?? 0);
    const sz = addUsd > 0 ? addUsd : sizeUsd;
    const dcaStep = Number(e.dcaStepIndex ?? NaN);
    const dcaTot = Number(e.dcaLevelsTotal ?? NaN);
    let stepPart = '';
    if (Number.isFinite(dcaStep) && dcaStep >= 0) {
      stepPart =
        Number.isFinite(dcaTot) && dcaTot > 0
          ? ` · шаг ${Math.floor(dcaStep) + 1}/${Math.floor(dcaTot)}`
          : ` · шаг ${Math.floor(dcaStep) + 1}`;
    }
    const ruDca =
      typeof e.timelineLabelRu === 'string' && e.timelineLabelRu.trim().length
        ? String(e.timelineLabelRu).trim()
        : null;
    const label = ruDca ?? `DCA${stepPart} · уровень ${fmtSignedPct(triggerPct)} (от первой ноги)`;
    const ctxDca = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'dca_add',
      label,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: 'dca',
      remainingFraction: null,
      amountUsd: sz > 0 ? sz : null,
      ...(ctxDca ? { contextNote: ctxDca } : {}),
    };
  }
  if (kind === 'partial_sell') {
    const sellFraction = Number(e.sellFraction ?? 0);
    const ladderPnlPct = Number(e.ladderPnlPct ?? 0) * 100;
    const reason = String(e.reason || 'partial_sell');
    const sellPct = Math.round(sellFraction * 100);
    const isTpGrid = e.tpGrid === true || e.tpGrid === 'true';
    const niceReason =
      reason === 'TP_LADDER'
        ? isLiveOscarRisky && isTpGrid
          ? 'Продажа по TP-сетке Risky'
          : isTpGrid
            ? 'Сетка TP (Oscar)'
            : 'Лестница TP'
        : reason === 'BREAKEVEN_TRIM'
          ? 'Частичный выход у безубытка (после 1-й TP)'
          : reason === 'WAVE_B_BREAKEVEN_INSURANCE'
            ? 'Wave B · страховка у безубытка (после +2.5%/+5%)'
            : reason === 'SCRATCH_FLUSH0'
            ? 'Live Oscar scratch · flush 100% @ avg после TP'
            : reason === 'SCRATCH_GAP_FLUSH'
              ? 'Live Oscar scratch · gap flush @ avg (пропуск 0% в данных)'
              : reason === 'TRAIL_STEP'
            ? 'Wave B · trail от хая'
            : reason.toLowerCase().replace(/_/g, ' ');
    const pnlUsd = Number(e.pnlUsd ?? 0);
    const proceedsUsd = Number(e.proceedsUsd ?? 0);
    const ladderPctPlain =
      Number.isFinite(ladderPnlPct) && ladderPnlPct !== 0
        ? `${ladderPnlPct < 0 ? '−' : ''}${Math.abs(ladderPnlPct).toFixed(0)}%`
        : '';
    const stepIdxRaw = Number(e.ladderStepIndex ?? NaN);
    const rungsTotal = Number(e.ladderRungsTotal ?? NaN);
    const stepLabel = isTpGrid
      ? Number.isFinite(stepIdxRaw) && stepIdxRaw >= 0
        ? `ступень сетки ${Math.floor(stepIdxRaw) + 1} (+${ladderPctPlain} к среднему)`
        : ''
      : reason === 'TP_LADDER' && Number.isFinite(stepIdxRaw) && stepIdxRaw >= 0
        ? Number.isFinite(rungsTotal) && rungsTotal > 0
          ? `шаг ${Math.floor(stepIdxRaw) + 1}/${Math.floor(rungsTotal)}`
          : `шаг ${Math.floor(stepIdxRaw) + 1}`
        : '';
    const journalPartialLabel =
      typeof e.timelineLabelRu === 'string' && e.timelineLabelRu.trim().length
        ? String(e.timelineLabelRu).trim()
        : null;
    const basePartialLabel =
      journalPartialLabel ??
      (reason === 'TRAIL_STEP'
        ? `${niceReason} · ${sellPct}% остатка`
        : isTpGrid && stepLabel
          ? `${niceReason} · ${stepLabel}: ${sellPct}% от остатка`
          : stepLabel && ladderPctPlain
            ? `${niceReason} · ${stepLabel}: ${sellPct}% остатка при +${ladderPctPlain} к среднему (порог ладдера)`
            : ladderPctPlain
              ? `${niceReason} · ${sellPct}% остатка при +${ladderPctPlain} к среднему (порог ладдера)`
              : `${niceReason} · ${sellPct}% остатка`);
    const label = `${basePartialLabel}${liveExitModeLabelSuffix(e)}`;
    const ctxPartial = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'partial_sell',
      label,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: sellFraction,
      pnlPct: ladderPnlPct,
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
      reason,
      remainingFraction: Number(e.remainingFraction ?? null),
      amountUsd: proceedsUsd > 0 && Number.isFinite(proceedsUsd) ? proceedsUsd : null,
      ...(ctxPartial ? { contextNote: ctxPartial } : {}),
    };
  }
  if (kind === 'paper_oscar_v21_arm') {
    const mode = String(e.mode ?? '');
    const label =
      mode === 'A'
        ? 'Paper Oscar V2.1 · включён режим A (+5% к avg)'
        : mode === 'B'
          ? 'Paper Oscar V2.1 · включён режим B (−4% к avg, докуп 20%)'
          : `Paper Oscar V2.1 · режим ${mode}`;
    return {
      ts,
      kind: 'strategy_note',
      label,
      mcUsd: liveMc(),
      spotPxUsd: spotPxFromMetric(),
      sizePct: null,
      pnlPct: null,
      pnlUsd: null,
      reason: 'paper_v21_arm',
      remainingFraction: null,
      amountUsd: null,
    };
  }
  if (kind === 'close') {
    const exitReason = String(e.exitReason || 'CLOSE');
    const vaTag = e.liveVariantAExitTag;
    const vaTagLabel =
      typeof vaTag === 'string' && vaTag.length
        ? variantAExitTagLabel(vaTag as VariantAExitTag)
        : null;
    const riskyCloseReason =
      isLiveOscarRisky && exitReason === 'KILLSTOP'
        ? 'Закрытие Risky · KILLSTOP: цена дошла до signal kill-stop −18% от первоначального сигнала'
        : isLiveOscarRisky && exitReason === 'TRAIL'
          ? 'Закрытие Risky · TRAIL: откат к предыдущей ступени после TP-сетки'
          : isLiveOscarRisky && exitReason === 'TIMEOUT'
            ? 'Закрытие Risky · TIMEOUT: истёк лимит времени позиции'
            : null;
    const presetCCloseLabel = isPresetC
      ? `Preset C · preset_c_scalp_v1 · ${exitReason}`
      : null;
    const closeLabel =
      vaTagLabel ??
      riskyCloseReason ??
      presetCCloseLabel ??
      (exitReason === 'CAPITAL_ROTATE'
        ? `Close · CAPITAL_ROTATE — ротация капитала Phase 5 (ожидаемо, не сбой)${liveExitModeLabelSuffix(e)}`
        : `Close · ${exitReason}${liveExitModeLabelSuffix(e)}`);
    const exitMc = Number(e.exitMcUsd ?? 0);
    const exitMarketPrice = Number(e.exit_market_price ?? 0);
    const closeMcFromMetric =
      isMcMetric && exitMarketPrice > 0
        ? exitMarketPrice
        : isMcMetric && exitMc > 0
          ? exitMc
          : null;
    const closeMc = mcFromJournal() ?? closeMcFromMetric;
    const closeSpot =
      mcFromJournal() != null ? null : !isMcMetric && exitMarketPrice > 0 ? exitMarketPrice : null;
    const pnlPct = Number(e.pnlPct ?? 0);
    const netPnlUsd = Number(e.netPnlUsd ?? 0);
    const tiuClose = Number(e.totalInvestedUsd ?? e.total_invested_usd ?? 0);
    const rfClose = Number(e.remainingFraction ?? 0);
    const closeSoldCost =
      tiuClose > 0 && Number.isFinite(rfClose) && rfClose > 0 ? tiuClose * rfClose : null;
    const ctxClose = timelineContextNoteFromJournal(e);
    return {
      ts,
      kind: 'close',
      label: closeLabel,
      mcUsd: closeMc,
      spotPxUsd: closeSpot,
      sizePct: null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      pnlUsd: Number.isFinite(netPnlUsd) ? netPnlUsd : null,
      reason: exitReason,
      remainingFraction: 0,
      amountUsd: closeSoldCost,
      ...(ctxClose ? { contextNote: ctxClose } : {}),
    };
  }
  return null;
}

function normalizeTimelineLabelForUsdParse(label: string): string {
  return label
    .replace(/\uFF04/g, '$')
    .replace(/\uFF0B/g, '+')
    .replace(/\u2212/g, '-')
    .replace(/\u00A0/g, ' ');
}

/** Back-fill amountUsd from human-readable labels (legacy rows, odd journals). */
function enrichTimelineAmountUsd(ev: TimelineEvent): TimelineEvent {
  const cur = Number(ev.amountUsd ?? NaN);
  if (Number.isFinite(cur) && cur > 0) return ev;
  const lab = normalizeTimelineLabelForUsdParse(ev.label ?? '');
  const patch = (n: number): TimelineEvent => ({ ...ev, amountUsd: n });

  if (ev.kind === 'dca_add') {
    const m =
      lab.match(/\+\s*\$\s*([\d.]+)/) ||
      lab.match(/докупка\s+\$\s*([\d.]+)/i) ||
      lab.match(/\badd\s+\$\s*([\d.]+)/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  if (ev.kind === 'open') {
    const mk = lab.match(/куплено\s+\$\s*([\d.]+)\s*k\b/i);
    if (mk) {
      const v = Number(mk[1]) * 1000;
      if (v > 0) return patch(v);
    }
    const m = lab.match(/куплено\s+\$\s*([\d.]+)\b/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  if (ev.kind === 'partial_sell') {
    const mk = lab.match(/продано\s+\$\s*([\d.]+)\s*k\b/i);
    if (mk) {
      const v = Number(mk[1]) * 1000;
      if (v > 0) return patch(v);
    }
    const m = lab.match(/продано\s+\$\s*([\d.]+)\b/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  if (ev.kind === 'close') {
    const mk = lab.match(/выход\s+\$\s*([\d.]+)\s*k\b/i);
    if (mk) {
      const v = Number(mk[1]) * 1000;
      if (v > 0) return patch(v);
    }
    const m = lab.match(/выход\s+\$\s*([\d.]+)\b/i);
    if (m) {
      const v = Number(m[1]);
      if (v > 0) return patch(v);
    }
  }
  return ev;
}

const OSCAR_EXIT_MODE_LABEL_SUFFIX_A = ' · режим A';
const OSCAR_EXIT_MODE_LABEL_SUFFIX_B = ' · режим B';

function stripOscarExitModeLabelSuffix(label: string): string {
  let s = label;
  for (;;) {
    if (s.endsWith(OSCAR_EXIT_MODE_LABEL_SUFFIX_A)) s = s.slice(0, -OSCAR_EXIT_MODE_LABEL_SUFFIX_A.length);
    else if (s.endsWith(OSCAR_EXIT_MODE_LABEL_SUFFIX_B)) s = s.slice(0, -OSCAR_EXIT_MODE_LABEL_SUFFIX_B.length);
    else return s;
  }
}

type OscarDeferredCtxStage = 'pre_tp' | 'post_tp_pre_dca' | 'post_dca';

/** Скрываем пояснения A/B в таймлайне до фактического «включения» режима (после 1-го TP или 1-го DCA). */
function filterOscarDeferredContextNote(
  note: string | null | undefined,
  stage: OscarDeferredCtxStage,
): string | null | undefined {
  if (note == null || note === '') return note;
  const lines = note.split('\n');
  const tpLine = lines.find((l) => l.startsWith('Класс пути до входа')) ?? null;
  const modeALine = lines.find((l) => l.startsWith('Режим A')) ?? null;
  const modeBLine = lines.find((l) => l.startsWith('Режим B')) ?? null;
  const parts: string[] = [];
  if (tpLine) parts.push(tpLine);
  if (stage === 'post_tp_pre_dca' && modeALine) parts.push(modeALine);
  if (stage === 'post_dca' && modeBLine) parts.push(modeBLine);
  if (!parts.length) return undefined;
  return parts.join('\n');
}

/**
 * Плитки DASHBOARD_PANEL_ORDER: A/B в подписи и contextNote не показываем на open/scale-in до 1-го TP;
 * после 1-го DCA везде B. Только дашборд, журнал не меняется.
 */
function applyOscarDashboardDeferredAbLabels(timeline: TimelineEvent[]): TimelineEvent[] {
  const sorted = timeline.slice().sort((a, b) => a.ts - b.ts);
  let seenTp = false;
  let seenDca = false;
  const out: TimelineEvent[] = [];
  for (const ev of sorted) {
    const isFirstTp = ev.kind === 'partial_sell' && !seenTp;
    const isFirstDca = ev.kind === 'dca_add' && !seenDca;
    const stage: OscarDeferredCtxStage =
      seenDca || isFirstDca ? 'post_dca' : seenTp || isFirstTp ? 'post_tp_pre_dca' : 'pre_tp';
    const labelBase = stripOscarExitModeLabelSuffix(ev.label);
    const ctx = filterOscarDeferredContextNote(ev.contextNote, stage);

    let suffix = '';
    if (ev.kind !== 'open' && ev.kind !== 'strategy_note') {
      if (ev.kind === 'dca_add') suffix = OSCAR_EXIT_MODE_LABEL_SUFFIX_B;
      else if (ev.kind === 'partial_sell')
        suffix = seenDca ? OSCAR_EXIT_MODE_LABEL_SUFFIX_B : OSCAR_EXIT_MODE_LABEL_SUFFIX_A;
      else if (seenDca) suffix = OSCAR_EXIT_MODE_LABEL_SUFFIX_B;
      else if (seenTp) suffix = OSCAR_EXIT_MODE_LABEL_SUFFIX_A;
    }

    if (ev.kind === 'partial_sell') seenTp = true;
    if (ev.kind === 'dca_add') seenDca = true;

    const { contextNote: _omitCtx, ...rest } = ev;
    out.push({
      ...rest,
      label: labelBase + suffix,
      ...(ctx != null && ctx !== '' ? { contextNote: ctx } : {}),
    });
  }
  return out;
}

export function finalizeTimelineForApi(timeline: TimelineEvent[], strategyId?: string): TimelineEvent[] {
  const enriched = timeline.map(enrichTimelineAmountUsd);
  if (strategyId === 'superbot' && superbotJsonlIsLiveOscarFormat(DASHBOARD_SUPERBOT_JSONL)) {
    return enriched.map((ev) => ({
      ...ev,
      contextNote: ev.contextNote ?? presetCTimelineContextNote(ev.kind),
    }));
  }
  if (strategyId === 'superbot') {
    return enriched;
  }
  if (strategyId && (DASHBOARD_PANEL_ORDER as readonly string[]).includes(strategyId)) {
    return applyOscarDashboardDeferredAbLabels(enriched);
  }
  return enriched;
}

export function loadPaper2File(filePath: string): {
  open: Paper2OpenItem[];
  closed: Paper2ClosedRow[];
  firstTs: number;
  lastTs: number;
  resetTs: number;
  evals1h: number;
  passed1h: number;
  failReasons: Array<{ reason: string; count: number }>;
  /** Per-position timeline keyed by mint (open positions). */
  openTimelines: Map<string, TimelineEvent[]>;
} {
  if (!fs.existsSync(filePath)) {
    return {
      open: [],
      closed: [],
      firstTs: Date.now(),
      lastTs: Date.now(),
      resetTs: 0,
      evals1h: 0,
      passed1h: 0,
      failReasons: [],
      openTimelines: new Map(),
    };
  }
  const om = new Map<string, Paper2OpenItem>();
  const cl: Paper2ClosedRow[] = [];
  let f = Date.now();
  let l = 0;
  let resetTs = 0;
  let evals1h = 0;
  let passed1h = 0;
  const failReasonsCount = new Map<string, number>();
  const since1h = Date.now() - 3_600_000;
  // Build per-position timelines. Keyed by mint while the position is open;
  // on close we attach the collected events to the close row and clear the
  // bucket so the next re-open of the same mint starts fresh.
  const liveTimelines = new Map<string, TimelineEvent[]>();
  // Cache of (mint -> { metricType, entryRealMcUsd }) so dca_add / partial_sell /
  // close events know how to interpret marketPrice (mcap vs token price).
  const liveMeta = new Map<string, { metricType: string | null; entryRealMcUsd: number | null }>();
  /** W7.4 — stamp at `open`, joined onto `close` for dashboard rows. */
  const entryPriceVerifyByMint = new Map<
    string,
    {
      entryPriceVerifySlipPct: number | null;
      entryPriceVerifyImpactPct: number | null;
      entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
    }
  >();

  for (const ln of dashboardJsonlLines(filePath)) {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof e.ts === 'number' ? e.ts : 0;
    if (ts) {
      if (ts < f) f = ts;
      if (ts > l) l = ts;
    }
    if (e.kind === 'reset') {
      resetTs = typeof e.ts === 'number' ? e.ts : 0;
      continue;
    }
    if (e.kind === 'eval' && ts >= since1h) {
      evals1h++;
      if (e.pass === true) passed1h++;
      else {
        const reasons = Array.isArray(e.reasons) ? e.reasons : [];
        for (const r of reasons) {
          const key = String(r);
          failReasonsCount.set(key, (failReasonsCount.get(key) || 0) + 1);
        }
      }
    }
    const mint = String(e.mint ?? '');
    if (e.kind === 'open') {
      const feat = e.features as Record<string, unknown> | undefined;
      const featMc =
        feat && ((typeof feat.market_cap_usd === 'number' ? feat.market_cap_usd : 0) ||
          (typeof feat.fdv_usd === 'number' ? feat.fdv_usd : 0));
      const metricType = e.metricType != null ? String(e.metricType) : null;
      const entryRealMcUsd = featMc ? Number(featMc) : null;
      const legsArr = Array.isArray(e.legs) ? (e.legs as Record<string, unknown>[]) : [];
      const legMp = legsArr[0] ? Number(legsArr[0].marketPrice ?? 0) : 0;
      const emp = Number(e.entryMarketPrice ?? 0);
      const baselinePriceUsd =
        emp > 0 ? emp : legMp > 0 ? legMp : null;
      const pfOpen = e.priorityFee as { usd?: number } | undefined;
      const pfOpenUsd = Number(pfOpen?.usd ?? 0);
      const entryPriorityFeeUsd =
        Number.isFinite(pfOpenUsd) && pfOpenUsd > 0 ? pfOpenUsd : null;
      const pvUi = priceVerifyUiFields(e.priceVerify);
      entryPriceVerifyByMint.set(mint, pvUi);
      const entryLiqFromEv =
        typeof e.entryLiqUsd === 'number' && Number(e.entryLiqUsd) > 0 ? Number(e.entryLiqUsd) : null;
      const featLiq =
        feat && typeof feat.liq_usd === 'number' && Number(feat.liq_usd) > 0 ? Number(feat.liq_usd) : null;
      const entryLiqUsd = entryLiqFromEv ?? featLiq;
      const pairFromEv =
        e.pairAddress != null && String(e.pairAddress).trim() ? String(e.pairAddress).trim() : null;
      const featPair =
        feat?.pair_address != null && String(feat.pair_address).trim()
          ? String(feat.pair_address).trim()
          : null;
      const pairAddress = pairFromEv ?? featPair;
      om.set(mint, {
        mint,
        symbol: String(e.symbol ?? ''),
        entryTs: Number(e.entryTs ?? 0),
        entryMcUsd: Number(e.entryMcUsd ?? 0),
        entryRealMcUsd,
        baselinePriceUsd,
        openedAtIso: e.entryTs ? new Date(Number(e.entryTs)).toISOString() : null,
        lane: e.lane != null ? String(e.lane) : null,
        source: e.source != null ? String(e.source) : null,
        metricType,
        features: e.features ?? null,
        btc: e.btc ?? null,
        peakMcUsd: Number(e.entryMcUsd ?? 0),
        peakPnlPct: 0,
        trailingArmed: false,
        // NOTE: never fall back to entryMcUsd here — that's the market cap
        // (millions $), not the position size. 0 means "use POSITION_USD_DEFAULT".
        totalInvestedUsd: Number(e.totalInvestedUsd ?? 0),
        entryPriorityFeeUsd,
        pairAddress,
        entryLiqUsd,
        remainingFraction: 1,
        ...pvUi,
        ...liveOscarOpenLaneFieldsFromRecord(e),
      });
      liveMeta.set(mint, { metricType, entryRealMcUsd });
      const tev = buildTimelineEvent(e, metricType, entryRealMcUsd);
      liveTimelines.set(mint, tev ? [tev] : []);
    } else if (e.kind === 'peak') {
      const o = om.get(mint);
      if (o) {
        o.peakMcUsd = Math.max(o.peakMcUsd, Number(e.peakMcUsd ?? 0));
        o.peakPnlPct = Math.max(o.peakPnlPct, Number(e.peakPnlPct ?? 0));
        o.trailingArmed = o.trailingArmed || Boolean(e.trailingArmed);
      }
    } else if (e.kind === 'dca_add' || e.kind === 'entry_split_add' || e.kind === 'staged_avg_add') {
      const o = om.get(mint);
      if (o) {
        const tiu = Number(e.totalInvestedUsd ?? 0);
        if (tiu > 0) o.totalInvestedUsd = tiu;
        o.remainingFraction = 1;
      }
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
    } else if (e.kind === 'scale_in_add') {
      const o = om.get(mint);
      if (o) {
        const tiu = Number(e.totalInvestedUsd ?? 0);
        if (tiu > 0) o.totalInvestedUsd = tiu;
        o.remainingFraction = 1;
      }
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
    } else if (e.kind === 'paper_oscar_v21_arm') {
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
    } else if (e.kind === 'partial_sell') {
      const o = om.get(mint);
      if (o) {
        const rf = Number(e.remainingFraction ?? NaN);
        if (Number.isFinite(rf) && rf >= 0 && rf <= 1) o.remainingFraction = rf;
      }
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
    } else if (e.kind === 'close') {
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const tev = buildTimelineEvent(e, meta.metricType, meta.entryRealMcUsd);
      const arr = liveTimelines.get(mint) ?? [];
      if (tev) arr.push(tev);
      const pvEntry = entryPriceVerifyByMint.get(mint) ?? {
        entryPriceVerifySlipPct: null,
        entryPriceVerifyImpactPct: null,
        entryPriceVerifySource: null,
      };
      entryPriceVerifyByMint.delete(mint);
      const closedRow: Paper2ClosedRow = { ...e, ...pvEntry, __timeline: arr };
      cl.push(closedRow);
      om.delete(mint);
      liveMeta.delete(mint);
      liveTimelines.delete(mint);
    }
  }
  const failReasons = [...failReasonsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
  /** Последняя строка `reset` в журнале — дашборд считает только закрытия с exitTs ≥ reset.ts (jsonl не режем). */
  const closedVisible =
    resetTs > 0 ? cl.filter((c) => Number((c as { exitTs?: unknown }).exitTs ?? 0) >= resetTs) : cl;
  return {
    open: [...om.values()],
    closed: closedVisible,
    firstTs: f,
    lastTs: l,
    resetTs,
    evals1h,
    passed1h,
    failReasons,
    openTimelines: liveTimelines,
  };
}

export type Paper2FileLoad = ReturnType<typeof loadPaper2File>;

type LiveOscarPaper2Extras = {
  liveReconcileBoot?: DashboardPaper2StrategyRow['liveReconcileBoot'];
  liveReconcileReport?: DashboardPaper2StrategyRow['liveReconcileReport'];
};

export type LiveOscarPaper2Load = Paper2FileLoad & {
  hbOpen: number;
  hbClosed: number;
  liveExtras?: LiveOscarPaper2Extras;
  entryQuoteByMint?: Map<
    string,
    {
      entryPriceVerifySlipPct: number | null;
      entryPriceVerifyImpactPct: number | null;
      entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
    }
  >;
};

function entryRealMcFromLiveOpenTrade(ot: Record<string, unknown>): number | null {
  const stamped = Number(ot.entryMarketCapUsd ?? 0);
  if (Number.isFinite(stamped) && stamped > 0) return stamped;
  const em = ot.entryMetrics as Record<string, unknown> | undefined;
  if (!em || typeof em !== 'object') return null;
  const mc = Number(em.market_cap_usd ?? em.fdv_usd ?? 0);
  return Number.isFinite(mc) && mc > 0 ? mc : null;
}

function liveOscarOpenLaneFieldsFromRecord(
  ot: Record<string, unknown>,
): Pick<Paper2OpenItem, 'liveOscarTradeLane' | 'isScalpWave' | 'isRunnerProbe' | 'positionSource'> {
  const laneRaw = ot.liveOscarTradeLane;
  const liveOscarTradeLane =
    laneRaw === 'scalp_wave' || laneRaw === 'prod' || laneRaw === 'runner_probe' ? laneRaw : null;
  const runnerPick = ot as Parameters<typeof isRunnerProbeTrade>[0];
  const positionSourceRaw = ot.positionSource;
  const positionSource =
    positionSourceRaw === 'copy_leader' || positionSourceRaw === 'runner_probe'
      ? positionSourceRaw
      : isRunnerProbeTrade(runnerPick)
        ? 'runner_probe'
        : null;
  return {
    liveOscarTradeLane,
    isScalpWave: isLiveOscarScalpWaveTrade(
      ot as Parameters<typeof isLiveOscarScalpWaveTrade>[0],
    ),
    isRunnerProbe: isRunnerProbeTrade(runnerPick),
    positionSource,
  };
}

export function paper2OpenItemFromLiveOpenTrade(
  mint: string,
  ot: Record<string, unknown>,
  entryQuoteVerify?: {
    entryPriceVerifySlipPct: number | null;
    entryPriceVerifyImpactPct: number | null;
    entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
  },
): Paper2OpenItem {
  const metricType = ot.metricType != null ? String(ot.metricType) : null;
  const entryRealMcUsd = entryRealMcFromLiveOpenTrade(ot);
  const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
  const legMp = legsArr[0] ? Number(legsArr[0].marketPrice ?? 0) : 0;
  const emp = Number(ot.avgEntryMarket ?? 0);
  const baselinePriceUsd = emp > 0 ? emp : legMp > 0 ? legMp : null;

  return {
    mint,
    symbol: String(ot.symbol ?? ''),
    entryTs: Number(ot.entryTs ?? 0),
    entryMcUsd: Number(ot.entryMcUsd ?? 0),
    entryRealMcUsd,
    baselinePriceUsd,
    openedAtIso: ot.entryTs ? new Date(Number(ot.entryTs)).toISOString() : null,
    lane: ot.lane != null ? String(ot.lane) : null,
    source: ot.source != null ? String(ot.source) : null,
    metricType,
    features: null,
    btc: null,
    peakMcUsd: Number(ot.peakMcUsd ?? 0),
    peakPnlPct: Number(ot.peakPnlPct ?? 0),
    trailingArmed: Boolean(ot.trailingArmed),
    totalInvestedUsd: Number(ot.totalInvestedUsd ?? 0),
    entryPriorityFeeUsd: null,
    entryPriceVerifySlipPct: entryQuoteVerify?.entryPriceVerifySlipPct ?? null,
    entryPriceVerifyImpactPct: entryQuoteVerify?.entryPriceVerifyImpactPct ?? null,
    entryPriceVerifySource: entryQuoteVerify?.entryPriceVerifySource ?? null,
    pairAddress: ot.pairAddress != null ? String(ot.pairAddress).trim() || null : null,
    entryLiqUsd: typeof ot.entryLiqUsd === 'number' && ot.entryLiqUsd > 0 ? ot.entryLiqUsd : null,
    remainingFraction: Number(ot.remainingFraction ?? 1),
    ...liveOscarOpenLaneFieldsFromRecord(ot),
  };
}

/**
 * Build per-mint timeline from openTrade snapshot when JSONL tail missed `live_position_open`.
 */
export function synthesizeTimelineFromLiveOpenTrade(
  mint: string,
  ot: Record<string, unknown>,
  strategyId: string,
): TimelineEvent[] {
  const metricType = ot.metricType != null ? String(ot.metricType) : null;
  const entryRealMcUsd = entryRealMcFromLiveOpenTrade(ot);
  const isPresetCFile = strategyId === LIVE_OSCAR_PRESET_C_STRATEGY_ID;
  const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
  const partials = Array.isArray(ot.partialSells) ? (ot.partialSells as Record<string, unknown>[]) : [];
  const out: TimelineEvent[] = [];

  if (legsArr.length > 0) {
    const openLabelRu = isPresetCFile
      ? presetCOpenTimelineLabelRu(ot)
      : typeof ot.timelineOpenLabelRu === 'string' && ot.timelineOpenLabelRu.trim()
        ? ot.timelineOpenLabelRu.trim()
        : undefined;
    const openSyn: Record<string, unknown> = {
      kind: 'open',
      ts: Number(legsArr[0]?.ts ?? ot.entryTs ?? 0),
      strategyId,
      mint,
      symbol: ot.symbol,
      lane: ot.lane,
      source: ot.source,
      dex: ot.dex,
      entryTs: ot.entryTs,
      entryMcUsd: ot.entryMcUsd,
      entryMarketPrice: legsArr[0]?.marketPrice ?? ot.avgEntryMarket,
      legs: ot.legs,
      totalInvestedUsd: legsArr[0]?.sizeUsd ?? ot.totalInvestedUsd,
      metricType,
      ...(openLabelRu ? { timelineOpenLabelRu: openLabelRu } : {}),
    };
    const openEv = buildTimelineEvent(openSyn, metricType, entryRealMcUsd);
    if (openEv) out.push(openEv);

    for (let i = 1; i < legsArr.length; i++) {
      const leg = legsArr[i]!;
      const legReason = String(leg.reason ?? '');
      const legUsd = Number(leg.sizeUsd ?? 0);
      const synKind =
        legReason === 'entry_split'
          ? 'entry_split_add'
          : legReason === 'staged_avg'
            ? 'staged_avg_add'
            : 'dca_add';
      const labelRu = isPresetCFile
        ? presetCStagedLegTimelineLabelRu(legUsd, ot.liveOscarMcapTier)
        : legReason === 'entry_split'
          ? 'Покупка · 2-я нога сплита входа'
          : legReason === 'staged_avg'
            ? 'Усреднение staged'
            : 'DCA докупка';
      const syn: Record<string, unknown> = {
        kind: synKind,
        ts: Number(leg.ts ?? ot.entryTs ?? 0),
        strategyId,
        mint,
        marketPrice: Number(leg.marketPrice ?? leg.price ?? 0),
        sizeUsd: legUsd,
        triggerPct: Number(leg.triggerPct ?? 0),
        timelineLabelRu: labelRu,
        totalInvestedUsd: ot.totalInvestedUsd,
      };
      const tev = buildTimelineEvent(syn, metricType, entryRealMcUsd);
      if (tev) out.push(tev);
    }
  }

  for (const ps of partials) {
    const syn: Record<string, unknown> = {
      kind: 'partial_sell',
      ts: Number(ps.ts ?? ot.entryTs ?? 0),
      strategyId,
      mint,
      marketPrice: Number(ps.marketPrice ?? ps.price ?? 0),
      sellFraction: Number(ps.sellFraction ?? 0),
      reason: ps.reason ?? 'partial_sell',
      proceedsUsd: Number(ps.proceedsUsd ?? 0),
      pnlUsd: Number(ps.pnlUsd ?? 0),
      remainingFraction: ot.remainingFraction,
      timelineLabelRu: ps.timelineLabelRu,
    };
    const tev = buildTimelineEvent(syn, metricType, entryRealMcUsd);
    if (tev) out.push(tev);
  }

  return out;
}

/**
 * Prefer sidecar open snapshot when present and fresh; tail JSONL replay may miss opens outside the byte window.
 */
export function mergeLiveOscarOpenSnapshotIntoLoad(
  load: LiveOscarPaper2Load,
  snapshotPath = DASHBOARD_LIVE_OSCAR_OPEN_SNAPSHOT,
  maxAgeMs = DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS,
  dashboardStrategyId = 'live-oscar',
): LiveOscarPaper2Load {
  const snap = readLiveOpenSnapshot(snapshotPath);
  if (!snap || !isLiveOpenSnapshotFresh(snap, maxAgeMs)) return load;

  const entryQuoteByMint = load.entryQuoteByMint ?? new Map();
  const open = snap.positions.map((p) =>
    paper2OpenItemFromLiveOpenTrade(p.mint, p.openTrade, entryQuoteByMint.get(p.mint)),
  );
  const openTimelines = new Map(load.openTimelines);
  for (const row of snap.positions) {
    const existing = openTimelines.get(row.mint) ?? [];
    if (!existing.length) {
      const synth = synthesizeTimelineFromLiveOpenTrade(row.mint, row.openTrade, dashboardStrategyId);
      if (synth.length) openTimelines.set(row.mint, synth);
      else if (!openTimelines.has(row.mint)) openTimelines.set(row.mint, []);
    }
  }
  return { ...load, open, openTimelines, entryQuoteByMint };
}

/** Skip multi-GB journal replay when sidecar snapshot is fresh (`GET /api/paper2/opens`). */
export function loadLiveOscarOpensOnlyFromSnapshot(
  jsonlPath = DASHBOARD_LIVE_OSCAR_JSONL,
): LiveOscarPaper2Load | null {
  const snapshotPath = resolveLiveOscarOpenSnapshotPath(jsonlPath);
  const snap = readLiveOpenSnapshot(snapshotPath);
  if (!snap || !isLiveOpenSnapshotFresh(snap, DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS)) {
    return null;
  }
  const dashboardStrategyId = resolveLiveOscarDashboardStrategyId(jsonlPath);
  return mergeLiveOscarOpenSnapshotIntoLoad(
    emptyLiveOscarPaper2Load(),
    snapshotPath,
    DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS,
    dashboardStrategyId,
  );
}

/**
 * Live `PERIODIC_HEAL` раньше получал в трекер «цену выхода» = USD **market cap** (`getLiveMcUsd`),
 * из‑за чего в JSONL остались космические pnlPct/netPnlUsd. Журнал не переписываем — чиним только
 * отдачу в дашборд: оценка по сумме partial TP + остаток × последняя известная market price partial.
 */
function sanitizeCorruptLivePeriodicHealClosedTrade(ct: Record<string, unknown>): Record<string, unknown> {
  if (String(ct.exitReason ?? '') !== 'PERIODIC_HEAL') return ct;
  let avgEntry = Number(ct.avgEntry ?? 0);
  if (!(avgEntry > 0 && Number.isFinite(avgEntry))) {
    avgEntry = Number(ct.avgEntryMarket ?? 0);
  }
  let invested = Number(ct.totalInvestedUsd ?? 0);
  if (!(invested > 0)) {
    const legs = Array.isArray(ct.legs) ? (ct.legs as Record<string, unknown>[]) : [];
    invested = legs.reduce((s, x) => s + Number(x.sizeUsd ?? x.size_usd ?? 0), 0);
  }
  /** Pump-мемы: цена токена USD; верхняя планка защищает от случайного mc в поле avg. */
  if (!(avgEntry > 0 && avgEntry < 500 && invested > 0)) return ct;

  const theoPx = Number(ct.theoretical_exit_price ?? 0);
  const effPx = Number(ct.effective_exit_price ?? 0);
  const exitMcRaw = Number(ct.exitMcUsd ?? 0);
  const pnlPct = Number(ct.pnlPct ?? 0);
  const net = Number(ct.netPnlUsd ?? 0);

  /** В багованном heal «theoretical» = market cap; «effective» иногда уже поправлен с цепи. */
  const absurdSpotPx = (px: number): boolean =>
    avgEntry > 0 &&
    px > 0 &&
    Number.isFinite(px) &&
    (px / avgEntry > 200 || (px > 25_000 && avgEntry < 50));

  const corrupt =
    absurdSpotPx(theoPx) ||
    absurdSpotPx(effPx) ||
    absurdSpotPx(exitMcRaw) ||
    Math.abs(pnlPct) > 400 ||
    Math.abs(net) > Math.max(5000, invested * 80);

  if (!corrupt) return ct;

  const partials = Array.isArray(ct.partialSells)
    ? (ct.partialSells as Record<string, unknown>[])
    : [];
  const sumPartial = partials.reduce((s, p) => s + Number(p.proceedsUsd ?? 0), 0);
  const exitCtx = ct.exitContext as Record<string, unknown> | undefined;
  const remRaw =
    exitCtx && exitCtx.remainingFractionAtClose != null
      ? Number(exitCtx.remainingFractionAtClose)
      : NaN;
  const lastPs = partials.length ? partials[partials.length - 1]! : null;
  const lastPx = lastPs ? Number(lastPs.marketPrice ?? lastPs.price ?? 0) : 0;
  const rem = Number.isFinite(remRaw) && remRaw > 0 && remRaw <= 1 ? remRaw : NaN;

  if (!(sumPartial >= 0 && Number.isFinite(rem) && lastPx > 0)) {
    const out = { ...ct };
    out.pnlPct = 0;
    out.netPnlUsd = 0;
    out.grossPnlUsd = 0;
    out.grossPnlPct = 0;
    out.theoretical_exit_price = avgEntry;
    out.effective_exit_price = avgEntry;
    out.exitMcUsd = avgEntry;
    out.__pnlDisplayRepair = 'periodic_heal_corrupt_no_partial_basis';
    return out;
  }

  const remainderGrossUsd = invested * rem * (lastPx / avgEntry);
  const totalRecv = sumPartial + remainderGrossUsd;
  const netRepair = totalRecv - invested;
  const pnlPctRepair = (netRepair / invested) * 100;

  const out = { ...ct };
  out.netPnlUsd = netRepair;
  out.pnlPct = pnlPctRepair;
  out.grossPnlUsd = netRepair;
  out.grossPnlPct = pnlPctRepair;
  out.theoretical_exit_price = lastPx;
  out.effective_exit_price = lastPx;
  out.exitMcUsd = lastPx;
  out.totalProceedsUsd = totalRecv;
  out.grossTotalProceedsUsd = totalRecv;
  if (out.exitContext && typeof out.exitContext === 'object') {
    out.exitContext = {
      ...(out.exitContext as Record<string, unknown>),
      closePnlPct: +pnlPctRepair.toFixed(2),
    };
  }
  out.__pnlDisplayRepair = 'periodic_heal_estimated_from_partials';
  return out;
}

function journalRemainderFractionBeforePartialDashboard(
  partials: Record<string, unknown>[],
  lastIdx: number,
): number {
  let rem = 1;
  for (let i = 0; i < lastIdx; i++) {
    rem *= 1 - Number(partials[i]?.sellFraction ?? 0);
  }
  return rem;
}

/**
 * Wallet-drain partial unwind (NEST 2026-06-26): journal remainder >> chain proceeds on last
 * trail dump after usd_capped_by_chain drift. Repair close PnL using MTM at last partial market px.
 */
export function sanitizeWalletDrainPartialCloseForDashboard(ct: Record<string, unknown>): Record<string, unknown> {
  const partials = Array.isArray(ct.partialSells)
    ? (ct.partialSells as Record<string, unknown>[])
    : [];
  if (partials.length < 2) return ct;
  const invested = Number(ct.totalInvestedUsd ?? 0);
  let avgEntry = Number(ct.avgEntry ?? 0);
  if (!(avgEntry > 0)) avgEntry = Number(ct.effective_entry_price ?? 0);
  if (!(invested > 0 && avgEntry > 0 && avgEntry < 500)) return ct;

  const exitCtx = ct.exitContext as Record<string, unknown> | undefined;
  const remAtClose =
    exitCtx && exitCtx.remainingFractionAtClose != null
      ? Number(exitCtx.remainingFractionAtClose)
      : Number(ct.remainingFraction ?? 0);
  if (remAtClose > 1e-6) return ct;

  const lastIdx = partials.length - 1;
  const last = partials[lastIdx]!;
  const chainProceeds = Number(last.proceedsUsd ?? 0);
  const slip = Number(last.slipRealizedPct ?? 0);
  const remBefore =
    Number(last.remainingFractionBeforePartial ?? NaN) ||
    journalRemainderFractionBeforePartialDashboard(partials, lastIdx);
  const lastPx = Number(last.marketPrice ?? last.price ?? 0);
  if (!(remBefore > 1e-6 && lastPx > 0 && chainProceeds > 0)) return ct;

  const mtmFlush =
    Number(last.mtmFlushProceedsUsd ?? NaN) ||
    invested * remBefore * (lastPx / avgEntry);
  const sumPrior = partials
    .slice(0, lastIdx)
    .reduce((s, p) => s + Number(p.proceedsUsd ?? 0), 0);
  const chainTotal = sumPrior + chainProceeds;
  /** MTM repair only when last leg had severe slip (Jun NEST trail); low-slip flush uses chain net below. */
  const useMtm =
    slip >= 15 &&
    (last.walletDrainedFlush === true ||
      (Number.isFinite(Number(last.mtmFlushProceedsUsd)) && Number(last.mtmFlushProceedsUsd) > chainProceeds * 1.12) ||
      mtmFlush > chainProceeds * 1.12);
  if (!useMtm) {
    if (
      last.walletDrainedFlush === true &&
      slip < 15 &&
      chainTotal > 0 &&
      chainTotal < invested - 0.5
    ) {
      const netChain = chainTotal - invested;
      const pnlPctChain = (netChain / invested) * 100;
      const out: Record<string, unknown> = { ...ct };
      out.netPnlUsd = netChain;
      out.pnlPct = pnlPctChain;
      out.grossPnlUsd = netChain;
      out.grossPnlPct = pnlPctChain;
      out.totalProceedsUsd = chainTotal;
      out.grossTotalProceedsUsd = chainTotal;
      if (exitCtx && typeof exitCtx === 'object') {
        out.exitContext = { ...exitCtx, closePnlPct: +pnlPctChain.toFixed(2) };
      }
      out.__pnlDisplayRepair = 'wallet_drain_chain_net_loss';
      return out;
    }
    return ct;
  }

  const totalRecv = sumPrior + mtmFlush;
  if (!(totalRecv > chainTotal + 0.5)) return ct;

  const netRepair = totalRecv - invested;
  const pnlPctRepair = (netRepair / invested) * 100;
  const out: Record<string, unknown> = { ...ct };
  out.netPnlUsd = netRepair;
  out.pnlPct = pnlPctRepair;
  out.grossPnlUsd = netRepair;
  out.grossPnlPct = pnlPctRepair;
  out.totalProceedsUsd = totalRecv;
  out.grossTotalProceedsUsd = totalRecv;
  out.theoretical_exit_price = lastPx;
  out.effective_exit_price = lastPx;
  out.exitMcUsd = lastPx;
  if (exitCtx && typeof exitCtx === 'object') {
    out.exitContext = { ...exitCtx, closePnlPct: +pnlPctRepair.toFixed(2) };
  }
  out.__pnlDisplayRepair = 'wallet_drain_partial_mtm_flush';
  return out;
}

/** RECONCILE_ORPHAN books remainder at cost (net 0); dashboard shows fees / last observed px. */
function sanitizeReconcileOrphanClosedTradeForDashboard(ct: Record<string, unknown>): Record<string, unknown> {
  if (String(ct.exitReason ?? '') !== 'RECONCILE_ORPHAN') return ct;
  const invested = Number(ct.totalInvestedUsd ?? 0);
  const net = Number(ct.netPnlUsd ?? 0);
  const gross = Number(ct.grossPnlUsd ?? 0);
  const grossPct = Number(ct.grossPnlPct ?? 0);
  const entryPx = closedRowEntryPx(ct as Paper2ClosedRow);
  const exitPx = closedRowExitPx(ct as Paper2ClosedRow);
  const out: Record<string, unknown> = { ...ct };
  if (entryPx > 0) {
    out.entryPriceUsd = entryPx;
    out.baselinePriceUsd = entryPx;
  }
  if (exitPx > 0) {
    out.exitPriceUsd = exitPx;
  }
  if (net === 0 && Number.isFinite(gross) && gross !== 0) {
    out.netPnlUsd = gross;
    out.pnlUsd = gross;
    if (invested > 0) {
      const pct = (gross / invested) * 100;
      out.pnlPct = pct;
      if (!Number.isFinite(grossPct) || grossPct === 0) out.grossPnlPct = pct;
    } else if (Number.isFinite(grossPct) && grossPct !== 0) {
      out.pnlPct = grossPct;
    }
  }
  return out;
}

type WalletDrainedZombieTrack = {
  hadSellAttempt: boolean;
  walletDrainedAt: number;
  lastSellTargetPx: number | null;
};

function bumpWalletDrainedZombieTrack(
  map: Map<string, WalletDrainedZombieTrack>,
  mint: string,
): WalletDrainedZombieTrack {
  let row = map.get(mint);
  if (!row) {
    row = { hadSellAttempt: false, walletDrainedAt: 0, lastSellTargetPx: null };
    map.set(mint, row);
  }
  return row;
}

/** Journal open + sell attempts + wallet_spl_balance_zero skip but no `live_position_close`. */
export function applyWalletDrainedZombieInference(
  load: LiveOscarPaper2Load,
  zombieTracks: Map<string, WalletDrainedZombieTrack>,
  openTimelines: Map<string, TimelineEvent[]>,
  liveMeta: Map<string, { metricType: string | null; entryRealMcUsd: number | null }>,
  dashboardStrategyId: string,
): LiveOscarPaper2Load {
  const closed = [...load.closed];
  const closedMints = new Set(closed.map((c) => String(c.mint ?? '')));
  const openMints = new Set(load.open.map((o) => o.mint));

  for (const [mint, z] of zombieTracks) {
    if (!z.hadSellAttempt || z.walletDrainedAt <= 0) continue;
    if (closedMints.has(mint) || !openMints.has(mint)) continue;

    const openItem = load.open.find((o) => o.mint === mint);
    if (!openItem) continue;

    const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
    const entryTs = Number(openItem.entryTs ?? 0);
    const exitTs = z.walletDrainedAt;
    const invested = Number(openItem.totalInvestedUsd ?? 0);
    const avgEntry = Number(openItem.avgEntry ?? openItem.entryPx ?? 0);
    const observedPx = Number(openItem.lastObservedPriceUsd ?? 0);
    const baselinePx = Number(openItem.baselinePriceUsd ?? 0);
    const exitPx =
      z.lastSellTargetPx ??
      (observedPx > 0 ? observedPx : baselinePx > 0 ? baselinePx : avgEntry);
    const netPnlUsd =
      invested > 0 && avgEntry > 0 && exitPx > 0 ? invested * (exitPx / avgEntry - 1) : 0;
    const pnlPct = invested > 0 ? (netPnlUsd / invested) * 100 : 0;
    const durationMin = entryTs > 0 && exitTs > entryTs ? (exitTs - entryTs) / 60_000 : 0;

    const timeline = openTimelines.get(mint) ?? [];
    const synClose: Record<string, unknown> = {
      kind: 'close',
      ts: exitTs,
      strategyId: dashboardStrategyId,
      mint,
      exitTs,
      exitMcUsd: exitPx,
      exit_market_price: exitPx,
      pnlPct,
      netPnlUsd,
      exitReason: 'KILLSTOP',
      remainingFraction: 0,
      totalInvestedUsd: invested,
      __dashboardInference: 'wallet_drained_zombie',
    };
    const tev = buildTimelineEvent(synClose, meta.metricType, meta.entryRealMcUsd);
    const arr = [...timeline];
    if (tev) arr.push(tev);

    closed.push(
      sanitizeReconcileOrphanClosedTradeForDashboard({
        mint,
        symbol: openItem.symbol ?? '',
        entryTs,
        exitTs,
        exitReason: 'KILLSTOP',
        pnlPct,
        netPnlUsd,
        pnlUsd: netPnlUsd,
        durationMin,
        totalInvestedUsd: invested,
        avgEntry,
        avgEntryMarket: openItem.avgEntryMarket ?? avgEntry,
        effective_entry_price: avgEntry,
        theoretical_entry_price: openItem.baselinePriceUsd ?? avgEntry,
        effective_exit_price: exitPx,
        theoretical_exit_price: exitPx,
        exitMcUsd: exitPx,
        exitPriceUsd: exitPx,
        lastObservedPriceUsd: exitPx,
        __dashboardInference: 'wallet_drained_zombie',
        __timeline: arr,
      }),
    );
    openMints.delete(mint);
    closedMints.add(mint);
  }

  return {
    ...load,
    open: load.open.filter((o) => openMints.has(o.mint)),
    closed,
  };
}

function emptyLiveOscarPaper2Load(): LiveOscarPaper2Load {
  const z = Date.now();
  return {
    open: [],
    closed: [],
    firstTs: z,
    lastTs: z,
    resetTs: 0,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    openTimelines: new Map(),
    hbOpen: 0,
    hbClosed: 0,
  };
}

/**
 * Parse `live-oscar` JSONL (`channel: live`) into the same shapes as `loadPaper2File`,
 * including per-mint timelines with optional `txSignature` (from `execution_result` correlation).
 */
export function loadLiveOscarJsonlAsPaper2(filePath: string): LiveOscarPaper2Load {
  if (!fs.existsSync(filePath)) return emptyLiveOscarPaper2Load();

  const dashboardStrategyId = resolveLiveOscarDashboardStrategyId(filePath);
  const isLiveOscarRiskyFile = dashboardStrategyId === 'live-oscar-risky';
  const isPresetCFile = dashboardStrategyId === LIVE_OSCAR_PRESET_C_STRATEGY_ID;

  const om = new Map<string, Paper2OpenItem>();
  const cl: Paper2ClosedRow[] = [];
  let f = Date.now();
  let l = 0;
  let resetTs = 0;
  const failReasonsCount = new Map<string, number>();
  const since1h = Date.now() - 3_600_000;
  let evals1h = 0;
  let passed1h = 0;
  let hbOpen = 0;
  let hbClosed = 0;
  let liveReconcileBoot: LiveOscarPaper2Extras['liveReconcileBoot'];
  let liveReconcileReport: LiveOscarPaper2Extras['liveReconcileReport'];

  const liveTimelines = new Map<string, TimelineEvent[]>();
  const liveMeta = new Map<string, { metricType: string | null; entryRealMcUsd: number | null }>();

  const intentToMint = new Map<string, string>();
  const sigQueues = new Map<string, string[]>();
  const zombieTracks = new Map<string, WalletDrainedZombieTrack>();
  const entryQuoteByMint = new Map<
    string,
    {
      entryPriceVerifySlipPct: number | null;
      entryPriceVerifyImpactPct: number | null;
      entryPriceVerifySource: 'jupiter' | 'dex' | 'skipped' | 'blocked' | null;
    }
  >();

  const enqueueSig = (mint: string, sig: string) => {
    const q = sigQueues.get(mint) ?? [];
    q.push(sig);
    sigQueues.set(mint, q);
  };
  const dequeueSig = (mint: string): string | undefined => {
    const q = sigQueues.get(mint);
    if (!q?.length) return undefined;
    const s = q.shift()!;
    if (!q.length) sigQueues.delete(mint);
    else sigQueues.set(mint, q);
    return s;
  };

  const attachSig = (mint: string, ev: TimelineEvent | null): TimelineEvent | null => {
    if (!ev) return null;
    const sig = dequeueSig(mint);
    if (!sig) return ev;
    return { ...ev, txSignature: sig };
  };

  try {
    for (const line of liveOscarDashboardJsonlLines(filePath)) {
      const t = line;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.channel !== 'live') continue;

    const ts = typeof o.ts === 'number' ? o.ts : 0;
    if (ts) {
      if (ts < f) f = ts;
      if (ts > l) l = ts;
    }

    const kind = o.kind;

    if (kind === 'reset') {
      resetTs = ts;
      continue;
    }

    if (kind === 'heartbeat') {
      hbOpen = Number(o.openPositions ?? 0);
      hbClosed = Number(o.closedTotal ?? 0);
      const st = o.reconcileBootStatus;
      if (typeof st === 'string' && st) {
        const div = o.reconcileMintsDivergent;
        const chain = o.reconcileChainOnlyMints;
        liveReconcileBoot = {
          status: st,
          skipReason: typeof o.reconcileBootSkipReason === 'string' ? o.reconcileBootSkipReason : undefined,
          divergentCount: Array.isArray(div) ? div.length : undefined,
          chainOnlyCount: Array.isArray(chain) ? chain.length : undefined,
          journalTruncated: typeof o.journalReplayTruncated === 'boolean' ? o.journalReplayTruncated : undefined,
        };
      }
      continue;
    }

    if (kind === 'live_reconcile_report') {
      const ta = o.txAnchorSample as { notFound?: unknown[]; rpcErrors?: unknown } | undefined;
      liveReconcileReport = {
        ts,
        ok: Boolean(o.ok),
        reconcileStatus: String(o.reconcileStatus ?? ''),
        txAnchorMissing: Array.isArray(ta?.notFound) ? ta.notFound.length : undefined,
        txAnchorRpcErrors: typeof ta?.rpcErrors === 'number' ? ta.rpcErrors : undefined,
      };
      continue;
    }

    if (kind === 'execution_attempt') {
      if (ts >= since1h) evals1h += 1;
      const id = String(o.intentId ?? '');
      const m = String(o.mint ?? '');
      if (id && m) intentToMint.set(id, m);
      if (m && String(o.side ?? '').toLowerCase() === 'sell') {
        const z = bumpWalletDrainedZombieTrack(zombieTracks, m);
        z.hadSellAttempt = true;
        const targetPx = Number(o.targetPriceUsd ?? 0);
        if (targetPx > 0) z.lastSellTargetPx = targetPx;
      }
      if (m && String(o.side ?? '').toLowerCase() === 'buy') {
        const qv = entryQuoteVerifyFromExecutionAttempt(o);
        if (qv.entryPriceVerifySource) entryQuoteByMint.set(m, qv);
      }
      continue;
    }

    if (kind === 'execution_result') {
      const id = String(o.intentId ?? '');
      const mint = intentToMint.get(id);
      const sigRaw = o.txSignature;
      const status = String(o.status ?? '');
      if (mint && typeof sigRaw === 'string') {
        const sig = sigRaw.trim();
        if (sig.length >= 64) enqueueSig(mint, sig);
      }
      intentToMint.delete(id);
      if (ts >= since1h && (status === 'sim_ok' || status === 'confirmed')) passed1h += 1;
      continue;
    }

    if (kind === 'execution_skip' && typeof o.reason === 'string' && o.reason) {
      failReasonsCount.set(o.reason, (failReasonsCount.get(o.reason) ?? 0) + 1);
      if (o.reason === 'wallet_spl_balance_zero') {
        const id = String(o.intentId ?? '');
        const m = intentToMint.get(id) ?? String(o.mint ?? '');
        if (m) {
          const z = bumpWalletDrainedZombieTrack(zombieTracks, m);
          z.walletDrainedAt = ts;
        }
      }
      continue;
    }

    const mint = String(o.mint ?? '');
    if (!mint) continue;

    if (kind === 'live_position_open') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const metricType = ot.metricType != null ? String(ot.metricType) : null;
      const entryRealMcUsd = entryRealMcFromLiveOpenTrade(ot);
      const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];

      om.set(mint, paper2OpenItemFromLiveOpenTrade(mint, ot, entryQuoteByMint.get(mint)));
      liveMeta.set(mint, { metricType, entryRealMcUsd });

      const emMc0 = entryRealMcFromLiveOpenTrade(ot);
      const openLegUsd = Number(legsArr[0]?.sizeUsd ?? 0);
      const openLabelRu = isPresetCFile
        ? presetCOpenTimelineLabelRu(ot)
        : liveStagedOpenLabelRu(dashboardStrategyId, { ...ot, strategyId: dashboardStrategyId }) ??
          (isLiveOscarRiskyFile && openLegUsd > 0
            ? openLegUsd <= 60
              ? `Первая нога Risky: $${openLegUsd.toFixed(0)} по сигналу`
              : `Legacy Risky open: $${openLegUsd.toFixed(0)} после recheck`
            : typeof o.timelineOpenLabelRu === 'string' && o.timelineOpenLabelRu.trim()
              ? o.timelineOpenLabelRu.trim()
              : undefined);
      const syn: Record<string, unknown> = {
        kind: 'open',
        ts,
        strategyId: dashboardStrategyId,
        mint,
        symbol: ot.symbol,
        lane: ot.lane,
        source: ot.source,
        dex: ot.dex,
        entryTs: ot.entryTs,
        entryMcUsd: ot.entryMcUsd,
        entryMarketPrice: legsArr[0] ? legsArr[0].marketPrice ?? ot.entryMcUsd : ot.entryMcUsd,
        legs: ot.legs,
        totalInvestedUsd: ot.totalInvestedUsd,
        ...(ot.liveStagedEntry != null ? { liveStagedEntry: ot.liveStagedEntry } : {}),
        metricType,
        ...(emMc0 != null && emMc0 > 0 ? { mcUsdLive: emMc0 } : {}),
        ...(openLabelRu ? { timelineOpenLabelRu: openLabelRu } : {}),
        ...(typeof ot.tpRegime === 'string' && ot.tpRegime.trim() ? { tpRegime: ot.tpRegime } : {}),
        ...(ot.liveExitProfileMode === 'A' || ot.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ot.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, metricType, entryRealMcUsd));
      liveTimelines.set(mint, tev ? [tev] : []);
      continue;
    }

    if (kind === 'live_position_scale_in') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
      const lastLeg = legsArr[legsArr.length - 1];
      if (!lastLeg || String(lastLeg.reason ?? '') !== 'scale_in') continue;
      const posUsd = Number(ot.totalInvestedUsd ?? 0);
      const legUsd = Number(lastLeg.sizeUsd ?? 0);
      const fracFull = posUsd > 0 && legUsd > 0 ? legUsd / posUsd : 0;

      const baseLab = isPresetCFile
        ? presetCStagedLegTimelineLabelRu(legUsd, ot.liveOscarMcapTier)
        : isLiveOscarRiskyFile && legUsd > 0
          ? `Legacy scale-in Risky: $${legUsd.toFixed(0)} по старому коридору +1%/−2%`
          : fracFull > 0
            ? `Докупка ${Math.round(fracFull * 100)}% позиции`
            : 'Докупка второй ноги входа';
      const syn: Record<string, unknown> = {
        kind: 'scale_in_add',
        ts,
        strategyId: dashboardStrategyId,
        mint,
        marketPrice: Number(lastLeg.marketPrice ?? lastLeg.price ?? 0),
        sizeUsd: legUsd,
        secondLegFractionOfFull: fracFull > 0 ? +fracFull.toFixed(6) : undefined,
        timelineLabelRu:
          ot.liveExitProfileMode === 'B'
            ? `${baseLab} · режим выхода B`
            : ot.liveExitProfileMode === 'A'
              ? `${baseLab} · режим A`
              : baseLab,
        totalInvestedUsd: ot.totalInvestedUsd,
        mcUsdLive: undefined,
        ...(ot.liveExitProfileMode === 'A' || ot.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ot.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
      const cur = om.get(mint);
      if (cur) {
        const tiu = Number(ot.totalInvestedUsd ?? 0);
        if (tiu > 0) cur.totalInvestedUsd = tiu;
        cur.remainingFraction = 1;
      }
      continue;
    }

    if (kind === 'live_position_dca') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const legsArr = Array.isArray(ot.legs) ? (ot.legs as Record<string, unknown>[]) : [];
      const lastLeg = legsArr[legsArr.length - 1];
      if (!lastLeg) continue;
      const usedIdx = Array.isArray(ot.dcaUsedIndices) ? (ot.dcaUsedIndices as number[]) : [];
      const dcaStepIndex = usedIdx.length ? usedIdx[usedIdx.length - 1]! : Math.max(0, legsArr.length - 2);
      const dcaLevelsTotal =
        Array.isArray(ot.dcaUsedLevels) && ot.dcaUsedLevels.length > 0 ? ot.dcaUsedLevels.length : 1;
      const journalDcaLabelRu =
        typeof o.timelineLabelRu === 'string' && o.timelineLabelRu.trim().length
          ? o.timelineLabelRu.trim()
          : null;

      const trig = Number(lastLeg.triggerPct ?? 0);
      const dcaUsd = Number(lastLeg.sizeUsd ?? 0);
      const legReason = String(lastLeg.reason ?? '');
      const dcaLabelRu = isPresetCFile
        ? presetCStagedLegTimelineLabelRu(dcaUsd, ot.liveOscarMcapTier)
        : journalDcaLabelRu ??
          legTimelineLabelFromLeg(lastLeg, ot) ??
          (isLiveOscarRiskyFile && dcaUsd > 0
            ? `DCA Risky: докупка $${dcaUsd.toFixed(0)} при ${(trig * 100).toFixed(0)}% от первой ноги · режим выхода B`
            : undefined);
      const synKind =
        legReason === 'entry_split'
          ? 'entry_split_add'
          : legReason === 'staged_avg'
            ? 'staged_avg_add'
            : 'dca_add';
      const syn: Record<string, unknown> = {
        kind: synKind,
        ts,
        strategyId: dashboardStrategyId,
        mint,
        marketPrice: Number(lastLeg.marketPrice ?? lastLeg.price ?? 0),
        sizeUsd: dcaUsd,
        triggerPct: trig,
        dcaStepIndex,
        dcaLevelsTotal,
        totalInvestedUsd: ot.totalInvestedUsd,
        mcUsdLive: undefined,
        ...(ot.liveStagedEntry != null ? { liveStagedEntry: ot.liveStagedEntry } : {}),
        ...(dcaLabelRu
          ? {
              timelineLabelRu: dcaLabelRu,
              ...(legReason === 'staged_avg' || legReason === 'dca' || ot.liveExitProfileMode === 'B'
                ? { liveExitProfileMode: 'B' as const }
                : {}),
            }
          : ot.liveExitProfileMode === 'B'
          ? {
              timelineLabelRu: `DCA шаг ${dcaStepIndex + 1}/${dcaLevelsTotal} (${(trig * 100).toFixed(0)}%) · режим выхода B`,
              liveExitProfileMode: 'B',
            }
          : ot.liveExitProfileMode === 'A'
            ? { liveExitProfileMode: 'A' }
            : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
      const cur = om.get(mint);
      if (cur) {
        const tiu = Number(ot.totalInvestedUsd ?? 0);
        if (tiu > 0) cur.totalInvestedUsd = tiu;
        cur.remainingFraction = 1;
      }
      continue;
    }

    if (kind === 'live_phase_escalation') {
      const cur = om.get(mint);
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      if (cur) {
        Object.assign(cur, liveOscarOpenLaneFieldsFromRecord(ot));
      }
      continue;
    }

    if (kind === 'live_position_partial_sell') {
      const ot = (o.openTrade ?? {}) as Record<string, unknown>;
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const partials = Array.isArray(ot.partialSells) ? (ot.partialSells as Record<string, unknown>[]) : [];
      const ps = partials[partials.length - 1];
      if (!ps) continue;
      const psReason = String(ps.reason ?? 'partial_sell');
      const ladderUsed = Array.isArray(ot.ladderUsedIndices) ? (ot.ladderUsedIndices as number[]) : [];
      const stepIdx = ladderUsed.length ? ladderUsed[ladderUsed.length - 1]! : 0;
      const lvlArr = Array.isArray(ot.ladderUsedLevels) ? (ot.ladderUsedLevels as number[]) : [];
      const ladderRungsTotal = lvlArr.length > 0 ? lvlArr.length : 2;
      const ladderPnlPctRaw =
        psReason === 'TRAIL_STEP'
          ? Number(ps.ladderPnlPct ?? ps.trailLevelPnlFrac ?? 0)
          : lvlArr.length > stepIdx
            ? lvlArr[stepIdx]
            : lvlArr.length
              ? lvlArr[lvlArr.length - 1]
              : 0;
      const psTimelineLabel =
        typeof ps.timelineLabelRu === 'string' && ps.timelineLabelRu.trim().length
          ? ps.timelineLabelRu.trim()
          : typeof o.timelineLabelRu === 'string' && o.timelineLabelRu.trim().length
            ? o.timelineLabelRu.trim()
            : undefined;

      const syn: Record<string, unknown> = {
        kind: 'partial_sell',
        ts,
        strategyId: dashboardStrategyId,
        mint,
        marketPrice: Number(ps.marketPrice ?? ps.price ?? 0),
        sellFraction: Number(ps.sellFraction ?? 0),
        ladderStepIndex: stepIdx,
        ladderRungsTotal,
        ladderPnlPct: Number(ladderPnlPctRaw ?? 0),
        reason: psReason,
        ...(psReason === 'TRAIL_STEP' ? { tpGrid: false } : {}),
        ...(psTimelineLabel ? { timelineLabelRu: psTimelineLabel } : {}),
        proceedsUsd: Number(ps.proceedsUsd ?? 0),
        pnlUsd: Number(ps.pnlUsd ?? 0),
        remainingFraction: Number(ot.remainingFraction ?? 0),
        mcUsdLive: undefined,
        ...(ot.liveExitProfileMode === 'A' || ot.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ot.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      if (tev) {
        const arr = liveTimelines.get(mint) ?? [];
        arr.push(tev);
        liveTimelines.set(mint, arr);
      }
      const op = om.get(mint);
      if (op) {
        const rf = Number(ot.remainingFraction ?? NaN);
        if (Number.isFinite(rf) && rf >= 0 && rf <= 1) op.remainingFraction = rf;
      }
      continue;
    }

    if (kind === 'live_position_close') {
      let ct = sanitizeCorruptLivePeriodicHealClosedTrade((o.closedTrade ?? {}) as Record<string, unknown>);
      ct = sanitizeReconcileOrphanClosedTradeForDashboard(ct);
      ct = sanitizeWalletDrainPartialCloseForDashboard(ct);
      const meta = liveMeta.get(mint) ?? { metricType: null, entryRealMcUsd: null };
      const syn: Record<string, unknown> = {
        kind: 'close',
        ts,
        strategyId: dashboardStrategyId,
        mint,
        exitTs: ct.exitTs,
        exitMcUsd: ct.exitMcUsd,
        exit_market_price:
          Number(ct.theoretical_exit_price ?? ct.effective_exit_price ?? ct.exitMcUsd ?? 0) || undefined,
        pnlPct: ct.pnlPct,
        netPnlUsd: ct.netPnlUsd,
        exitReason: ct.exitReason,
        remainingFraction: 0,
        totalInvestedUsd: ct.totalInvestedUsd,
        ...(typeof ct.tpRegime === 'string' && ct.tpRegime.trim() ? { tpRegime: ct.tpRegime } : {}),
        ...(ct.liveExitProfileMode === 'A' || ct.liveExitProfileMode === 'B'
          ? { liveExitProfileMode: ct.liveExitProfileMode }
          : {}),
      };
      const tev = attachSig(mint, buildTimelineEvent(syn, meta.metricType, meta.entryRealMcUsd));
      const arr = liveTimelines.get(mint) ?? [];
      if (tev) arr.push(tev);

      const closedRow: Paper2ClosedRow = {
        ...ct,
        mint,
        symbol: ct.symbol ?? om.get(mint)?.symbol ?? '',
        __timeline: arr,
      };
      cl.push(closedRow);
      om.delete(mint);
      liveMeta.delete(mint);
      liveTimelines.delete(mint);
      zombieTracks.delete(mint);
    }
    }
  } catch {
    return emptyLiveOscarPaper2Load();
  }

  const failReasons = [...failReasonsCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  const closedVisible =
    resetTs > 0 ? cl.filter((c) => Number((c as { exitTs?: unknown }).exitTs ?? 0) >= resetTs) : cl;

  const extras: LiveOscarPaper2Extras | undefined =
    liveReconcileBoot || liveReconcileReport
      ? { ...(liveReconcileBoot ? { liveReconcileBoot } : {}), ...(liveReconcileReport ? { liveReconcileReport } : {}) }
      : undefined;

  return applyWalletDrainedZombieInference(
    mergeLiveOscarOpenSnapshotIntoLoad(
      {
        open: [...om.values()],
        closed: closedVisible,
        firstTs: f,
        lastTs: l,
        resetTs,
        evals1h,
        passed1h,
        failReasons,
        openTimelines: liveTimelines,
        hbOpen,
        hbClosed,
        entryQuoteByMint,
        ...(extras ? { liveExtras: extras } : {}),
      },
      resolveLiveOscarOpenSnapshotPath(filePath),
      DASHBOARD_LIVE_OSCAR_SNAPSHOT_MAX_AGE_MS,
      dashboardStrategyId,
    ),
    zombieTracks,
    liveTimelines,
    liveMeta,
    dashboardStrategyId,
  );
}

/** Merge copy-trader state/journal opens into Live Oscar panel (shared wallet). */
export function augmentLiveOscarLoadWithCopyLeaderOpens(load: LiveOscarPaper2Load): {
  load: LiveOscarPaper2Load;
  copyTrader?: CopyTraderDashboardStats;
} {
  const statePath =
    process.env.DASHBOARD_COPY_TRADER_STATE_PATH?.trim() ||
    path.resolve(PAPER2_DIR, '..', 'copytrader', 'state.json');
  const journalPath =
    process.env.DASHBOARD_COPY_TRADER_JSONL?.trim() ||
    path.resolve(PAPER2_DIR, '..', 'copytrader', 'journal.jsonl');
  const leaderWallet = (
    process.env.DASHBOARD_COPY_TRADER_LEADER_WALLET?.trim() ||
    process.env.COPY_TRADER_TARGET_WALLET?.trim() ||
    DASHBOARD_COPY_TRADER_LEADER_WALLET
  ).trim();
  const merge = loadCopyLeaderOpensForLiveOscarDashboard(statePath, journalPath, leaderWallet);
  if (!merge) return { load };
  return {
    load: mergeCopyLeaderOpensIntoLiveOscarLoad(load, merge),
    copyTrader: merge.copyTrader,
  };
}

function paper2Metrics(closed: Paper2ClosedRow[]): {
  total: number;
  wins: number;
  winRate: number;
  sumPnlUsd: number;
  avgPnl: number;
  avgPeak: number;
  bestPnlUsd: number;
  worstPnlUsd: number;
  exits: Record<string, number>;
  exitsBreakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }>;
} {
  const exitKinds = [
    'TP',
    'SL',
    'TRAIL',
    'TIMEOUT',
    'NO_DATA',
    'KILLSTOP',
    'LIQ_DRAIN',
    'RECONCILE_ORPHAN',
    'PERIODIC_HEAL',
    'CAPITAL_ROTATE',
  ] as const;
  const exits: Record<string, number> = Object.fromEntries(exitKinds.map((k) => [k, 0]));
  const breakdown: Record<string, { count: number; sumPct: number; sumUsd: number; avgPct: number }> =
    Object.fromEntries(exitKinds.map((k) => [k, { count: 0, sumPct: 0, sumUsd: 0, avgPct: 0 }]));
  if (!closed.length) {
    return {
      total: 0,
      wins: 0,
      winRate: 0,
      sumPnlUsd: 0,
      avgPnl: 0,
      avgPeak: 0,
      bestPnlUsd: 0,
      worstPnlUsd: 0,
      exits,
      exitsBreakdown: breakdown,
    };
  }
  let sumPct = 0;
  let sumPeak = 0;
  let wins = 0;
  let bestUsd = -Infinity;
  let worstUsd = Infinity;
  let sumUsd = 0;
  for (const c of closed) {
    const pnlUsd = closedRowPnlUsd(c);
    const pnlPct = closedRowDisplayPnlPct(c, pnlUsd);
    sumPct += pnlPct;
    sumUsd += pnlUsd;
    sumPeak += Number(c.peakPnlPct ?? c['peak_pnl_pct'] ?? 0);
    if (pnlUsd > 0) wins++;
    if (pnlUsd > bestUsd) bestUsd = pnlUsd;
    if (pnlUsd < worstUsd) worstUsd = pnlUsd;
    const r = normalizePaper2ExitReason(String(c.exitReason ?? 'NO_DATA'));
    if (exits[r] != null) exits[r]++;
    if (breakdown[r]) {
      breakdown[r].count++;
      breakdown[r].sumPct += pnlPct;
      breakdown[r].sumUsd += pnlUsd;
    }
  }
  for (const k of Object.keys(breakdown)) {
    breakdown[k].avgPct = breakdown[k].count ? breakdown[k].sumPct / breakdown[k].count : 0;
  }
  return {
    total: closed.length,
    wins,
    winRate: (wins / closed.length) * 100,
    sumPnlUsd: sumUsd,
    avgPnl: sumPct / closed.length,
    avgPeak: sumPeak / closed.length,
    bestPnlUsd: bestUsd === -Infinity ? 0 : bestUsd,
    worstPnlUsd: worstUsd === Infinity ? 0 : worstUsd,
    exits,
    exitsBreakdown: breakdown,
  };
}

function makeEmptyDashboardStrategyRow(strategyId: string, file: string): DashboardPaper2StrategyRow {
  const m = paper2Metrics([]);
  return {
    strategyId,
    file,
    openCount: 0,
    closedCount: 0,
    startedAt: Date.now(),
    lastTs: 0,
    hoursOfData: 0,
    sumPnlUsd: m.sumPnlUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    winRate: m.winRate,
    avgPnl: m.avgPnl,
    avgPeak: m.avgPeak,
    bestPnlUsd: m.bestPnlUsd,
    worstPnlUsd: m.worstPnlUsd,
    unrealizedUsd: 0,
    exits: m.exits,
    exitsBreakdown: m.exitsBreakdown,
    evals1h: 0,
    passed1h: 0,
    failReasons: [],
    open: [],
    recentClosed: [],
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
  };
}

/**
 * Summarize live-oscar JSONL for tests and lightweight callers (no PG/Jupiter enrichment).
 * Full `/api/paper2` row uses `loadLiveOscarJsonlAsPaper2` + `buildPaper2StrategyRowFromLoad`.
 */
export function aggregateLiveOscarJsonlForDashboard(filePath: string): DashboardPaper2StrategyRow {
  const fallback = (): DashboardPaper2StrategyRow => makeEmptyDashboardStrategyRow('live-oscar', filePath);
  if (!fs.existsSync(filePath)) return fallback();

  const ll = loadLiveOscarJsonlAsPaper2(filePath);
  const m = paper2Metrics(ll.closed);
  const startedAt = ll.resetTs || ll.firstTs;
  const now = Date.now();

  return {
    strategyId: 'live-oscar',
    file: filePath,
    openCount: ll.open.length,
    closedCount: Math.max(ll.closed.length, ll.hbClosed),
    startedAt,
    lastTs: ll.lastTs > 0 ? ll.lastTs : startedAt,
    hoursOfData: (now - startedAt) / 3_600_000,
    sumPnlUsd: m.sumPnlUsd,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalPnlUsd: 0,
    winRate: m.winRate,
    avgPnl: m.avgPnl,
    avgPeak: m.avgPeak,
    bestPnlUsd: m.bestPnlUsd,
    worstPnlUsd: m.worstPnlUsd,
    unrealizedUsd: 0,
    exits: m.exits,
    exitsBreakdown: m.exitsBreakdown,
    evals1h: ll.evals1h,
    passed1h: ll.passed1h,
    failReasons: ll.failReasons,
    open: [],
    recentClosed: [],
    priorityFeeUsdTotal: 0,
    priceVerify: { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null },
    liqDrain: { exits: 0, avgDropPct: null, p90DropPct: null },
    ...(ll.liveExtras ?? {}),
  };
}

/** Фиксированный порядок трёх плиток (см. `DASHBOARD_PANEL_ORDER`). */
export function mergeDashboardStrategyPanels(rows: DashboardPaper2StrategyRow[]): DashboardPaper2StrategyRow[] {
  const byId = new Map(rows.map((r) => [r.strategyId, r]));
  return DASHBOARD_PANEL_ORDER.map((id) => byId.get(id) ?? makeEmptyDashboardStrategyRow(id, '—'));
}

app.get('/papertrader2', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.header('pragma', 'no-cache');
  return fs.readFileSync(HTML2_PATH, 'utf-8');
});

app.get('/smart-lottery', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  return fs.readFileSync(HTML_SMLOT_PATH, 'utf-8');
});

app.get('/SmartLottery', async (_req, reply) => {
  reply.header('content-type', 'text/html; charset=utf-8');
  return fs.readFileSync(HTML_SMLOT_PATH, 'utf-8');
});

app.get('/api/paper2/priority-fee', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const solUsd = Number(process.env.DASHBOARD_SOL_USD ?? 160);
  const targetCu = Number(process.env.PAPER_PRIORITY_FEE_TARGET_CU ?? 200_000);
  const payload = buildPriorityFeeMonitorApiPayload({
    solUsd: Number.isFinite(solUsd) && solUsd > 0 ? solUsd : 160,
    targetCu: Number.isFinite(targetCu) && targetCu > 0 ? targetCu : 200_000,
  });
  if (payload.ok !== true) {
    reply.code(503);
    return payload;
  }
  return payload;
});

// ---------------------------------------------------------
// PaperTrader2 header: BTC spot · wallet SOL (RPC) · SOL spot — % vs 30m / 1h / 4h / 12h for spots (CoinGecko)
// ---------------------------------------------------------
const CRYPTO_TICKER_SPOT_SPECS = [
  { coingeckoId: 'bitcoin', symbol: 'BTC' },
  { coingeckoId: 'solana', symbol: 'SOL' },
] as const;

interface CryptoTickerAssetRow {
  id: string;
  symbol: string;
  /** Middle panel: native SOL balance via getBalance (not CoinGecko). */
  rowKind?: 'coingecko' | 'wallet_sol';
  balanceSol?: number | null;
  walletPubkeyShort?: string | null;
  priceUsd: number | null;
  chg30mPct: number | null;
  chg1hPct: number | null;
  chg4hPct: number | null;
  chg12hPct: number | null;
}

interface CryptoTickerApiPayload {
  ok: boolean;
  updatedAt: number;
  source: 'coingecko';
  assets: CryptoTickerAssetRow[];
  error?: string;
}

function cgApiBaseAndHeaders(): { base: string; headers: Record<string, string> } {
  const key = (process.env.COINGECKO_API_KEY || '').trim();
  if (key) {
    return {
      base: 'https://pro-api.coingecko.com/api/v3',
      headers: { 'x-cg-pro-api-key': key },
    };
  }
  return { base: 'https://api.coingecko.com/api/v3', headers: {} };
}

/** Last sample at or before target time (chart series is sorted asc by ms). */
function priceAtOrBefore(series: [number, number][], targetMs: number): number | null {
  if (!Array.isArray(series) || series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  let bestIdx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ts = series[mid][0];
    if (ts <= targetMs) {
      bestIdx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestIdx < 0) return null;
  const px = Number(series[bestIdx][1]);
  return Number.isFinite(px) && px > 0 ? px : null;
}

function pctChangeVsPast(current: number | null, past: number | null): number | null {
  if (current == null || past == null || past <= 0 || current <= 0) return null;
  return +(((current - past) / past) * 100).toFixed(4);
}

let cryptoTickerCache: { at: number; payload: CryptoTickerApiPayload } | null = null;

/** Second header wallet (DCA Trader / former Copy Trader) — same RPC/shape as main `Wallet` tile. */
const DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY = (
  process.env.DASHBOARD_DC_TRADER_WALLET_PUBKEY ||
  process.env.DASHBOARD_COPY_TRADER_WALLET_PUBKEY ||
  process.env.DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY ||
  ''
).trim();

function emptyWalletRow(id: string, symbol: string): CryptoTickerAssetRow {
  return {
    id,
    symbol,
    rowKind: 'wallet_sol',
    priceUsd: null,
    balanceSol: null,
    walletPubkeyShort: null,
    chg30mPct: null,
    chg1hPct: null,
    chg4hPct: null,
    chg12hPct: null,
  };
}

async function fetchWalletSolTickerRowForPk(
  signal: AbortSignal,
  pubkey: string,
  label: { id: string; symbol: string },
): Promise<CryptoTickerAssetRow> {
  const pk = pubkey.trim();
  const base: CryptoTickerAssetRow = {
    id: label.id,
    symbol: label.symbol,
    rowKind: 'wallet_sol',
    priceUsd: null,
    balanceSol: null,
    walletPubkeyShort: pk ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : null,
    chg30mPct: null,
    chg1hPct: null,
    chg4hPct: null,
    chg12hPct: null,
  };
  const httpUrl =
    liveOscarRpcHttpUrlFromEnv() ||
    (process.env.HOURLY_RPC_URL || '').trim() ||
    resolveSolanaRpcUrl() ||
    undefined;
  if (!pk || !httpUrl) return base;
  try {
    void signal;
    const out = await qnCall<unknown>('getBalance', [pk, { commitment: 'confirmed' }], {
      feature: 'sim',
      timeoutMs: 12_000,
      httpUrl,
      creditsPerCall: 1,
    });
    if (!out.ok) return base;
    const lamports = lamportsFromGetBalanceResult(out.value);
    if (lamports == null) return base;
    const sol = Number(lamports) / 1e9;
    return { ...base, balanceSol: Number.isFinite(sol) ? sol : null };
  } catch {
    return base;
  }
}

/** Main Live Oscar wallet + optional Live Oscar Risky wallet (papertrader2 header). */
async function fetchWalletSolTickerRows(signal: AbortSignal): Promise<CryptoTickerAssetRow[]> {
  const mainPk = (process.env.LIVE_WALLET_PUBKEY || process.env.HOURLY_WALLET_PUBKEY || '').trim();
  const riskyPk = DASHBOARD_LIVE_OSCAR_RISKY_WALLET_PUBKEY;
  const main = await fetchWalletSolTickerRowForPk(signal, mainPk, {
    id: 'wallet_sol_main',
    symbol: 'Wallet',
  });
  if (!riskyPk) return [main];
  const risky = await fetchWalletSolTickerRowForPk(signal, riskyPk, {
    id: 'wallet_sol_risky',
    symbol: 'DCA Trader',
  });
  return [main, risky];
}

async function fetchCryptoTickerPayload(): Promise<CryptoTickerApiPayload> {
  const now = Date.now();
  const cached = cryptoTickerCache;
  const ttlMs = cached?.payload.ok === false ? 20_000 : 60_000;
  if (cached && now - cached.at < ttlMs) return cached.payload;

  const { base, headers } = cgApiBaseAndHeaders();
  const ids = CRYPTO_TICKER_SPOT_SPECS.map((s) => s.coingeckoId).join(',');
  const signal = AbortSignal.timeout(14_000);

  const emptySpotRows = (): CryptoTickerAssetRow[] =>
    CRYPTO_TICKER_SPOT_SPECS.map((s) => ({
      id: s.coingeckoId,
      symbol: s.symbol,
      priceUsd: null,
      chg30mPct: null,
      chg1hPct: null,
      chg4hPct: null,
      chg12hPct: null,
    }));

  try {
    const walletRowsPromise = fetchWalletSolTickerRows(signal);

    const simpleUrl = `${base}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
    const simpleRes = await fetch(simpleUrl, { headers, signal });
    if (!simpleRes.ok) {
      const spot = emptySpotRows();
      const walletRows = await walletRowsPromise;
      const errPayload: CryptoTickerApiPayload = {
        ok: false,
        updatedAt: now,
        source: 'coingecko',
        assets: [spot[0]!, ...walletRows, spot[1]!],
        error: `simple/price HTTP ${simpleRes.status}`,
      };
      cryptoTickerCache = { at: now, payload: errPayload };
      return errPayload;
    }
    const simpleJson = (await simpleRes.json()) as Record<string, { usd?: number } | undefined>;

    const chartPromises = CRYPTO_TICKER_SPOT_SPECS.map(async (spec) => {
      const url = `${base}/coins/${spec.coingeckoId}/market_chart?vs_currency=usd&days=1`;
      try {
        const r = await fetch(url, { headers, signal });
        if (!r.ok) return { id: spec.coingeckoId, prices: null as [number, number][] | null };
        const j = (await r.json()) as { prices?: [number, number][] };
        return { id: spec.coingeckoId, prices: Array.isArray(j.prices) ? j.prices : null };
      } catch {
        return { id: spec.coingeckoId, prices: null };
      }
    });

    const [charts, walletRows] = await Promise.all([Promise.all(chartPromises), walletRowsPromise]);
    const chartById = new Map(charts.map((c) => [c.id, c.prices]));

    const t30 = now - 30 * 60 * 1000;
    const t1h = now - 60 * 60 * 1000;
    const t4h = now - 4 * 60 * 60 * 1000;
    const t12h = now - 12 * 60 * 60 * 1000;

    const spotAssets: CryptoTickerAssetRow[] = CRYPTO_TICKER_SPOT_SPECS.map((spec) => {
      const row = simpleJson[spec.coingeckoId];
      let priceUsd =
        row && typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd > 0 ? row.usd : null;

      const series = chartById.get(spec.coingeckoId);
      if (priceUsd == null && series?.length) {
        const last = series[series.length - 1];
        const lp = Number(last[1]);
        if (Number.isFinite(lp) && lp > 0) priceUsd = lp;
      }

      const p30 = series ? priceAtOrBefore(series, t30) : null;
      const p1h = series ? priceAtOrBefore(series, t1h) : null;
      const p4h = series ? priceAtOrBefore(series, t4h) : null;
      const p12 = series ? priceAtOrBefore(series, t12h) : null;

      return {
        id: spec.coingeckoId,
        symbol: spec.symbol,
        priceUsd,
        chg30mPct: pctChangeVsPast(priceUsd, p30),
        chg1hPct: pctChangeVsPast(priceUsd, p1h),
        chg4hPct: pctChangeVsPast(priceUsd, p4h),
        chg12hPct: pctChangeVsPast(priceUsd, p12),
      };
    });

    const assets: CryptoTickerAssetRow[] = [spotAssets[0]!, ...walletRows, spotAssets[1]!];

    const anyPrice = spotAssets.some((a) => a.priceUsd != null);
    const payload: CryptoTickerApiPayload = {
      ok: anyPrice,
      updatedAt: now,
      source: 'coingecko',
      assets,
      ...(anyPrice ? {} : { error: 'no_prices' }),
    };
    cryptoTickerCache = { at: Date.now(), payload };
    return payload;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const spot = emptySpotRows();
    let walletRows: CryptoTickerAssetRow[];
    try {
      walletRows = await fetchWalletSolTickerRows(signal);
    } catch {
      walletRows = [emptyWalletRow('wallet_sol_main', 'Wallet')];
    }
    const errPayload: CryptoTickerApiPayload = {
      ok: false,
      updatedAt: now,
      source: 'coingecko',
      assets: [spot[0]!, ...walletRows, spot[1]!],
      error: msg,
    };
    cryptoTickerCache = { at: now, payload: errPayload };
    return errPayload;
  }
}

async function buildPaper2StrategyRowFromLoad(
  fp: string,
  sid: string,
  loaded: Paper2FileLoad & {
    copyTrader?: CopyTraderDashboardStats;
    dcTrader?: DcTraderDashboardStats;
    dcTraderWatching?: Paper2OpenItem[];
    superbot?: SuperbotDashboardLoad['superbot'];
    hbOpen?: number;
    hbClosed?: number;
    hlOscar?: DashboardPaper2StrategyRow['hlOscar'];
  },
  hb?: { hbOpen?: number; hbClosed?: number; reconcileExtras?: LiveOscarPaper2Extras },
  buildOpts?: { opensOnly?: boolean },
): Promise<DashboardPaper2StrategyRow & { open: Paper2ApiEnrichedOpen[] }> {
  const { open, closed, firstTs, lastTs, resetTs, evals1h, passed1h, failReasons, openTimelines } = loaded;
  const enrichMode = paper2EnrichModeForSid(sid);
  const m = paper2Metrics(closed);
  const startedAt = resetTs || firstTs;
  const opensOnly = buildOpts?.opensOnly === true;
  const recentClosedLimit = opensOnly
    ? 0
    : enrichMode === 'lite'
      ? Math.min(12, dashboardRecentClosedLimit())
      : dashboardRecentClosedLimit();
  const closedWithUsd = opensOnly
    ? []
    : (
    await Promise.all(
      selectRecentClosedRowsForDashboard(closed, recentClosedLimit).map(async (c) => {
        const pnlUsd = closedRowPnlUsd(c);
        const pnlPct = closedRowDisplayPnlPct(c, pnlUsd);
        const costs = c.costs as Record<string, unknown> | undefined;
        const timelineRaw = Array.isArray(c.__timeline) ? (c.__timeline as TimelineEvent[]) : [];
        const timelineSorted = timelineRaw.slice().sort((a, b) => a.ts - b.ts);
        const entryTs = Number(c.entryTs ?? 0);
        const entryMcapAtBuyUsd =
          enrichMode === 'lite'
            ? entryMcapFromOpenTimelineEvent(timelineSorted)
            : await resolveEntryMcapAtBuyUsd(
                String(c.mint),
                entryTs,
                timelineSorted,
                c.source != null ? String(c.source) : null,
              );
        const exitMcapUsd = exitMcapFromCloseTimelineEvent(timelineSorted);
        const exitPfUsd = Number((c as { priorityFee?: { usd?: number } }).priorityFee?.usd ?? 0);
        const exitPriorityFeeUsd =
          Number.isFinite(exitPfUsd) && exitPfUsd > 0 ? exitPfUsd : null;
        let tlOut = timelineSorted.map((ev: TimelineEvent) => ({ ...ev }));
        tlOut = filterSpuriousDcaOpenDuplicate(tlOut);
        if (
          tlOut.length &&
          tlOut[0].kind === 'open' &&
          entryMcapAtBuyUsd != null &&
          entryMcapAtBuyUsd > 0 &&
          (!(Number(tlOut[0].mcUsd) > 0) || tlOut[0].mcUsd == null)
        ) {
          tlOut[0] = { ...tlOut[0], mcUsd: entryMcapAtBuyUsd };
        }
        if (enrichMode === 'full') {
          tlOut = await enrichTimelineMcapGaps(
            String(c.mint),
            tlOut,
            c.source != null ? String(c.source) : null,
          );
        }
        tlOut = finalizeTimelineForApi(tlOut, sid);
        const pairAddr = typeof c.pairAddress === 'string' ? c.pairAddress : null;
        const closedEvmQuote =
          isEvmPulseSid(sid) && String(c.mint ?? '').startsWith('0x')
            ? await fetchDexscreenerEvmToken(
                String(c.mint),
                evmChainForSid(sid) as 'base' | 'bsc',
                pairAddr,
              ).catch(() => null)
            : null;
        const isHlOscarClosed = isHlOscarSid(sid);
        const closedDisplaySymbol = isHlOscarClosed
          ? resolveHlOscarCoinFromRow({
              pairAddress: pairAddr,
              symbol: c.symbol,
              features: (c as { features?: { coin?: string; hyperliquidUrl?: string } }).features,
            }).coin
          : isEvmPulseSid(sid)
          ? await resolveEvmPulseDisplaySymbol(String(c.mint), c.symbol, closedEvmQuote)
          : enrichMode === 'lite' && c.symbol && String(c.symbol).trim() && c.symbol !== '?'
            ? String(c.symbol).slice(0, 32)
            : await resolveTokenSymbolForUi(String(c.mint), c.symbol);
        const closedHlOscar = isHlOscarClosed
          ? resolveHlOscarCoinFromRow({
              pairAddress: pairAddr,
              symbol: closedDisplaySymbol,
              features: (c as { features?: { coin?: string; hyperliquidUrl?: string } }).features,
            })
          : null;
        const entryPriceVerifySlipPct =
          typeof c.entryPriceVerifySlipPct === 'number' ? c.entryPriceVerifySlipPct : null;
        const entryPriceVerifyImpactPct =
          typeof c.entryPriceVerifyImpactPct === 'number' ? c.entryPriceVerifyImpactPct : null;
        const entryPriceVerifySource =
          c.entryPriceVerifySource === 'jupiter' ||
          c.entryPriceVerifySource === 'skipped' ||
          c.entryPriceVerifySource === 'blocked'
            ? c.entryPriceVerifySource
            : null;
        const closedEntryPx = closedRowEntryPx(c);
        const closedExitPx = closedRowExitPx(c);
        const lw = c.liqWatch as { currentLiqUsd?: unknown; dropPct?: unknown } | undefined;
        const exitLiqUsd =
          lw != null && Number.isFinite(Number(lw.currentLiqUsd)) && Number(lw.currentLiqUsd) > 0
            ? Number(lw.currentLiqUsd)
            : null;
        const exitLiqDropPct =
          lw != null && Number.isFinite(Number(lw.dropPct)) ? +Number(lw.dropPct).toFixed(2) : null;
        const exitContext = (c as { exitContext?: unknown }).exitContext ?? null;
        return {
          mint: c.mint,
          symbol: closedDisplaySymbol,
          exitTs: c.exitTs,
          entryTs: c.entryTs,
          exitReason: normalizePaper2ExitReason(String(c.exitReason ?? 'NO_DATA')),
          pnlPct,
          pnlUsd,
          durationMin: Number(c.durationMin ?? 0),
          dex: costs && costs.dex,
          entryMcapAtBuyUsd,
          exitMcapUsd: exitMcapUsd != null && exitMcapUsd > 0 ? exitMcapUsd : null,
          exitPriorityFeeUsd,
          entryPriceVerifySlipPct,
          entryPriceVerifyImpactPct,
          entryPriceVerifySource,
          entryPx: closedEntryPx > 0 ? closedEntryPx : null,
          exitPx: closedExitPx > 0 ? closedExitPx : null,
          baselinePriceUsd: closedEntryPx > 0 ? closedEntryPx : null,
          exitLiqUsd,
          exitLiqDropPct,
          exitContext,
          timeline: tlOut,
          pairAddress:
            typeof (c as { pairAddress?: unknown }).pairAddress === 'string'
              ? String((c as { pairAddress: string }).pairAddress).trim() || null
              : null,
          ...(closedHlOscar
            ? { coin: closedHlOscar.coin, hyperliquidUrl: closedHlOscar.hyperliquidUrl }
            : {}),
        };
      }),
    )
  )
    .sort((a, b) => Number(b.exitTs ?? 0) - Number(a.exitTs ?? 0))
    .slice(0, recentClosedLimit);

  // Enrich open positions with a live mcap (pump.fun -> DEX snapshot fallback),
  // recompute pnl% and pnl$ when possible. Capped to 30 rows for sanity.
  //
  // IMPORTANT: entryMcUsd in legacy jsonl is NOT a USD market cap — it's
  // a tiny per-token-price-like number (e.g. 0.003) that cannot be compared
  // with USD live mcap. Only entryRealMcUsd (taken from features.market_cap_usd
  // or features.fdv_usd at open-time) is a legitimate USD baseline.
  // We also clamp pnlPct to ±100000% to guard against absurd numbers if a
  // future jsonl row has a misclassified baseline.
  const PNL_PCT_CLAMP = 100_000; // 1000x
  const isDcTraderPanel = sid === 'dc-trader';
  const isSuperbotPanel = sid === 'superbot';
  const isBasePulsePanel = sid === 'base-pulse';
  const isBscPulsePanel = sid === 'bsc-pulse';
  const isHlOscarPanel = isHlOscarSid(sid);
  let hlMids: Map<string, number> | null = null;
  if (isHlOscarPanel) {
    try {
      const cache = await loadHyperliquidMarketCache();
      hlMids = cache.mids;
    } catch (e) {
      console.warn('[dashboard] hl-oscar mids fetch failed', String(e).slice(0, 120));
    }
  }
  const enrichedOpen: Paper2ApiEnrichedOpen[] = await Promise.all(
    open.slice(0, 30).map(async (ot): Promise<Paper2ApiEnrichedOpen> => {
      const isCopyRow = ot.isCopyLeader === true;
      const timelineKey = isCopyRow ? `copy:${ot.mint}` : ot.mint;
      const timelineSorted = (openTimelines.get(timelineKey) ?? openTimelines.get(ot.mint) ?? [])
        .slice()
        .sort((a, b) => a.ts - b.ts);
      const isMcMetric = !isDcTraderPanel && !isSuperbotPanel && ot.metricType === 'mc';
      let displayLiveMc: number | null = null;
      let liveMcProvenance: 'snapshots' | 'pump.fun' | null = null;
      let evmQuote: DexscreenerEvmQuote | null = null;
      if (isBasePulsePanel && String(ot.mint ?? '').startsWith('0x')) {
        evmQuote = await fetchDexscreenerEvmToken(ot.mint, 'base', ot.pairAddress).catch(() => null);
      } else if (isBscPulsePanel && String(ot.mint ?? '').startsWith('0x')) {
        evmQuote = await fetchDexscreenerEvmToken(ot.mint, 'bsc', ot.pairAddress).catch(() => null);
      }
      if (evmQuote) {
        const mc = evmQuote.marketCapUsd ?? evmQuote.fdvUsd;
        if (mc != null && mc > 0) {
          displayLiveMc = mc;
          liveMcProvenance = 'snapshots';
        }
      }
      if (enrichMode === 'full' && isMcMetric && !isBasePulsePanel && !isBscPulsePanel) {
        /** pump.fun → DEX; used for mcap-based PnL only when metricType=mc. */
        const liveMcForPnl = await getCurrentMcAny(ot.mint, ot.source).catch(() => null);
        const dexMcDisplay =
          liveMcForPnl != null && liveMcForPnl > 0
            ? null
            : await getDexLiveMc(ot.mint, ot.source).catch(() => null);
        displayLiveMc =
          liveMcForPnl != null && liveMcForPnl > 0
            ? liveMcForPnl
            : dexMcDisplay != null && dexMcDisplay > 0
              ? dexMcDisplay
              : null;
        if (displayLiveMc != null && displayLiveMc > 0) {
          liveMcProvenance = 'snapshots';
        } else if (!dexSourceFromTradeSource(ot.source)) {
          const pumpOnly = await getCurrentMc(ot.mint).catch(() => null);
          if (pumpOnly != null && pumpOnly > 0) {
            displayLiveMc = pumpOnly;
            liveMcProvenance = 'pump.fun';
          }
        }
      }
      const hasLiveMc = displayLiveMc != null;

      const basePx = ot.baselinePriceUsd != null && ot.baselinePriceUsd > 0 ? ot.baselinePriceUsd : null;
      let livePx: number | null = null;
      let livePxProvenance: 'snapshots' | 'jupiter' | 'pump.fun' | 'journal' | 'dexscreener' | null = null;
      let livePriceStale = false;
      if (evmQuote?.priceUsd != null && evmQuote.priceUsd > 0) {
        livePx = evmQuote.priceUsd;
        livePxProvenance = 'dexscreener';
      } else if (basePx) {
        if (enrichMode === 'full') {
          livePx = await getDexLivePrice(ot.mint, ot.source).catch(() => null);
          if (livePx) livePxProvenance = 'snapshots';
        }
        if (!livePx) {
          const jpx = await getJupiterTokenPriceUsd(ot.mint).catch(() => null);
          if (jpx != null && jpx > 0) {
            livePx = jpx;
            livePxProvenance = 'jupiter';
          }
        }
        if (!livePx && enrichMode === 'full') {
          const pumpMarketForOpen = await getPumpCoinMarket(ot.mint).catch(() => null);
          if (pumpMarketForOpen?.priceUsd != null && pumpMarketForOpen.priceUsd > 0) {
            livePx = pumpMarketForOpen.priceUsd;
            livePxProvenance = 'pump.fun';
          }
        }
        if (!livePx) {
          const st = latestTimelineSpotUsd(timelineSorted, TIMELINE_SPOT_FALLBACK_MAX_AGE_MS);
          if (st != null) {
            livePx = st;
            livePriceStale = enrichMode === 'lite';
            livePxProvenance = 'journal';
          }
        }
      }
      const hasLivePrice = livePx != null && livePx > 0;

      const baseEntryUsd =
        ot.entryRealMcUsd != null && ot.entryRealMcUsd > 0 ? ot.entryRealMcUsd : null;

      let entryMcapAtBuyUsd =
        ot.entryRealMcUsd != null && ot.entryRealMcUsd > 0 ? ot.entryRealMcUsd : null;
      if (entryMcapAtBuyUsd == null && enrichMode === 'full') {
        entryMcapAtBuyUsd = await resolveEntryMcapAtBuyUsd(
          ot.mint,
          ot.entryTs,
          timelineSorted,
          ot.source,
        );
      }
      if (entryMcapAtBuyUsd == null && enrichMode === 'lite') {
        entryMcapAtBuyUsd = entryMcapFromOpenTimelineEvent(timelineSorted);
      }

      let timelineOut = timelineSorted.map((ev: TimelineEvent) => ({ ...ev }));
      timelineOut = filterSpuriousDcaOpenDuplicate(timelineOut);
      if (
        timelineOut.length &&
        timelineOut[0].kind === 'open' &&
        (timelineOut[0].mcUsd == null || !(Number(timelineOut[0].mcUsd) > 0)) &&
        entryMcapAtBuyUsd != null &&
        entryMcapAtBuyUsd > 0
      ) {
        timelineOut[0] = { ...timelineOut[0], mcUsd: entryMcapAtBuyUsd };
      }
      if (enrichMode === 'full' && !isBasePulsePanel && !isBscPulsePanel) {
        timelineOut = await enrichTimelineMcapGaps(ot.mint, timelineOut, ot.source);
      }
      timelineOut = finalizeTimelineForApi(timelineOut, sid);

      const displaySymbol = isHlOscarPanel
        ? resolveHlOscarCoinFromRow({
            pairAddress: ot.pairAddress,
            symbol: ot.symbol,
            features: ot.features as { coin?: string; hyperliquidUrl?: string } | null,
          }).coin
        : isBasePulsePanel || isBscPulsePanel
          ? await resolveEvmPulseDisplaySymbol(ot.mint, ot.symbol, evmQuote)
          : enrichMode === 'lite' && ot.symbol && String(ot.symbol).trim() && ot.symbol !== '?'
            ? String(ot.symbol).slice(0, 32)
            : await resolveTokenSymbolForUi(ot.mint, ot.symbol);
      const openHlOscar = isHlOscarPanel
        ? resolveHlOscarCoinFromRow({
            pairAddress: ot.pairAddress,
            symbol: displaySymbol,
            features: ot.features as { coin?: string; hyperliquidUrl?: string } | null,
          })
        : null;

      const liveFdvUsd = evmQuote?.fdvUsd ?? evmQuote?.marketCapUsd ?? null;

      let pnlPct: number | null = null;
      let pnlUsd: number | null = null;

      const remainingCostBasisUsd =
        ot.totalInvestedUsd > 0 ? ot.totalInvestedUsd * Math.max(0, ot.remainingFraction ?? 1) : 0;

      const investedFor = (): number => {
        if (isDcTraderPanel || isSuperbotPanel) {
          const basis = remainingCostBasisUsd > 0 ? remainingCostBasisUsd : ot.totalInvestedUsd;
          const cap = isSuperbotPanel ? 500 : 50_000;
          return basis > 0 && basis <= cap
            ? basis
            : isSuperbotPanel
              ? superbotJsonlIsLiveOscarFormat(DASHBOARD_SUPERBOT_JSONL)
                ? PRESET_C_POSITION_USD_DEFAULT
                : PUMPSWAP_DIP_POSITION_USD_DEFAULT
              : POSITION_USD_DEFAULT;
        }
        const investedRaw = ot.totalInvestedUsd;
        if (isBasePulsePanel || isBscPulsePanel) {
          const basis = remainingCostBasisUsd > 0 ? remainingCostBasisUsd : investedRaw;
          return basis > 0 && basis <= 10_000 ? basis : POSITION_USD_DEFAULT;
        }
        return investedRaw > 0 && investedRaw <= 10_000 ? investedRaw : POSITION_USD_DEFAULT;
      };
      const tryByMcap = (): boolean => {
        /**
         * Mcap-based unrealized PnL. We use entryMcapAtBuyUsd (real USD mcap at buy,
         * possibly back-filled from snapshots) rather than the legacy `entryMcUsd` which
         * for price-tracked strategies stores a per-token price and is NOT a market cap.
         */
        const entryMc = entryMcapAtBuyUsd;
        if (!(entryMc && entryMc > 0)) return false;
        if (!(displayLiveMc && displayLiveMc > 0)) return false;
        const p = ((displayLiveMc as number) / entryMc - 1) * 100;
        if (!Number.isFinite(p) || Math.abs(p) > PNL_PCT_CLAMP) return false;
        pnlPct = p;
        pnlUsd = (investedFor() * p) / 100;
        return true;
      };
      const tryByPrice = (): boolean => {
        if (!(basePx && basePx > 0 && livePx != null && livePx > 0)) return false;
        /**
         * If our only "live" price is the journal-derived spot equal to the entry, this is
         * a stale pseudo-price (e.g. position has no DCA/partial events yet). Bail so the
         * mcap path can produce a real PnL number.
         */
        if (livePxProvenance === 'journal' && Math.abs((livePx as number) - basePx) / basePx < 1e-6) {
          return false;
        }
        const p = ((livePx as number) / basePx - 1) * 100;
        if (!Number.isFinite(p) || Math.abs(p) > PNL_PCT_CLAMP) return false;
        pnlPct = p;
        pnlUsd = (investedFor() * p) / 100;
        return true;
      };

      /**
       * dc-trader: unrealized from journal price bands + entry SOL/USD — never Oscar $100 fallback / Jupiter mark.
       * superbot: price path as before.
       */
      if (isDcTraderPanel) {
        const dc = ot as Record<string, unknown>;
        const bandPct = typeof dc.pnlPct === 'number' && Number.isFinite(dc.pnlPct) ? dc.pnlPct : null;
        const bandUsd = typeof dc.pnlUsd === 'number' && Number.isFinite(dc.pnlUsd) ? dc.pnlUsd : null;
        const entryUsd =
          ot.totalInvestedUsd > 0
            ? ot.totalInvestedUsd
            : typeof dc.entrySizeUsd === 'number' && dc.entrySizeUsd > 0
              ? dc.entrySizeUsd
              : 0;
        if (bandPct != null && entryUsd > 0) {
          pnlPct = bandPct;
          pnlUsd = bandUsd ?? (entryUsd * bandPct) / 100;
        }
      } else if (isSuperbotPanel) {
        tryByPrice();
      } else if (isBasePulsePanel || isBscPulsePanel) {
        if (!tryByPrice()) {
          const impliedPx = evmImpliedMarkPxFromTimeline(timelineOut, basePx);
          if (impliedPx != null && basePx && basePx > 0) {
            livePx = impliedPx;
            livePriceStale = true;
            livePxProvenance = 'journal';
            tryByPrice();
          }
        }
        if (basePx && livePx != null && livePx > 0 && ot.totalInvestedUsd > 0) {
          const pulsePnl = computeEvmPulseOpenPnl({
            totalInvestedUsd: ot.totalInvestedUsd,
            entryPx: basePx,
            livePx,
            remainingFraction: ot.remainingFraction ?? 1,
            timeline: timelineOut,
          });
          if (pulsePnl != null) {
            pnlPct = pulsePnl.pnlPct;
            pnlUsd = pulsePnl.pnlUsd;
          }
        }
      } else if (isHlOscarPanel) {
        const coin =
          (typeof ot.pairAddress === 'string' && ot.pairAddress.trim()) ||
          (typeof (ot.features as { coin?: string } | null)?.coin === 'string'
            ? String((ot.features as { coin: string }).coin)
            : ot.symbol);
        const mid = hlMids?.get(String(coin).toUpperCase());
        if (mid != null && mid > 0) {
          livePx = mid;
          livePxProvenance = 'hyperliquid';
        }
        if (basePx && livePx != null && livePx > 0 && ot.totalInvestedUsd > 0) {
          const rem = ot.remainingFraction ?? 1;
          const p = (livePx / basePx - 1) * 100;
          if (Number.isFinite(p) && Math.abs(p) <= PNL_PCT_CLAMP) {
            pnlPct = p;
            pnlUsd = (ot.totalInvestedUsd * rem * p) / 100;
          }
        }
      } else if (isMcMetric) {
        if (!tryByMcap()) tryByPrice();
      } else {
        if (!tryByPrice()) tryByMcap();
      }

      const entryLiqUsdVal = ot.entryLiqUsd ?? null;
      let currentLiqUsdVal =
        evmQuote?.liquidityUsd != null && evmQuote.liquidityUsd > 0 ? evmQuote.liquidityUsd : null;
      if (currentLiqUsdVal == null) {
        currentLiqUsdVal = await fetchPairLiquidityUsdFromPg(ot.pairAddress, ot.source).catch(() => null);
      }
      const liqDropPct =
        entryLiqUsdVal != null &&
        entryLiqUsdVal > 0 &&
        currentLiqUsdVal != null &&
        Number.isFinite(currentLiqUsdVal)
          ? +(((entryLiqUsdVal - currentLiqUsdVal) / entryLiqUsdVal) * 100).toFixed(2)
          : null;

      const vol24hUsd =
        evmQuote?.volume24hUsd ??
        (typeof (ot.features as { vol24hUsd?: number } | null)?.vol24hUsd === 'number'
          ? (ot.features as { vol24hUsd: number }).vol24hUsd
          : null);

      if (
        (isBasePulsePanel || isBscPulsePanel) &&
        (displayLiveMc == null || displayLiveMc <= 0) &&
        entryMcapAtBuyUsd != null &&
        entryMcapAtBuyUsd > 0 &&
        basePx &&
        basePx > 0 &&
        livePx != null &&
        livePx > 0
      ) {
        displayLiveMc = entryMcapAtBuyUsd * (livePx / basePx);
        liveMcProvenance = liveMcProvenance ?? 'journal';
      }

      const currentMcUsdResolved =
        displayLiveMc != null && displayLiveMc > 0
          ? displayLiveMc
          : liveFdvUsd != null && liveFdvUsd > 0
            ? liveFdvUsd
            : isMcMetric
              ? (baseEntryUsd ?? 0)
              : entryMcapAtBuyUsd != null && entryMcapAtBuyUsd > 0
                ? entryMcapAtBuyUsd
                : 0;

      const hasLivePriceResolved = livePx != null && livePx > 0;
      const livePriceUsd = hasLivePriceResolved ? livePx : null;

      const scalpAnchorPx =
        ot.presetCScalpAnchorPriceUsd != null && ot.presetCScalpAnchorPriceUsd > 0
          ? ot.presetCScalpAnchorPriceUsd
          : null;
      const markForAnchor = hasLivePriceResolved ? (livePx as number) : basePx > 0 ? basePx : null;
      let pnlPctVsAnchor: number | null = null;
      let peakPnlPctAnchor = ot.peakPnlPctAnchor ?? null;
      if (scalpAnchorPx != null && markForAnchor != null && markForAnchor > 0) {
        pnlPctVsAnchor = (markForAnchor / scalpAnchorPx - 1) * 100;
        if (peakPnlPctAnchor == null || !Number.isFinite(peakPnlPctAnchor)) {
          peakPnlPctAnchor = pnlPctVsAnchor;
        } else {
          peakPnlPctAnchor = Math.max(peakPnlPctAnchor, pnlPctVsAnchor);
        }
      }

      return {
        mint: ot.mint,
        symbol: displaySymbol,
        entryTs: ot.entryTs,
        entryMcUsd: ot.entryMcUsd,
        entryRealMcUsd: ot.entryRealMcUsd,
        entryMcapAtBuyUsd,
        baselinePriceUsd: ot.baselinePriceUsd,
        entryPx: basePx,
        markPx: hasLivePriceResolved ? livePx : basePx,
        metricType: ot.metricType,
        openedAtIso: ot.openedAtIso,
        lane: ot.lane,
        source: ot.source,
        currentMcUsd: currentMcUsdResolved,
        livePriceUsd,
        peakMcUsd: ot.peakMcUsd,
        peakPnlPct: ot.peakPnlPct,
        peakPnlPctAnchor,
        presetCScalpAnchorPriceUsd: scalpAnchorPx,
        pnlPctVsAnchor,
        trailingArmed: ot.trailingArmed,
        pnlPct,
        pnlUsd,
        ageMin: (Date.now() - (ot.entryTs || Date.now())) / 60_000,
        hasLiveMc: displayLiveMc != null && displayLiveMc > 0,
        hasLivePrice: hasLivePriceResolved,
        livePriceStale,
        livePxProvenance,
        liveMcProvenance,
        timeline: timelineOut,
        entryPriorityFeeUsd: ot.entryPriorityFeeUsd ?? null,
        entryPriceVerifySlipPct: ot.entryPriceVerifySlipPct ?? null,
        entryPriceVerifyImpactPct: ot.entryPriceVerifyImpactPct ?? null,
        entryPriceVerifySource: ot.entryPriceVerifySource ?? null,
        pairAddress: ot.pairAddress != null ? String(ot.pairAddress).trim() || null : null,
        entryLiqUsd: entryLiqUsdVal,
        currentLiqUsd: currentLiqUsdVal,
        liqDropPct,
        remainingCostBasisUsd,
        remainingFraction: ot.remainingFraction ?? 1,
        vol24hUsd,
        liveFdvUsd,
        liveOscarTradeLane: ot.liveOscarTradeLane ?? null,
        isScalpWave: ot.isScalpWave,
        isRunnerProbe: ot.isRunnerProbe === true,
        isCopyLeader: ot.isCopyLeader === true,
        positionSource: ot.positionSource ?? null,
        copyLeaderWalletShort: ot.copyLeaderWalletShort ?? null,
        copySizeUsd: isCopyRow && ot.totalInvestedUsd > 0 ? ot.totalInvestedUsd : null,
        ...(openHlOscar
          ? { coin: openHlOscar.coin, hyperliquidUrl: openHlOscar.hyperliquidUrl }
          : {}),
      };
    }),
  );

  enrichedOpen.sort((a, b) => (b.entryTs || 0) - (a.entryTs || 0));

  const unrealizedUsd = enrichedOpen.reduce((acc, o) => acc + (o.pnlUsd ?? 0), 0);
  const realizedPnlUsd = m.sumPnlUsd;
  const totalPnlUsd = realizedPnlUsd + unrealizedUsd;

  const priorityFeeUsdTotal = opensOnly
    ? 0
    : closed.reduce((acc, row) => {
        const pf = Number((row as { priorityFee?: { usd?: number } }).priorityFee?.usd ?? 0);
        return acc + (pf > 0 ? pf : 0);
      }, 0);

  const priceVerify = opensOnly
    ? { okCount: 0, blockedCount: 0, skippedCount: 0, avgSlipPct: null, p90SlipPct: null }
    : aggregatePriceVerifyFromJsonl(fp, PAPER2_PRICE_VERIFY_AGG_WINDOW_MS);

  const liqDrain = opensOnly
    ? { exits: 0, avgDropPct: null, p90DropPct: null }
    : (() => {
    let exits = 0;
    const drops: number[] = [];
    for (const r of closed) {
      if (String(r.exitReason) !== 'LIQ_DRAIN') continue;
      exits += 1;
      const d = Number((r as { liqWatch?: { dropPct?: number } }).liqWatch?.dropPct ?? NaN);
      if (Number.isFinite(d)) drops.push(d);
    }
    const sorted = [...drops].sort((a, b) => a - b);
    return {
      exits,
      avgDropPct: drops.length ? +((drops.reduce((a, b) => a + b, 0) / drops.length).toFixed(2)) : null,
      p90DropPct: drops.length
        ? sorted[Math.min(sorted.length - 1, Math.floor(drops.length * 0.9))]
        : null,
    };
  })();

  return {
    strategyId: sid,
    file: fp,
    openCount: open.length,
    closedCount: Math.max(closed.length, hb?.hbClosed ?? 0),
    startedAt,
    lastTs,
    hoursOfData: (Date.now() - startedAt) / 3_600_000,
    sumPnlUsd: m.sumPnlUsd,
    realizedPnlUsd,
    unrealizedPnlUsd: unrealizedUsd,
    totalPnlUsd,
    winRate: m.winRate,
    avgPnl: m.avgPnl,
    avgPeak: m.avgPeak,
    bestPnlUsd: m.bestPnlUsd,
    worstPnlUsd: m.worstPnlUsd,
    unrealizedUsd,
    exits: m.exits,
    exitsBreakdown: m.exitsBreakdown,
    evals1h,
    passed1h,
    failReasons,
    open: enrichedOpen,
    recentClosed: closedWithUsd,
    priorityFeeUsdTotal,
    priceVerify,
    liqDrain,
    ...(hb?.reconcileExtras ?? {}),
    ...(loaded.copyTrader ? { copyTrader: loaded.copyTrader } : {}),
    ...(loaded.dcTrader ? { dcTrader: loaded.dcTrader } : {}),
    ...(loaded.dcTraderWatching ? { dcTraderWatching: loaded.dcTraderWatching } : {}),
    ...(loaded.superbot ? { superbot: loaded.superbot } : {}),
    ...(loaded.hlOscar ? { hlOscar: loaded.hlOscar } : {}),
  };
}

app.get('/api/smart-lottery', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const fp = DASHBOARD_SMLOT_JSONL;
  const sid = path.basename(fp, '.jsonl');
  const row = await buildPaper2StrategyRowFromLoad(fp, sid, loadPaper2File(fp));
  const totals = {
    strategies: 1,
    open: row.openCount,
    closed: row.closedCount,
    sumPnlUsd: row.sumPnlUsd,
    realizedPnlUsd: row.realizedPnlUsd,
    unrealizedPnlUsd: row.unrealizedPnlUsd,
    totalPnlUsd: row.totalPnlUsd,
  };
  return {
    now: Date.now(),
    paper2Dir: PAPER2_DIR,
    smartLotteryJsonl: fp,
    totals,
    strategies: [row],
  };
});

app.get('/api/paper2/crypto-ticker', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  return fetchCryptoTickerPayload();
});

async function buildPaper2ApiPayload(): Promise<Record<string, unknown>> {
  const llRaw = loadLiveOscarJsonlAsPaper2(DASHBOARD_LIVE_OSCAR_JSONL);
  const { load: ll } = augmentLiveOscarLoadWithCopyLeaderOpens(llRaw);
  const { hbOpen, hbClosed, liveExtras, ...liveLoaded } = ll;
  const dcLoad = loadDcTraderForDashboard(
    DASHBOARD_DC_TRADER_JSONL,
    DASHBOARD_DC_TRADER_STATE_PATH,
  );
  const { dcTrader: dcTraderStats, watchingOpen, ...dcLoaded } = dcLoad;
  const sbLoad = superbotJsonlIsLiveOscarFormat(DASHBOARD_SUPERBOT_JSONL)
    ? loadLiveOscarJsonlAsPaper2(DASHBOARD_SUPERBOT_JSONL)
    : loadSuperbotJsonlForDashboard(DASHBOARD_SUPERBOT_JSONL);
  const { superbot: superbotStats, hbOpen: sbHbOpen, hbClosed: sbHbClosed, ...superbotLoaded } = sbLoad;

  const liveRowP = buildPaper2StrategyRowFromLoad(DASHBOARD_LIVE_OSCAR_JSONL, 'live-oscar', {
    ...liveLoaded,
  }, {
    hbOpen,
    hbClosed,
    reconcileExtras: liveExtras,
  }).catch((e) => {
    console.warn('[dashboard] live-oscar panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('live-oscar', DASHBOARD_LIVE_OSCAR_JSONL);
  });
  const superbotRowP = buildPaper2StrategyRowFromLoad(DASHBOARD_SUPERBOT_JSONL, 'superbot', {
    ...superbotLoaded,
    superbot: superbotStats,
  }, {
    hbOpen: sbHbOpen,
    hbClosed: sbHbClosed,
  }).catch((e) => {
    console.warn('[dashboard] superbot panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('superbot', DASHBOARD_SUPERBOT_JSONL);
  });
  const dcRowP = buildPaper2StrategyRowFromLoad(DASHBOARD_DC_TRADER_JSONL, 'dc-trader', {
    ...dcLoaded,
    dcTrader: dcTraderStats,
    dcTraderWatching: watchingOpen,
  }).catch((e) => {
    console.warn('[dashboard] dc-trader panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('dc-trader', DASHBOARD_DC_TRADER_JSONL);
  });
  const basePulseJsonl = basePulseDashboardJsonlPath();
  const basePulseLoad = loadBasePulseForDashboard(basePulseJsonl);
  const basePulseRowP = buildPaper2StrategyRowFromLoad(basePulseJsonl, 'base-pulse', basePulseLoad).catch((e) => {
    console.warn('[dashboard] base-pulse panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('base-pulse', basePulseJsonl);
  });
  const bscPulseJsonl = bscPulseDashboardJsonlPath();
  const bscPulseLoad = loadBscPulseForDashboard(bscPulseJsonl);
  const bscPulseRowP = buildPaper2StrategyRowFromLoad(bscPulseJsonl, 'bsc-pulse', bscPulseLoad).catch((e) => {
    console.warn('[dashboard] bsc-pulse panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('bsc-pulse', bscPulseJsonl);
  });
  const hlOscarJsonl = hlOscarPerpDashboardJsonlPath();
  const hlOscarLoad = loadHlOscarPerpForDashboard(hlOscarJsonl);
  const hlOscarRowP = buildPaper2StrategyRowFromLoad(hlOscarJsonl, 'hl-oscar-perp', {
    ...hlOscarLoad,
    hlOscar: hlOscarLoad.hlOscar,
  }).catch((e) => {
    console.warn('[dashboard] hl-oscar-perp panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('hl-oscar-perp', hlOscarJsonl);
  });
  const hlMajorsJsonl = hlOscarMajorsDashboardJsonlPath();
  const hlMajorsLoad = loadHlOscarMajorsForDashboard(hlMajorsJsonl);
  const hlMajorsRowP = buildPaper2StrategyRowFromLoad(hlMajorsJsonl, 'hl-oscar-majors', {
    ...hlMajorsLoad,
    hlOscar: hlMajorsLoad.hlOscar,
  }).catch((e) => {
    console.warn('[dashboard] hl-oscar-majors panel failed', String(e).slice(0, 200));
    return makeEmptyDashboardStrategyRow('hl-oscar-majors', hlMajorsJsonl);
  });
  const [liveRow, superbotRow, dcTraderRow, hlOscarRow, basePulseRow, bscPulseRow, hlMajorsRow] = await Promise.all([
    liveRowP,
    superbotRowP,
    dcRowP,
    hlOscarRowP,
    basePulseRowP,
    bscPulseRowP,
    hlMajorsRowP,
  ]);
  const merged = mergeDashboardStrategyPanels([
    liveRow as DashboardPaper2StrategyRow,
    superbotRow as DashboardPaper2StrategyRow,
    dcTraderRow as DashboardPaper2StrategyRow,
    hlOscarRow as DashboardPaper2StrategyRow,
    basePulseRow as DashboardPaper2StrategyRow,
    bscPulseRow as DashboardPaper2StrategyRow,
    hlMajorsRow as DashboardPaper2StrategyRow,
  ]);

  const totals = merged.reduce(
    (acc, s) => {
      acc.strategies += 1;
      acc.open += s.openCount;
      acc.closed += s.closedCount;
      acc.sumPnlUsd += s.sumPnlUsd;
      acc.realizedPnlUsd += s.realizedPnlUsd;
      acc.unrealizedPnlUsd += s.unrealizedPnlUsd;
      acc.totalPnlUsd += s.totalPnlUsd;
      return acc;
    },
    {
      strategies: 0,
      open: 0,
      closed: 0,
      sumPnlUsd: 0,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      totalPnlUsd: 0,
    },
  );

  return {
    now: Date.now(),
    dashboardBuildId: DASHBOARD_PAPER2_BUILD_ID,
    paper2Dir: PAPER2_DIR,
    liveOscarJsonl: DASHBOARD_LIVE_OSCAR_JSONL,
    liveOscarRiskyJsonl: DASHBOARD_LIVE_OSCAR_RISKY_JSONL,
    superbotJsonl: DASHBOARD_SUPERBOT_JSONL,
    hlTwapLiveJsonl: hlTwapDashboardJsonlPath(),
    basePulseJsonl: basePulseDashboardJsonlPath(),
    bscPulseJsonl: bscPulseDashboardJsonlPath(),
    hlOscarPerpJsonl: hlOscarPerpDashboardJsonlPath(),
    hlOscarMajorsJsonl: hlOscarMajorsDashboardJsonlPath(),
    panelOrder: DASHBOARD_PANEL_ORDER,
    totals,
    strategies: merged,
  };
}

async function getPaper2ApiPayloadCached(): Promise<{ payload: unknown; stale: boolean; building: boolean }> {
  const now = Date.now();
  const hit = paper2ApiCache;
  if (hit) {
    const fresh = hit.expiresAt > now;
    const staleAge = now - hit.builtAt;
    const staleOk = staleAge <= DASHBOARD_PAPER2_STALE_SERVE_MS;
    if (!fresh && staleOk && !paper2ApiBuild) {
      startPaper2ApiBuild().catch((e) => {
        console.warn('[dashboard] paper2 background refresh failed', String(e).slice(0, 200));
      });
    }
    if (fresh || staleOk) {
      return { payload: hit.payload, stale: !fresh, building: !!paper2ApiBuild };
    }
  }
  const payload = await startPaper2ApiBuild();
  return { payload, stale: false, building: false };
}

async function buildPaper2OpensPayload(): Promise<Record<string, unknown>> {
  const llRaw =
    loadLiveOscarOpensOnlyFromSnapshot(DASHBOARD_LIVE_OSCAR_JSONL) ??
    loadLiveOscarJsonlAsPaper2(DASHBOARD_LIVE_OSCAR_JSONL);
  const { load: ll } = augmentLiveOscarLoadWithCopyLeaderOpens(llRaw);
  const { hbOpen, hbClosed, liveExtras, ...liveLoaded } = ll;
  const row = await buildPaper2StrategyRowFromLoad(
    DASHBOARD_LIVE_OSCAR_JSONL,
    'live-oscar',
    liveLoaded,
    { hbOpen, hbClosed, reconcileExtras: liveExtras },
    { opensOnly: true },
  );
  return {
    now: Date.now(),
    strategyId: 'live-oscar',
    openCount: row.openCount,
    open: row.open,
    unrealizedUsd: row.unrealizedUsd,
    totalPnlUsd: row.totalPnlUsd,
    ...(liveExtras ? { liveExtras } : {}),
  };
}

function startPaper2OpensApiBuild(): Promise<unknown> {
  if (paper2OpensApiBuild) return paper2OpensApiBuild;
  paper2OpensApiBuild = buildPaper2OpensPayload()
    .then((payload) => {
      paper2OpensApiCache = {
        expiresAt: Date.now() + DASHBOARD_PAPER2_OPENS_CACHE_MS,
        payload,
      };
      return payload;
    })
    .finally(() => {
      paper2OpensApiBuild = null;
    });
  return paper2OpensApiBuild;
}

async function getPaper2OpensPayloadCached(): Promise<{ payload: unknown; stale: boolean }> {
  const now = Date.now();
  const hit = paper2OpensApiCache;
  if (hit && hit.expiresAt > now) {
    return { payload: hit.payload, stale: false };
  }
  if (hit) {
    startPaper2OpensApiBuild().catch((e) => {
      console.warn('[dashboard] paper2/opens background refresh failed', String(e).slice(0, 200));
    });
    return { payload: hit.payload, stale: true };
  }
  const payload = await startPaper2OpensApiBuild();
  return { payload, stale: false };
}

app.get('/api/paper2/opens', async (_req, reply) => {
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.header('pragma', 'no-cache');
  const { payload, stale } = await getPaper2OpensPayloadCached();
  if (stale) reply.header('x-dashboard-stale', '1');
  return payload;
});

app.get('/api/paper2', async (_req, reply) => {
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, max-age=0');
  reply.header('pragma', 'no-cache');
  const { payload, stale, building } = await getPaper2ApiPayloadCached();
  if (stale) reply.header('x-dashboard-stale', '1');
  if (building) reply.header('x-dashboard-refreshing', '1');
  return payload;
});

/** Tile 4 — full HL alt universe (`hl-oscar-perp-watch`, excludes BTC/ETH). */
app.get('/api/hl-all', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const jsonl = hlOscarPerpDashboardJsonlPath();
  const load = loadHlOscarPerpForDashboard(jsonl);
  return {
    strategyId: 'hl-oscar-perp',
    jsonl,
    heartbeat: hlOscarPerpHeartbeatPath(),
    ...load,
    openTimelines: Object.fromEntries(load.openTimelines),
  };
});

/** Tile 7 — BTC+ETH only (`hl-oscar-majors-watch`). */
app.get('/api/hl-majors', async (_req, reply) => {
  reply.header('cache-control', 'no-store');
  const jsonl = hlOscarMajorsDashboardJsonlPath();
  const load = loadHlOscarMajorsForDashboard(jsonl);
  return {
    strategyId: 'hl-oscar-majors',
    jsonl,
    heartbeat: hlOscarMajorsHeartbeatPath(),
    ...load,
    openTimelines: Object.fromEntries(load.openTimelines),
  };
});

app.get('/api/paper2/price-verify-stats', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  const files = dashboardOscarPanelJsonlFiles();
  const rawMin = Number((req.query as { windowMin?: string })?.windowMin);
  const windowMin = Math.max(5, Math.min(7 * 24 * 60, Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 1440));
  const windowMs = windowMin * 60 * 1000;
  const perStrategy: Record<string, unknown> = {};
  let okGlobal = 0;
  let blockedGlobal = 0;
  let skippedGlobal = 0;
  for (const fp of files) {
    const sid = path.basename(fp, '.jsonl');
    const slice = priceVerifyStatsEndpointSlice(fp, windowMs);
    perStrategy[sid] = slice;
    okGlobal += slice.okCount;
    blockedGlobal += slice.blockedCount;
    skippedGlobal += slice.skippedCount;
  }
  return {
    windowMin,
    perStrategy,
    global: {
      okCount: okGlobal,
      blockedCount: blockedGlobal,
      skippedCount: skippedGlobal,
      blockedRate:
        okGlobal + blockedGlobal > 0 ? +(blockedGlobal / (okGlobal + blockedGlobal)).toFixed(4) : 0,
    },
  };
});

function aggregateLiqWatchEndpointSlice(filePath: string, windowMs: number): {
  liqDrainExits: number;
  avgDropPct: number | null;
  p90DropPct: number | null;
  rpcFallbackUsedCount: number;
  snapshotMissCount: number;
} {
  const drops: number[] = [];
  let exits = 0;
  let rpcFallbackUsedCount = 0;
  let snapshotMissCount = 0;
  if (!fs.existsSync(filePath)) {
    return {
      liqDrainExits: 0,
      avgDropPct: null,
      p90DropPct: null,
      rpcFallbackUsedCount: 0,
      snapshotMissCount: 0,
    };
  }
  const cutoff = Date.now() - windowMs;
  for (const ln of dashboardJsonlLines(filePath)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(ln) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof ev.ts === 'number' ? ev.ts : 0;
    if (ts < cutoff) continue;
    if (ev.kind !== 'close') continue;
    if (ev.exitReason !== 'LIQ_DRAIN') continue;
    exits += 1;
    const lw = ev.liqWatch as { dropPct?: unknown; source?: unknown } | undefined;
    const d = Number(lw?.dropPct ?? NaN);
    if (Number.isFinite(d)) drops.push(d);
    if (lw?.source === 'rpc') rpcFallbackUsedCount += 1;
    if (lw?.source === 'none') snapshotMissCount += 1;
  }
  const sorted = [...drops].sort((a, b) => a - b);
  return {
    liqDrainExits: exits,
    avgDropPct: drops.length ? +((drops.reduce((a, b) => a + b, 0) / drops.length).toFixed(2)) : null,
    p90DropPct: drops.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(drops.length * 0.9))]
      : null,
    rpcFallbackUsedCount,
    snapshotMissCount,
  };
}

app.get('/api/paper2/liq-watch-stats', async (req, reply) => {
  reply.header('cache-control', 'no-store');
  const files = dashboardOscarPanelJsonlFiles();
  const rawMin = Number((req.query as { windowMin?: string })?.windowMin);
  const windowMin = Math.max(
    5,
    Math.min(7 * 24 * 60, Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 1440),
  );
  const windowMs = windowMin * 60 * 1000;
  const perStrategy: Record<string, unknown> = {};
  for (const fp of files) {
    const sid = path.basename(fp, '.jsonl');
    perStrategy[sid] = aggregateLiqWatchEndpointSlice(fp, windowMs);
  }
  return { windowMin, perStrategy };
});

if (process.env.DASHBOARD_NO_LISTEN !== '1') {
  app
    .listen({ port: PORT, host: HOST })
    .then(() => {
      console.log(`[dashboard] listening on http://${HOST}:${PORT}`);
      console.log(`[dashboard] reading store from ${path.resolve(STORE_PATH)}`);
      const cp = resolvedOrgCursorPath();
      console.log(`[dashboard] organizer cursor file: ${cp ?? '(n/a — not organizer journal)'}`);
      startQuickNodeUsageReporting();
    })
    .catch((err: unknown) => {
      console.error('[dashboard] listen failed (port in use or bind error):', err);
      process.exit(1);
    });
}
