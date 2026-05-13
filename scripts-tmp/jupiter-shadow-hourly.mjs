/**
 * Jupiter shadow — почасовая сводка (fired by cron `0 * * * *`):
 * читает signal-lab.jsonl + mtm-shadow.jsonl за `JUPITER_SHADOW_HOURLY_WINDOW_MS` (default 1h).
 * Telegram `[REPORT|ALERT][jupiter-shadow]` — только при **`JUPITER_SHADOW_HOURLY_TELEGRAM=1`** (по умолчанию выкл.;
 * иначе только JSON-строка в stdout / лог cron). При ошибок 0 — по умолчанию не шлём в TG (см. `JUPITER_SHADOW_HOURLY_SEND_IF_ZERO_ERRORS=1`).
 * ALERT при доле ошибок ≥ порога, иначе REPORT (можно силой ALERT через `JUPITER_SHADOW_HOURLY_FORCE_ALERT=1`).
 *
 * Источник: только локальные JSONL (Jupiter lite-api / shadow). НЕ дергает QuickNode.
 */
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const ROOT = process.env.SOLANA_ALPHA_ROOT || process.cwd();
dotenv.config({ path: path.join(ROOT, '.env') });

const WINDOW_MS = Number(process.env.JUPITER_SHADOW_HOURLY_WINDOW_MS || 3_600_000);
const TAIL_BYTES = Number(process.env.JUPITER_SHADOW_HOURLY_TAIL_BYTES || 12 * 1024 * 1024);
const ALERT_RATIO = Number(process.env.JUPITER_SHADOW_HOURLY_ALERT_RATIO || 0.2);
const MIN_EVENTS = Number(process.env.JUPITER_SHADOW_HOURLY_MIN_EVENTS || 5);
const FORCE_ALERT = String(process.env.JUPITER_SHADOW_HOURLY_FORCE_ALERT || '').trim() === '1';
/** `1` — как раньше: слать почасовой REPORT даже при 0 ошибок. По умолчанию не шлём, если ошибок нет. */
const SEND_IF_ZERO_ERRORS =
  String(process.env.JUPITER_SHADOW_HOURLY_SEND_IF_ZERO_ERRORS || '').trim() === '1';
/** `1` — слать сводку в Telegram; иначе только лог в stdout (cron-файл). */
const SEND_TELEGRAM = String(process.env.JUPITER_SHADOW_HOURLY_TELEGRAM || '').trim() === '1';

const SIGNAL_PATH =
  process.env.SHADOW_WATCH_SIGNAL_PATH || path.join(ROOT, 'data', 'live', 'signal-lab.jsonl');
const MTM_PATH =
  process.env.SHADOW_WATCH_MTM_PATH || path.join(ROOT, 'data', 'live', 'mtm-shadow.jsonl');

function readTail(filePath, maxBytes) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size === 0) return '';
    const fd = fs.openSync(filePath, 'r');
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, st.size - start, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

function scan(text, sinceTs, channel, kindErrorPred, payloadAccessors) {
  const out = { total: 0, errs: 0, mints: new Set(), wallMs: [], bps: [] };
  if (!text) return out;
  for (const ln of text.split('\n')) {
    if (!ln) continue;
    let row;
    try { row = JSON.parse(ln); } catch { continue; }
    const ts = typeof row.ts === 'number' ? row.ts : 0;
    if (ts < sinceTs) continue;
    if (row.channel !== channel) continue;
    out.total += 1;
    const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (kindErrorPred(row, p)) out.errs += 1;
    if (typeof p.mint === 'string') out.mints.add(p.mint);
    if (payloadAccessors) {
      const wm = payloadAccessors.wallMs(p);
      if (typeof wm === 'number' && Number.isFinite(wm)) out.wallMs.push(wm);
      const bps = payloadAccessors.bps(p);
      if (typeof bps === 'number' && Number.isFinite(bps)) out.bps.push(bps);
    }
  }
  return out;
}

