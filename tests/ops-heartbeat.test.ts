import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  opsHeartbeatPath,
  startOpsHeartbeat,
  writeOpsHeartbeat,
} from '../src/core/ops-heartbeat.js';

describe('ops-heartbeat', () => {
  it('writes heartbeat file with ts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hb-'));
    const prev = process.env.OPS_HEARTBEAT_DIR;
    process.env.OPS_HEARTBEAT_DIR = dir;
    try {
      writeOpsHeartbeat('test-app', { open: 2 });
      const raw = fs.readFileSync(path.join(dir, 'test-app.json'), 'utf8');
      const j = JSON.parse(raw);
      expect(j.app).toBe('test-app');
      expect(j.open).toBe(2);
      expect(typeof j.ts).toBe('number');
    } finally {
      if (prev == null) delete process.env.OPS_HEARTBEAT_DIR;
      else process.env.OPS_HEARTBEAT_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startOpsHeartbeat uses default path', () => {
    expect(opsHeartbeatPath('live-oscar')).toContain('live-oscar.json');
    const stop = startOpsHeartbeat({ appName: 'x', intervalMs: 15_000 });
    stop();
  });
});
