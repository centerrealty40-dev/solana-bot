import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const PAPER2_DIR = process.env.PAPER2_DIR || '/opt/solana-alpha/data/paper2';
const MAX_STALE_MIN = Number(process.env.PAPER2_MAX_STALE_MIN || 20);
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

function fileLastTs(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const st = fs.statSync(filePath);
  return st.mtimeMs || null;
}

import { sendTagged } from '../scripts/lib/telegram.mjs';

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
    const ts = fileLastTs(fp);
    const id = path.basename(fp, '.jsonl');
    if (!ts) {
      stale.push({ id, ageMin: null });
      continue;
    }
    const ageMin = (now - ts) / 60000;
    if (ageMin > MAX_STALE_MIN) stale.push({ id, ageMin });
    else ok.push({ id, ageMin });
  }

  const summary = {
    now: new Date(now).toISOString(),
    paper2Dir: PAPER2_DIR,
    maxStaleMin: MAX_STALE_MIN,
    total: files.length,
    ok: ok.length,
    stale: stale.length,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (stale.length > 0) {
    const details = stale
      .map((s) => `- ${s.id}: ${s.ageMin === null ? 'no mtime' : `${s.ageMin.toFixed(1)}m stale`}`)
      .join('\n');
    const text = `paper2 health ALERT\n` +
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
    await sendTelegram(`paper2 health OK\n${ok.length}/${files.length} active\n${okTop}`.slice(0, 3900));
  } else {
    console.log(`paper2 health OK (telegram suppressed): ${ok.length}/${files.length} active`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
