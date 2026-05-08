/**
 * Smoke-test: отправить два сообщения тем же ботом/чатом, что и whitelist-алерты live-oscar.
 * Запуск на VPS из корня репо:
 *   cd /opt/solana-alpha && set -a && . ./.env && set +a && npx tsx scripts-tmp/live-whitelist-telegram-ping.ts
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { sendTagged } from '../src/core/telegram/sender.js';

function fromEcosystem(name: string): string | undefined {
  try {
    const p = path.join(process.cwd(), 'ecosystem.config.cjs');
    const s = fs.readFileSync(p, 'utf8');
    const re = new RegExp(`${name}:\\s*['"]([^'"]+)['"]`);
    const m = s.match(re);
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const telegramBotToken =
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN?.trim() ||
    fromEcosystem('LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN');
  const telegramChatId =
    process.env.LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID?.trim() ||
    fromEcosystem('LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID') ||
    process.env.TELEGRAM_CHAT_ID?.trim();
  if (!telegramBotToken || !telegramChatId) {
    console.error(
      'Need LIVE_MINT_WHITELIST_TELEGRAM_BOT_TOKEN (or ecosystem) and TELEGRAM_CHAT_ID (or LIVE_MINT_WHITELIST_TELEGRAM_CHAT_ID)',
    );
    process.exit(1);
  }
  const demoMint = 'So11111111111111111111111111111111111111112';
  const demoSym = 'WSOL/ping';
  const gmgnUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(demoMint)}`;

  const o = { telegramBotToken, telegramChatId, skipQuietHours: true as const };
  await sendTagged(
    'ADVICE',
    'live_whitelist_miss',
    `Тест (ping): кандидат прошёл гейты, но mint не в whitelist.\nsymbol: ${demoSym}\nmint: ${demoMint}\nGMGN: ${gmgnUrl}`,
    o,
  );
  await sendTagged(
    'ALERT',
    'live_whitelist_consec_loss_drop',
    `Тест (ping): монета удалена из whitelist после N подряд убыточных сделок.\nsymbol: ${demoSym}\nmint: ${demoMint}\nGMGN: ${gmgnUrl}`,
    o,
  );
  console.log('OK: sent ADVICE+ALERT test messages via whitelist bot (skipQuietHours)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
