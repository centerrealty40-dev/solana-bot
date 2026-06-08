import fs from 'node:fs';
import path from 'node:path';
import type { PumpswapDipConfig } from './config.js';

export function appendPumpswapDipEvent(
  cfg: PumpswapDipConfig,
  event: Record<string, unknown>,
): void {
  const dir = path.dirname(cfg.journalPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    cfg.journalPath,
    `${JSON.stringify({ ts: Date.now(), strategyId: cfg.strategyId, ...event })}\n`,
    'utf8',
  );
}
