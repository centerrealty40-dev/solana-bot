import fs from 'node:fs';
import path from 'node:path';
import type { PumpswapComboConfig } from './config.js';

export function appendComboEvent(cfg: PumpswapComboConfig, body: Record<string, unknown>): void {
  const dir = path.dirname(cfg.journalPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    ts: Date.now(),
    strategyId: cfg.strategyId,
    ...body,
  });
  fs.appendFileSync(cfg.journalPath, `${line}\n`, 'utf8');
}
