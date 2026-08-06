import { afterEach, describe, expect, it } from 'vitest';
import {
  bootstrapVolGreenEnv,
  VOL_GREEN_DEFAULT_WALLET_PUBKEY,
} from '../../src/volgreen/bootstrap-env.js';

const KEYS = [
  'MILD_DIP_ENTRY_MODE',
  'MILD_DIP_WALLET_PUBKEY',
  'MILD_DIP_JOURNAL_PATH',
  'MILD_DIP_MIN_DIP_PCT',
  'MILD_DIP_MAX_DIP_PCT',
  'MILD_DIP_EXIT_GIVEBACK_PCT',
  'MILD_DIP_MAX_ENRICH',
  'VOL_GREEN_POSITION_USD',
  'MILD_DIP_POSITION_USD',
  'VOL_GREEN_ENTRY_MODE',
];

describe('bootstrapVolGreenEnv', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete saved[k];
    }
  });

  function stash(k: string): void {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }

  it('defaults to green_tape entry + FxQf wallet + mild-dip exit widths', () => {
    for (const k of KEYS) stash(k);
    bootstrapVolGreenEnv(process.env);
    expect(process.env.MILD_DIP_ENTRY_MODE).toBe('green_tape');
    expect(process.env.MILD_DIP_WALLET_PUBKEY).toBe(VOL_GREEN_DEFAULT_WALLET_PUBKEY);
    expect(process.env.MILD_DIP_JOURNAL_PATH).toContain('volgreen');
    expect(process.env.MILD_DIP_EXIT_GIVEBACK_PCT).toBe('6');
    expect(process.env.MILD_DIP_MAX_ENRICH).toBe('16');
  });

  it('maps VOL_GREEN_POSITION_USD into MILD_DIP_POSITION_USD', () => {
    for (const k of KEYS) stash(k);
    process.env.VOL_GREEN_POSITION_USD = '5';
    bootstrapVolGreenEnv(process.env);
    expect(process.env.MILD_DIP_POSITION_USD).toBe('5');
  });
});
