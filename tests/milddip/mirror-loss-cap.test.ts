import { describe, expect, it } from 'vitest';
import { applyMirrorSell, replayMirrorRealizedPnl } from '../../src/milddip/mirror-loss-cap.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('mirror realized loss cap accounting', () => {
  it('allocates cost by the executed sold-token fraction', () => {
    const partial = applyMirrorSell({
      costUsd: 100,
      tokens: 1_000,
      receivedUsd: 45,
      fraction: 0.5,
      tokenRawBefore: '1000',
      tokenRawSold: '400',
    });
    expect(partial.realizedPnlUsd).toBe(5);
    expect(partial.remainingCostUsd).toBe(60);
    expect(partial.remainingTokens).toBe(600);
  });

  it('replays cash legs and ignores failed executions', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-cap-')), 'journal.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ kind: 'copy_buy', mint: 'A', ok: true, usdcBefore: 100, usdcAfter: 50, tokenRaw: '1000' }),
      JSON.stringify({ kind: 'copy_sell', mint: 'A', ok: true, usdcBefore: 50, usdcAfter: 70, tokenRawBefore: '1000', tokenRawSold: '1000' }),
      JSON.stringify({ kind: 'copy_buy', mint: 'A', ok: false, usdcBefore: 70, usdcAfter: 60, tokenRaw: '100' }),
    ].join('\n'));
    expect(replayMirrorRealizedPnl(file)).toBe(-30);
  });
});
