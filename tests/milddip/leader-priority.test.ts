import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('1.11.824 leader seeds order the scan queue', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const discover = readFileSync(resolve('src/milddip/discover.ts'), 'utf8');

  it('leaders is an enabled discovery source', () => {
    expect(eco).toContain("MILD_DIP_DISCOVER_SOURCES: 'stream,boosts,profiles,leaders'");
  });

  it('enrich budget is unchanged — this is ordering, not throughput', () => {
    // The failure mode we are avoiding: raising enrichMax starves everything
    // else behind the Dex gate.
    expect(eco).toContain("MILD_DIP_ENRICH_MAX: '12'");
  });

  it('seeds are pushed ahead of the generic sources', () => {
    const priorityAt = discover.indexOf('opts?.priorityMints ?? []');
    const leadersAt = discover.indexOf("sources.has('leaders')");
    const streamAt = discover.indexOf("sources.has('stream')");
    expect(priorityAt).toBeGreaterThan(-1);
    expect(leadersAt).toBeGreaterThan(priorityAt);
    if (streamAt > -1) expect(leadersAt).toBeLessThan(streamAt);
  });

  it('seed window and cap are the ones the gate was sized for', () => {
    expect(eco).toContain("MILD_DIP_LEADER_SEED_MAX: '250'");
    expect(eco).toContain("MILD_DIP_LEADER_SEED_MAX_AGE_MS: '7200000'");
  });
});
