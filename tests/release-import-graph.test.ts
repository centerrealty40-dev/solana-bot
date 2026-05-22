import { describe, expect, it } from 'vitest';
import {
  collectRelativeImportSpecs,
  resolveImportFile,
} from '../scripts/release/import-graph-lib.mjs';

describe('release import graph', () => {
  it('collects relative import specs', () => {
    const src = `
      import { x } from '../pricing/mcap-snapshot.js';
      import './local-helper.ts';
    `;
    const specs = collectRelativeImportSpecs(src);
    expect(specs).toContain('../pricing/mcap-snapshot.js');
    expect(specs).toContain('./local-helper.ts');
  });

  it('resolves mcap-snapshot import from jupiter-spot-refresh', () => {
    const target = resolveImportFile(
      'src/papertrader/discovery/jupiter-spot-refresh.ts',
      '../pricing/mcap-snapshot.js',
    );
    expect(target).toBe('src/papertrader/pricing/mcap-snapshot.ts');
  });
});
