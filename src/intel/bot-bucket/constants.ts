/** W6.10 — umbrella и правила слоя B (`wallet_tags.source`, ≤32 символов). */
export const SOURCE_BOT_UMBRELLA_V0 = 'bot_umbrella_v0' as const;
export const SOURCE_BOT_RULE_SWAP_BURST_V0 = 'bot_rule_swap_burst_v0' as const;
export const SOURCE_BOT_RULE_MANY_MINTS_V0 = 'bot_rule_many_mints_v0' as const;
export const SOURCE_BOT_RULE_FLOW_FANOUT_V0 = 'bot_rule_flow_fanout_v0' as const;

export const TAG_BOT = 'bot' as const;

/**
 * Proposal — вторичные теги под зонтиком `bot` (ещё не пишутся в wallet_tags):
 *
 * - `bot_hf_swap` — BOT_RULE_SWAP_BURST + median_gap_sec ≤ N (напр. ≤5) и swap_cnt высокий.
 * - `bot_spray_mints` — BOT_RULE_MANY_MINTS + distinct_mints выше порога при низком avg_trade_usd.
 * - `bot_sol_hub` — BOT_RULE_FLOW_FANOUT + distinct_targets выше верхнего квантиля (крупный распределитель).
 * - `bot_combo_full` — все три source одновременно на кошельке.
 * - Исключить/отметить адреса вида `pump:*` как bonding-surface, не user-wallet (отдельный тег или фильтр).
 *
 * Реализация: расширить persist после стабилизации порогов; истина — JSON context у строк с tag=bot.
 */
