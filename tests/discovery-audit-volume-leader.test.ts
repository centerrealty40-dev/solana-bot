import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createLiveDiscoveryAuditJournalAppend } from '../src/live/discovery-audit-jsonl.js';

const appended: Record<string, unknown>[] = [];

vi.mock('../src/live/store-jsonl.js', () => ({
  appendLiveJsonlEvent: (row: Record<string, unknown>) => {
    appended.push(row);
  },
}));

describe('live discovery audit volume-leader tier', () => {
  beforeEach(() => {
    appended.length = 0;
  });

  it('logs pass=true eval for volume-leader tier without whitelist', () => {
    const append = createLiveDiscoveryAuditJournalAppend(true);
    append({
      kind: 'eval',
      mint: '4ko5tSr5o3H4v1sFtjTSd9MPUW7yx5AFCpkNPoL6pump',
      symbol: 'TEST',
      lane: 'post_migration',
      source: 'pumpswap',
      pass: true,
      reasons: [],
      _volumeLeaderDiscovery: true,
      _priorityDiscovery: false,
      _liveDiscoveryDeepAudit: false,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.kind).toBe('live_discovery_eval');
    expect(appended[0]?.pass).toBe(true);
    expect(appended[0]?.volumeLeaderTier).toBe(true);
  });

  it('still skips pass=true for non-priority non-volume-leader mints', () => {
    const append = createLiveDiscoveryAuditJournalAppend(true);
    append({
      kind: 'eval',
      mint: 'SomeOtherMint123456789012345678901234',
      pass: true,
      reasons: [],
      _volumeLeaderDiscovery: false,
      _priorityDiscovery: false,
      _liveDiscoveryDeepAudit: false,
    });
    expect(appended).toHaveLength(0);
  });
});
