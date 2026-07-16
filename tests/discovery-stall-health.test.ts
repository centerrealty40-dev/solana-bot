import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  getDiscoveryStallStatus,
  markDiscoverySchedulerStarted,
  recordDiscoveryTickCompleted,
  shouldEmitDiscoveryStallAlert,
} from '../src/papertrader/discovery-health-window.js';

describe('discovery stall watchdog', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.LIVE_DISCOVERY_STALL_ALERT_ENABLED = '1';
    process.env.LIVE_DISCOVERY_STALL_ALERT_MS = '300000';
    process.env.LIVE_DISCOVERY_STALL_BOOT_GRACE_MS = '0';
    process.env.LIVE_DISCOVERY_STALL_ALERT_REPEAT_MS = '600000';
    markDiscoverySchedulerStarted(1_000_000);
    recordDiscoveryTickCompleted(1_000_000);
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it('not stalled while ticks complete within threshold', () => {
    const st = getDiscoveryStallStatus(1_000_000 + 60_000);
    expect(st.stalled).toBe(false);
  });

  it('stalled when no tick completion beyond threshold', () => {
    const st = getDiscoveryStallStatus(1_000_000 + 300_001);
    expect(st.stalled).toBe(true);
    expect(st.stallMs).toBeGreaterThanOrEqual(300_001);
  });

  it('shouldEmitDiscoveryStallAlert throttles repeat', () => {
    const t = 1_000_000 + 400_000;
    expect(shouldEmitDiscoveryStallAlert(t)).not.toBeNull();
    expect(shouldEmitDiscoveryStallAlert(t + 1_000)).toBeNull();
  });

  it('recordDiscoveryTickCompleted clears stall', () => {
    const stalledAt = 1_000_000 + 400_000;
    expect(getDiscoveryStallStatus(stalledAt).stalled).toBe(true);
    recordDiscoveryTickCompleted(stalledAt);
    expect(getDiscoveryStallStatus(stalledAt + 1_000).stalled).toBe(false);
  });
});
