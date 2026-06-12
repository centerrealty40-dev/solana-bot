import { describe, it, expect } from 'vitest';

import {
  buildMintFileWatchTelegramText,
  formatMintListHtml,
  resolveMintDisplayLabel,
  shortMintLabel,
} from '../src/live/mint-file-watch-telegram-format.js';

const MINT = 'E6ifp2mJy8cYQehUGUtFvrXriRKxRuonLmrvTFypump';

describe('mint-file-watch telegram format', () => {
  it('shortMintLabel uses 8…4 fallback', () => {
    expect(shortMintLabel(MINT)).toBe('E6ifp2mJ…pump');
  });

  it('resolveMintDisplayLabel prefers symbol', () => {
    expect(resolveMintDisplayLabel(MINT, 'SPCX')).toBe('SPCX');
    expect(resolveMintDisplayLabel(MINT, null)).toBe('E6ifp2mJ…pump');
  });

  it('formatMintListHtml embeds GMGN link with symbol label', () => {
    const symbols = new Map([[MINT, 'SPCX']]);
    const html = formatMintListHtml([MINT], symbols);
    expect(html).toContain(`<a href="https://gmgn.ai/sol/token/${MINT}">SPCX</a>`);
  });

  it('buildMintFileWatchTelegramText for denylist change', () => {
    const symbols = new Map([[MINT, 'SPCX']]);
    const text = buildMintFileWatchTelegramText({
      kind: 'denylist',
      absPath: '/opt/solana-alpha/data/live/live-oscar-permanent-denylist.txt',
      total: 4,
      added: [MINT],
      removed: [],
      symbols,
    });
    expect(text).toContain('Файл denylist обновлён.');
    expect(text).toContain('Добавлено (1):');
    expect(text).toContain('>SPCX</a>');
    expect(text).toContain('Удалено (0): —');
  });
});