function fmt(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

async function sendTelegramTagged(category, subtag, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) return false;
  const { sendTagged } = await import('../scripts/lib/telegram.mjs');
  return sendTagged(category, subtag, text);
}

async function main() {
  const since = Date.now() - WINDOW_MS;
  const sigText = readTail(SIGNAL_PATH, TAIL_BYTES);
  const mtmText = readTail(MTM_PATH, TAIL_BYTES);

  const sig = scan(
    sigText,
    since,
    'signal_lab',
    (_row, p) => typeof p.error === 'string' && p.error.trim().length > 0,
    {
      wallMs: (p) => p.wallMsPrimary,
      bps: (p) => p.divergePgVsPrimaryBps,
    },
  );
  const mtm = scan(
    mtmText,
    since,
    'mtm_shadow',
    (_row, p) => typeof p.errorAlt === 'string' && p.errorAlt.trim().length > 0,
    {
      wallMs: (p) => p.wallMsAlt,
      bps: (p) => p.divergePrimaryVsAltBps,
    },
  );

  const total = sig.total + mtm.total;
  const errs = sig.errs + mtm.errs;
  const ratio = total > 0 ? errs / total : 0;

  if (errs === 0 && !SEND_IF_ZERO_ERRORS) {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        skippedTelegram: true,
        reason: 'zero_errors',
        total,
        errs,
        windowMin: Math.round(WINDOW_MS / 60000),
      }),
    );
    return;
  }

  const triggerAlert = FORCE_ALERT || (total >= MIN_EVENTS && ratio >= ALERT_RATIO);
  const category = triggerAlert ? 'ALERT' : 'REPORT';

  const sigMedWall = median(sig.wallMs);
  const mtmMedWall = median(mtm.wallMs);
  const sigMedBps = median(sig.bps);
  const mtmMedBps = median(mtm.bps);

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      category,
      total,
      errs,
      ratio: +ratio.toFixed(4),
      sendTelegram: SEND_TELEGRAM,
      signalLab: { total: sig.total, errs: sig.errs, medWallMs: sigMedWall, medBps: sigMedBps },
      mtmShadow: { total: mtm.total, errs: mtm.errs, medWallMsAlt: mtmMedWall, medBpsPrimaryAlt: mtmMedBps },
      uniqueMints: sig.mints.size + mtm.mints.size,
    }),
  );

  if (!SEND_TELEGRAM) {
    return;
  }

  const lines = [];
  lines.push(
    `Jupiter (lite-api, бесплатный канал): за ${Math.round(WINDOW_MS / 60000)}m событий ${total}, ошибок ${errs} (${fmt(ratio)}). Уник. mint: ${sig.mints.size + mtm.mints.size}.`,
  );
  lines.push(
    `signal-lab (pre buy_open): ${sig.total} событий, ошибок ${sig.errs} (${sig.total ? fmt(sig.errs / sig.total) : '0%'}); медиана wallMs=${sigMedWall ?? 'н/д'}, медиана |PG−Jup| bps=${sigMedBps ?? 'н/д'}.`,
  );
  lines.push(
    `mtm-shadow (open tracker): ${mtm.total} событий, ошибок ${mtm.errs} (${mtm.total ? fmt(mtm.errs / mtm.total) : '0%'}); медиана wallMs alt=${mtmMedWall ?? 'н/д'}, медиана |primary−alt| bps=${mtmMedBps ?? 'н/д'}.`,
  );
  lines.push(
    `Источники: ${SIGNAL_PATH}; ${MTM_PATH}.`,
  );

  const text = lines.join('\n');
  const ok = await sendTelegramTagged(category, 'jupiter-shadow', text);
  if (!ok) {
    console.error('telegram send failed (token/chat missing or quiet-hours for non-ALERT)');
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), err: String(e?.message || e) }));
  process.exit(1);
});
