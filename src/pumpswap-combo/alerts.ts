import { sendTagged } from '../core/telegram/sender.js';
import {
  OPERATOR_TELEGRAM_CHAT_ID,
  resolveOperatorTelegramBotToken,
} from '../core/telegram/resolve-operator-telegram.js';
import type { PumpswapComboConfig } from './config.js';

/** Канал «Новости для Тебя» — тот же OPERATOR_TELEGRAM_CHAT_ID, что live-oscar. */
export async function alertComboTradeLoss(
  cfg: PumpswapComboConfig,
  args: { mint: string; symbol: string; pnlUsd: number; exitReason: string },
): Promise<void> {
  if (args.pnlUsd >= 0 || Math.abs(args.pnlUsd) < cfg.lossAlertUsd) return;
  await sendTagged(
    'ALERT',
    'pumpswap_combo_loss',
    [
      `pumpswap-combo убыток $${args.pnlUsd.toFixed(2)}`,
      `${args.symbol} ${args.mint.slice(0, 8)}…`,
      `reason: ${args.exitReason}`,
      `leg=$${cfg.legUsd} portfolioSL=$${cfg.portfolioStopLossUsd}`,
    ].join('\n'),
    {
      skipQuietHours: true,
      telegramChatId: OPERATOR_TELEGRAM_CHAT_ID,
      telegramBotToken: resolveOperatorTelegramBotToken('TELEGRAM_BOT_TOKEN'),
    },
  );
}
