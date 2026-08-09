import { describe, expect, it } from 'vitest';
import { isRunnerPartialExit } from '../../src/milddip/sell-partial.js';

describe('isRunnerPartialExit', () => {
  it('treats sleeve / bounce half-cuts as runner partials', () => {
    expect(isRunnerPartialExit(0.5)).toBe(true);
    expect(isRunnerPartialExit(0.4)).toBe(true);
    expect(isRunnerPartialExit(2 / 3)).toBe(true);
  });

  it('full exits are not partial', () => {
    expect(isRunnerPartialExit(1)).toBe(false);
    expect(isRunnerPartialExit(0)).toBe(false);
    expect(isRunnerPartialExit(-1)).toBe(false);
    expect(isRunnerPartialExit(Number.NaN)).toBe(false);
  });
});
