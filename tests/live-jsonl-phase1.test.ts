import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LIVE_SCHEMA_V1,
  LIVE_SCHEMA_V2,
  parseLiveEventBody,
  safeParseLiveEventBody,
  type LiveEventBody,
} from '../src/live/events.js';
import { newLiveIntentId } from '../src/live/intent.js';
import { appendLiveJsonlEvent, configureLiveStore, liveEventDefaultFsync } from '../src/live/store-jsonl.js';

const sampleIntent = '550e8400-e29b-41d4-a716-446655440000';

function mergeEnvelope(strategyId: string, body: LiveEventBody, ts = 1_700_000_000_000): Record<string, unknown> {
  return {
    ts,
    strategyId,
    channel: 'live',
    liveSchema: LIVE_SCHEMA_V1,
    ...body,
  };
}

describe('W8.0-p1 live JSONL contract', () => {
  it('parses every kind (round-trip shape)', () => {
    const bodies: LiveEventBody[] = [
      {
        kind: 'live_boot',
        liveStrategyEnabled: false,
        executionMode: 'dry_run',
        profile: 'oscar',
        phase: 'W8.0-p1',
      },
      { kind: 'live_shutdown', sig: 'SIGTERM' },
      {
        kind: 'heartbeat',
        uptimeSec: 1,
        openPositions: 0,
        closedTotal: 0,
        liveStrategyEnabled: false,
        executionMode: 'dry_run',
        note: 'test',
      },
      {
        kind: 'execution_attempt',
        intentId: sampleIntent,
        side: 'buy',
        mint: 'So11111111111111111111111111111111111111112',
        executionMode: 'dry_run',
        quoteSnapshot: {},
      },
      {
        kind: 'execution_result',
        intentId: sampleIntent,
        status: 'sim_ok',
        simulated: true,
        unitsConsumed: 120_000,
      },
      {
        kind: 'execution_skip',
        intentId: sampleIntent,
        reason: 'feature_not_implemented',
        detail: 'phase1',
      },
      { kind: 'execution_skip', reason: 'strategy_disabled' },
      {
        kind: 'risk_block',
        limit: 'max_open_positions',
        detail: { open: 5, max: 5 },
      },
      {
        kind: 'capital_skip',
        reason: 'insufficient_free_balance_no_positions',
        freeUsdEstimate: 5,
        requiredFreeUsd: 20,
        shortfallUsd: 15,
      },
      {
        kind: 'capital_rotate_close',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        unrealizedPnlUsd: 3.5,
        txSignature: null,
      },
      {
        kind: 'live_position_open',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'X' },
      },
      {
        kind: 'live_position_dca',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'X' },
      },
      {
        kind: 'live_position_partial_sell',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'X' },
      },
      {
        kind: 'live_position_close',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        closedTrade: { mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', exitTs: 1 },
      },
      {
        kind: 'live_exit_verify_defer',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        context: 'close',
        phase: 'escalate_proceed',
        consecutiveDefers: 60,
        verdictSummary: 'blocked:slip-too-high',
        exitReason: 'TIMEOUT',
      },
    ];
    for (const b of bodies) {
      const again = parseLiveEventBody(JSON.parse(JSON.stringify(b)));
      expect(again).toEqual(b);
      const line = JSON.stringify(mergeEnvelope('live-oscar', b));
      const row = JSON.parse(line) as Record<string, unknown>;
      expect(row.liveSchema).toBe(1);
      expect(row.channel).toBe('live');
      expect(parseLiveEventBody(row)).toEqual(b);
    }
  });

  it('rejects invalid intentId on execution_attempt', () => {
    const bad = safeParseLiveEventBody({
      kind: 'execution_attempt',
      intentId: 'not-a-uuid',
      side: 'buy',
      mint: 'So11111111111111111111111111111111111111112',
      executionMode: 'dry_run',
    });
    expect(bad.success).toBe(false);
  });

  it('newLiveIntentId parses as UUID v4', () => {
    const id = newLiveIntentId();
    expect(safeParseLiveEventBody({ kind: 'execution_attempt', intentId: id, side: 'sell', mint: 'm', executionMode: 'simulate' }).success).toBe(true);
  });

  it('liveEventDefaultFsync matches §7 basics', () => {
    expect(liveEventDefaultFsync({ kind: 'heartbeat', uptimeSec: 0, openPositions: 0, closedTotal: 0, liveStrategyEnabled: false, executionMode: 'dry_run' })).toBe(false);
    expect(liveEventDefaultFsync({ kind: 'live_boot', liveStrategyEnabled: false, executionMode: 'dry_run' })).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'execution_result',
        intentId: sampleIntent,
        status: 'sim_ok',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_position_open',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        openTrade: {},
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_exit_verify_defer',
        mint: 'Mintaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        context: 'partial_sell',
        phase: 'defer',
        consecutiveDefers: 1,
        verdictSummary: 'blocked:impact-too-high',
      }),
    ).toBe(true);
    expect(
      liveEventDefaultFsync({
        kind: 'live_reconcile_report',
        ok: true,
        reconcileStatus: 'skipped',
      }),
    ).toBe(true);
  });

  it('parses live_reconcile_report (liveSchema envelope 2 at write time)', () => {
    const body: LiveEventBody = {
      kind: 'live_reconcile_report',
      ok: false,
      reconcileStatus: 'mismatch',
      mode: 'block_new',
      mismatches: [{ mint: 'm1', expectedRaw: '10', actualRaw: '9' }],
      txAnchorSample: { checked: 2, notFound: [], rpcErrors: 0 },
    };
    expect(parseLiveEventBody(JSON.parse(JSON.stringify(body)))).toEqual(body);
    const row = {
      ts: 1,
      strategyId: 'live-oscar',
      channel: 'live',
      liveSchema: LIVE_SCHEMA_V2,
      ...body,
    };
    expect(row.liveSchema).toBe(LIVE_SCHEMA_V2);
    expect(parseLiveEventBody(row)).toEqual(body);
  });
});

describe('appendLiveJsonlEvent integration', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `live-p1-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    configureLiveStore({ storePath: tmp, strategyId: 'live-oscar' });
  });
  afterEach(() => {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  });

  it('writes validated line with envelope', () => {
    appendLiveJsonlEvent({
      kind: 'live_boot',
      liveStrategyEnabled: false,
      executionMode: 'dry_run',
      phase: 'test',
    });
    const line = fs.readFileSync(tmp, 'utf8').trim();
    const j = JSON.parse(line) as Record<string, unknown>;
    expect(j.kind).toBe('live_boot');
    expect(j.liveSchema).toBe(LIVE_SCHEMA_V1);
    expect(j.strategyId).toBe('live-oscar');
    expect(j.channel).toBe('live');
    expect(typeof j.ts).toBe('number');
  });

  it('writes live_reconcile_report with liveSchema 2', () => {
    appendLiveJsonlEvent({
      kind: 'live_reconcile_report',
      ok: true,
      reconcileStatus: 'ok',
    });
    const line = fs.readFileSync(tmp, 'utf8').trim();
    const j = JSON.parse(line) as Record<string, unknown>;
    expect(j.kind).toBe('live_reconcile_report');
    expect(j.liveSchema).toBe(LIVE_SCHEMA_V2);
  });

  it('skips invalid payloads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appendLiveJsonlEvent({ kind: 'heartbeat' });
    expect(fs.existsSync(tmp)).toBe(false);
    warn.mockRestore();
  });
});
