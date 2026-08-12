import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('1.11.824 leader seeds order the scan queue', () => {
  const eco = readFileSync(resolve('ecosystem.config.cjs'), 'utf8');
  const discover = readFileSync(resolve('src/milddip/discover.ts'), 'utf8');

  it('leaders is an enabled discovery source', () => {
    expect(eco).toContain("MILD_DIP_DISCOVER_SOURCES: 'stream,boosts,profiles,leaders'");
  });

  it('the enrich budget now uses the Dex headroom it was leaving idle', () => {
    // 1.11.824 kept this at 12 for fear of starving other consumers behind the
    // Dex gate. Measured since: at 30 mints per request against a 120 RPM
    // ceiling the batch path carries 3_600 mints a minute and we were scanning
    // 35, which is why we held a record within ±5s of a leader buy only 13.4%
    // of the time. 60 per pass at 3s is ~40 requests a minute.
    expect(eco).toContain("MILD_DIP_ENRICH_MAX: '60'");
    expect(eco).toContain("DEXSCREENER_GLOBAL_MAX_RPM: '120'");
    // And the scan no longer drops to a 15s cadence the moment a bag is open.
    expect(eco).toContain("MILD_DIP_SCAN_INTERVAL_WITH_OPENS_MS: '3000'");
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
