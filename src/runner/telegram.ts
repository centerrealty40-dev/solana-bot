import { request } from 'undici';
import { sql as dsql } from 'drizzle-orm';
import { config } from '../core/config.js';
import { db, schema } from '../core/db/client.js';
import { child } from '../core/logger.js';

const log = child('telegram');

/** Best-effort Markdown send. No-ops when bot token / chat id are missing. */
export async function sendTelegram(text: string): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    const res = await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (res.statusCode !== 200) {
      const body = await res.body.text().catch(() => '');
      log.warn({ status: res.statusCode, body: body.slice(0, 200) }, 'telegram non-200');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'telegram send failed');
  }
}

/* ----- Helpers ----- */

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function escapeMd(s: string): string {
  // Telegram Markdown v1 special chars we want to keep as text
  return s.replace(/([_*`\[])/g, '\\$1');
}

function fmtUsd(v: number, digits = 2): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '' : '-';
  if (abs >= 1) return `${sign}$${abs.toFixed(digits)}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(4)}`;
  if (abs >= 0.000001) return `${sign}$${abs.toFixed(8)}`;
  return `${sign}$${abs.toExponential(2)}`;
}

function fmtPct(v: number, digits = 2): string {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(digits)}%`;
}

function fmtDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const remMin = min % 60;
  if (h < 24) return remMin === 0 ? `${h}h` : `${h}h ${remMin}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return remH === 0 ? `${d}d` : `${d}d ${remH}h`;
}

async function tokenLabel(mint: string): Promise<string> {
  const rows = await db
    .select({ symbol: schema.tokens.symbol })
    .from(schema.tokens)
    .where(dsql`${schema.tokens.mint} = ${mint}`)
    .limit(1);
  const sym = rows[0]?.symbol;
  return sym ? `${escapeMd(sym)} (${shortMint(mint)})` : shortMint(mint);
}

/* ----- Trade events ----- */

export async function notifyEntry(args: {
  hypothesisId: string;
  positionId: bigint;
  baseMint: string;
  sizeUsd: number;
  entryPriceUsd: number;
  slippageBps: number;
  feeUsd: number;
  reason: string;
}): Promise<void> {
  const label = await tokenLabel(args.baseMint);
  const text =
    `🟢 *${args.hypothesisId.toUpperCase()} BUY* \`#${args.positionId}\`\n` +
    `Token: ${label}\n` +
    `Size: ${fmtUsd(args.sizeUsd)}\n` +
    `Entry: ${fmtUsd(args.entryPriceUsd, 6)}\n` +
    `Slippage: ${args.slippageBps.toFixed(0)} bps  |  Fee: ${fmtUsd(args.feeUsd, 4)}\n` +
    `Reason: ${escapeMd(args.reason)}`;
  await sendTelegram(text);
}

export async function notifyExit(args: {
  hypothesisId: string;
  positionId: bigint;
  baseMint: string;
  fraction: number;
  entryPriceUsd: number;
  exitPriceUsd: number;
  realizedPnlUsd: number;
  totalPnlUsd: number;
  heldMs: number;
  closed: boolean;
  reason: string;
}): Promise<void> {
  const label = await tokenLabel(args.baseMint);
  const pct = args.exitPriceUsd / Math.max(args.entryPriceUsd, 1e-12) - 1;
  const fractionLabel = args.fraction >= 0.999 ? 'FULL' : `${(args.fraction * 100).toFixed(0)}%`;
  const emoji = args.realizedPnlUsd >= 0 ? '✅' : '❌';
  const closeLabel = args.closed ? ' (CLOSED)' : ' (PARTIAL)';
  const text =
    `${emoji} *${args.hypothesisId.toUpperCase()} SELL ${fractionLabel}* \`#${args.positionId}\`${closeLabel}\n` +
    `Token: ${label}\n` +
    `Entry: ${fmtUsd(args.entryPriceUsd, 6)}  →  Exit: ${fmtUsd(args.exitPriceUsd, 6)}  (${fmtPct(pct)})\n` +
    `Held: ${fmtDuration(args.heldMs)}\n` +
    `Trade PnL: ${fmtUsd(args.realizedPnlUsd)}\n` +
    `Total position PnL: ${fmtUsd(args.totalPnlUsd)}\n` +
    `Reason: ${escapeMd(args.reason)}`;
  await sendTelegram(text);
}

/* ----- Heartbeat & daily summary ----- */

export async function notifyHeartbeat(stats: {
  windowHours: number;
  swapsProcessed: number;
  signalsRaised: number;
  positionsOpened: number;
  positionsClosed: number;
  openCount: number;
  realizedPnlWindow: number;
}): Promise<void> {
  const text =
    `💓 *Heartbeat — last ${stats.windowHours}h*\n` +
    `Swaps processed: ${stats.swapsProcessed}\n` +
    `Signals raised: ${stats.signalsRaised}\n` +
    `Entries: ${stats.positionsOpened}  |  Closes: ${stats.positionsClosed}\n` +
    `Open positions: ${stats.openCount}\n` +
    `Window realized PnL: ${fmtUsd(stats.realizedPnlWindow)}\n` +
    `Mode: ${config.executorMode.toUpperCase()}`;
  await sendTelegram(text);
}

export interface DailyHypothesisRow {
  hypothesisId: string;
  trades: number;
  wins: number;
  realizedPnlUsd: number;
}

export async function notifyDailyReport(args: {
  day: string;
  rows: DailyHypothesisRow[];
  openPositionsCount: number;
}): Promise<void> {
  const totals = args.rows.reduce(
    (acc, r) => {
      acc.trades += r.trades;
      acc.wins += r.wins;
      acc.pnl += r.realizedPnlUsd;
      return acc;
    },
    { trades: 0, wins: 0, pnl: 0 },
  );
  const lines = args.rows.map((r) => {
    if (r.trades === 0) return `• ${r.hypothesisId.toUpperCase()}: no trades`;
    const wr = (r.wins / r.trades) * 100;
    const emoji = r.realizedPnlUsd > 0 ? '🟢' : r.realizedPnlUsd < 0 ? '🔴' : '⚪';
    return `${emoji} ${r.hypothesisId.toUpperCase()}: ${r.trades}t  ${wr.toFixed(0)}% wr  ${fmtUsd(r.realizedPnlUsd)}`;
  });
  const totalWr = totals.trades > 0 ? (totals.wins / totals.trades) * 100 : 0;
  const text =
    `📊 *Daily report — ${args.day}*\n` +
    lines.join('\n') +
    `\n\nTotal: ${totals.trades} trades, ${totalWr.toFixed(0)}% wr, ${fmtUsd(totals.pnl)}\n` +
    `Open positions: ${args.openPositionsCount}\n` +
    `Mode: ${config.executorMode.toUpperCase()}`;
  await sendTelegram(text);
}

/* ----- Copy-trader (paper) events ----- */

function shortWallet(w: string): string {
  return `${w.slice(0, 4)}…${w.slice(-4)}`;
}

export async function notifyCopyEntry(args: {
  positionId: bigint;
  baseMint: string;
  triggerWallet: string;
  sizeUsd: number;
  entryPriceUsd: number;
  leadAmountUsd: number;
  dex: string;
}): Promise<void> {
  const label = await tokenLabel(args.baseMint);
  const text =
    `📥 *COPY BUY (paper)* \`#${args.positionId}\`\n` +
    `Token: ${label}\n` +
    `Leader: \`${shortWallet(args.triggerWallet)}\` bought ${fmtUsd(args.leadAmountUsd)} on ${args.dex}\n` +
    `Our paper size: ${fmtUsd(args.sizeUsd)} @ ${fmtUsd(args.entryPriceUsd, 6)}`;
  await sendTelegram(text);
}

export async function notifyCopyExit(args: {
  positionId: bigint;
  baseMint: string;
  triggerWallet: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  pnlUsd: number;
  heldMs: number;
  reason: string;
}): Promise<void> {
  const label = await tokenLabel(args.baseMint);
  const pct = args.exitPriceUsd / Math.max(args.entryPriceUsd, 1e-12) - 1;
  const emoji = args.pnlUsd >= 0 ? '✅' : '❌';
  const reasonHuman =
    args.reason === 'mirror_leader_sell' ? 'leader sold (mirror)' : args.reason;
  const text =
    `${emoji} *COPY SELL (paper)* \`#${args.positionId}\`\n` +
    `Token: ${label}\n` +
    `Leader: \`${shortWallet(args.triggerWallet)}\`\n` +
    `${fmtUsd(args.entryPriceUsd, 6)} → ${fmtUsd(args.exitPriceUsd, 6)}  (${fmtPct(pct)})\n` +
    `Held: ${fmtDuration(args.heldMs)}  |  PnL: ${fmtUsd(args.pnlUsd)}\n` +
    `Reason: ${escapeMd(reasonHuman)}`;
  await sendTelegram(text);
}

export async function notifyError(component: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await sendTelegram(`⚠️ *Error in ${escapeMd(component)}*\n\`\`\`\n${msg.slice(0, 500)}\n\`\`\``);
}

export async function notifyStartup(hypotheses: string[]): Promise<void> {
  const text =
    `🚀 *sa-runner started*\n` +
    `Hypotheses: ${hypotheses.map((h) => h.toUpperCase()).join(', ')}\n` +
    `Mode: ${config.executorMode.toUpperCase()}\n` +
    `Max position: ${fmtUsd(config.maxPositionUsd)}  |  Daily loss limit: ${config.dailyLossLimitPct}%`;
  await sendTelegram(text);
}
