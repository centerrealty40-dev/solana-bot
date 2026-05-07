/** Paper Oscar IDEALIZED stack (v2.1 / v2.2): общая логика выходов; live-oscar не трогаем. */
export const PAPER_OSCAR_V21_STRATEGY_ID = 'paper-oscar-v21';
/** Более рискованный вход (мягче ликвидность / холдеры / объёмы), те же выходы что v2.1. */
export const PAPER_OSCAR_V22_STRATEGY_ID = 'paper-oscar-v22';
/** Бумага: паритет выходов/режимов с Live Oscar; вход ослаблен как у V2.2 (`paper-oscar-v22`). */
export const PAPER_OSCAR_RISKY_STRATEGY_ID = 'paper-oscar-risky';

export function isPaperOscarIdealizedStackStrategyId(strategyId: string): boolean {
  return strategyId === PAPER_OSCAR_V21_STRATEGY_ID || strategyId === PAPER_OSCAR_V22_STRATEGY_ID;
}

/** Вторая нога scale-in по `LIVE_ENTRY_SCALE_IN_*` + `readPaperOscarScaleInEnv` (без live-процесса). */
export function usesPaperOscarSecondLegScaleIn(strategyId: string): boolean {
  return (
    strategyId === PAPER_OSCAR_V21_STRATEGY_ID ||
    strategyId === PAPER_OSCAR_V22_STRATEGY_ID ||
    strategyId === PAPER_OSCAR_RISKY_STRATEGY_ID
  );
}
