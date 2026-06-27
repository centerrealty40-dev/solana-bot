import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBscPulseForDashboard } from '../scripts-tmp/bscpulse-dashboard.js';

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
});

describe('loadBscPulseForDashboard', () => {
  it('parses live_open, live_close, filter_reject', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bscp-dash-'));
    const fp = path.join(tmpDir, 'journal.jsonl');
    const base = Date.now() - 120_000;
    fs.writeFileSync(
      fp,
      [
        JSON.stringify({
          type: 'filter_reject',
          kind: 'eval-skip-open',
          reason: 'not_large_cap',
          token: '0xabc123',
          ts: new Date(base).toISOString(),
        }),
        JSON.stringify({
          type: 'live_open',
          kind: 'open',
          token: '0xabc123',
          spotPxUsd: 0.001,
          positionUsd: 10,
          dropPct: 5.2,
          txHash: '0xopen',
          ts: base + 1000,
        }),
        JSON.stringify({
          type: 'live_close',
          kind: 'close',
          token: '0xabc123',
          exitReason: 'kill',
          pnlPct: -8,
          pnlUsd: -0.8,
          ts: base + 2000,
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const r = loadBscPulseForDashboard(fp);
    expect(r.open.length).toBe(0);
    expect(r.closed.length).toBe(1);
    expect(r.closed[0]!.exitReason).toBe('kill');
    expect(r.evals1h).toBeGreaterThanOrEqual(1);
    expect(r.failReasons.some((f) => f.reason === 'not_large_cap')).toBe(true);
  });
});
