import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('stream leader-known watch (1.11.930)', () => {
  it('shouldSampleStreamPrice keeps leaderSeenMints on stream tape', () => {
    const src = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(src).toContain('leaderEverSeenInState');
    expect(src).toMatch(
      /function shouldSampleStreamPrice\(\s*cfg: MildDipConfig/,
    );
  });

  it('rememberLeaderSeen re-notes hot mints', () => {
    const src = readFileSync(resolve('src/milddip/loop.ts'), 'utf8');
    expect(src).toContain('mildDipHotMints.note(h.mint');
  });

  it('leader observer priority dex on buy path', () => {
    const src = readFileSync(resolve('scripts/milddip/leader-observer.py'), 'utf8');
    expect(src).toContain('priority: bool = False');
    expect(src).toContain('fetch_dex(mint, priority=True)');
  });
});
