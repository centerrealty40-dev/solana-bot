import { config } from '../core/config.js';
import { sendTelegram } from '../runner/telegram.js';

/**
 * Quick smoke test for the Telegram channel.
 * Usage: npm run telegram:test
 */
async function main(): Promise<void> {
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.error('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is not set in .env');
    process.exit(1);
  }
  await sendTelegram(
    `✅ *sa-runner Telegram link OK*\nMode: ${config.executorMode.toUpperCase()}\nIf you see this, alerts will arrive on every trade.`,
  );
  console.log('Test message dispatched. Check your Telegram.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
