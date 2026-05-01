import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged } from '../scripts/lib/telegram.mjs';

const PAPER2_DIR = process.env.PAPER2_DIR || '/opt/solana-alpha/data/paper2';
const MAX_STALE_MIN = Number(process.env.PAPER2_MAX_STALE_MIN || 20);
const TAIL_LINES = Number(process.env.PAPER2_HEALTH_TAIL_LINES || 1500);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const HEALTH_TELEGRAM_ON_ALERT = process.env.PAPER2_HEALTH_TELEGRAM_ON_ALERT !== '0';
const HEALTH_TELEGRAM_ON_OK = process.env.PAPER2_HEALTH_TELEGRAM_ON_OK === '1';

function listStrategyFiles() {
  if (!fs.existsSync(PAPER2_DIR)) return [];
  return fs
    .readdirSync(PAPER2_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(PAPER2_DIR, f))
    .sort();
}

function tailLastHeartbeatTs(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let buf;
  try {
    buf = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const lines = buf.split('\n');
  const start = Math.max(0, lines.length - TAIL_LINES);
  for (let i = lines.length - 1; i >= start; i--) {
    const ln = lines[i];
    if (!ln) continue;
    if (!ln.includes('"heartbeat"')) continue;
    try {
      const j = JSON.parse(ln);
      if (j && j.kind === 'heartbeat') {
        if (typeof j.ts === 'number') return j.ts;
        const fileTs = fs.statSync(filePath).mtimeMs;
        return fileTs || null;
      }
    } catch {
      // skip
    }
  }
  return null;
}

async function sendTelegram(text) {
  if (!HEALTH_TELEGRAM_ON_ALERT && !HEALTH_TELEGRAM_ON_OK) return;
  if (!BOT_TOKEN || !CHAT_ID) return;
  await sendTagged('HEALTH', 'platform', text);
}

async function main() {
  const now = Date.now();
  const files = listStrategyFiles();
  if (!files.length) {
    const msg = `paper2 health: no strategy files in ${PAPER2_DIR}`;
    console.log(msg);
    if (HEALTH_TELEGRAM_ON_ALERT) await sendTelegram(msg);
    process.exitCode = 1;
    return;
  }

  const stale = [];
  const ok = [];
  for (const fp of files) {
    const id = path.basename(fp, '.jsonl');
    const hbTs = tailLastHeartbeatTs(fp);
    if (!hbTs) {
      stale.push({ id, ageMin: null, reason: 'no_heartbeat_in_tail' });
      continue;
    }
    const ageMin = (now - hbTs) / 60000;
    if (ageMin > MAX_STALE_MIN) stale.push({ id, ageMin, reason: 'heartbeat_stale' });
    else ok.push({ id, ageMin });
  }

  const summary = {
    now: new Date(now).toISOString(),
    paper2Dir: PAPER2_DIR,
    maxStaleMin: MAX_STALE_MIN,
    metric: 'heartbeat',
    total: files.length,
    ok: ok.length,
    stale: stale.length,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (stale.length > 0) {
    const details = stale
      .map((s) =>
        `- ${s.id}: ${s.ageMin === null ? s.reason : `${s.ageMin.toFixed(1)}m stale (${s.reason})`}`,
      )
      .join('\n');
    const text =
      `paper2 health ALERT (heartbeat-based)\n` +
      `stale=${stale.length}/${files.length} (threshold ${MAX_STALE_MIN}m)\n\n${details}`;
    if (HEALTH_TELEGRAM_ON_ALERT) await sendTelegram(text.slice(0, 3900));
    process.exitCode = 1;
    return;
  }

  const okTop = ok
    .sort((a, b) => a.ageMin - b.ageMin)
    .slice(0, 8)
    .map((s) => `${s.id}:${s.ageMin.toFixed(1)}m`)
    .join(', ');
  if (HEALTH_TELEGRAM_ON_OK) {
    await sendTelegram(`paper2 health OK (heartbeat)\n${ok.length}/${files.length} active\n${okTop}`.slice(0, 3900));
  } else {
    console.log(`paper2 health OK (telegram suppressed): ${ok.length}/${files.length} active`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
