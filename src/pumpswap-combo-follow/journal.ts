import type { PumpswapComboFollowConfig } from './config.js';
import { toComboExecutorConfig } from './config.js';
import { appendComboEvent } from '../pumpswap-combo/journal.js';

export function appendFollowEvent(
  cfg: PumpswapComboFollowConfig,
  body: Record<string, unknown>,
): void {
  appendComboEvent(toComboExecutorConfig(cfg), body);
}
