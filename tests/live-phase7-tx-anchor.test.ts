import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectRecentConfirmedTxSignatures } from '../src/live/reconcile-tx-anchor-sample.js';

describe('collectRecentConfirmedTxSignatures', () => {
  let tmpDir: string | null = null;
  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('returns newest-first unique signatures for this strategy', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-tx-'));
    const fp = path.join(tmpDir, 'live.jsonl');
    const sigOld = 'a'.repeat(88);
    const sigMid = 'b'.repeat(88);
    const sigNew = 'c'.repeat(88);
    const lines = [
      JSON.stringify({
        ts: 1,
        strategyId: 'live-oscar',
        channel: 'live',
        liveSchema: 1,
        kind: 'execution_result',
        intentId: '00000000-0000-4000-8000-000000000001',
        status: 'confirmed',
        txSignature: sigOld,
      }),
      JSON.stringify({
        ts: 2,
        strategyId: 'other',
        channel: 'live',
        liveSchema: 1,
        kind: 'execution_result',
        intentId: '00000000-0000-4000-8000-000000000002',
        status: 'confirmed',
        txSignature: 'x'.repeat(88),
      }),
      JSON.stringify({
        ts: 3,
        strategyId: 'live-oscar',
        channel: 'live',
        liveSchema: 1,
        kind: 'execution_result',
        intentId: '00000000-0000-4000-8000-000000000003',
        status: 'confirmed',
        txSignature: sigMid,
      }),
      JSON.stringify({
        ts: 4,
        strategyId: 'live-oscar',
        channel: 'live',
        liveSchema: 1,
        kind: 'execution_result',
        intentId: '00000000-0000-4000-8000-000000000004',
        status: 'confirmed',
        txSignature: sigNew,
      }),
      JSON.stringify({
        ts: 5,
        strategyId: 'live-oscar',
        channel: 'live',
        liveSchema: 1,
        kind: 'execution_result',
        intentId: '00000000-0000-4000-8000-000000000005',
        status: 'confirmed',
        txSignature: sigNew,
      }),
    ];
    fs.writeFileSync(fp, `${lines.join('\n')}\n`, 'utf8');

    const got = collectRecentConfirmedTxSignatures({
      storePath: fp,
      strategyId: 'live-oscar',
      limit: 5,
      maxFileBytes: 2_000_000,
    });
    expect(got).toEqual([sigNew, sigMid, sigOld]);
  });
});
