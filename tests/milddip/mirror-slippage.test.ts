import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const loopSource = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
const liveExecSource = readFileSync(resolve('src/copytrader/live-exec.ts'), 'utf8');

describe('mirror execution slippage escalation', () => {
  it('passes the mirror escalation envelope to add buys and ladder sells', () => {
    expect(loopSource).toContain("kind: 'add'");
    expect(loopSource).toContain('slippageRetryMultiplier: g.executionSlippageMultiplier');
    expect(loopSource).toContain(
      'slippageRetryMaxBps: cfg.leaderMirror.executionSlippageMaxBps',
    );
    expect(loopSource).toContain(
      'slippageRetryMultiplier: cfg.leaderMirror.executionSlippageMultiplier',
    );
  });

  it('requotes after Jupiter 6001 using the configured multiplicative cap', () => {
    expect(liveExecSource).toContain('isSlippageClassSimError(lastReason)');
    expect(liveExecSource).toContain('multiplySlippageBps');
    expect(liveExecSource).toContain('args.slippageRetryMaxBps');
  });
});
