import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function appendFileLogLine(logPath: string, line: string): void {
  const dir = dirname(logPath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
}
