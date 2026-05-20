# scripts-tmp/ audit — 2026-05-20

## Что есть сейчас

- Всего файлов: **140** (mjs: 74, sh: 20, ts: 28, py: 4, прочее: 14).
- Из них в проде через PM2 (`ecosystem.config.cjs`): **13**.
- Используется в `package.json` как npm-скрипт: **27** (с пересечениями).
- Импортируется из `src/` или `scripts/`: **6**.
- Не используется нигде, последний git-touch старше 14 дней: **~95**.

## Категория A — KEEP, продакшен (трогать нельзя в этом этапе)

PM2-процессы и их зависимости:
- `pumpswap-collector.mjs`
- `raydium-collector.mjs`
- `meteora-collector.mjs`
- `orca-collector.mjs`
- `moonshot-collector.mjs`
- `paper2-open-snapshot-enrich.mjs` (импортируется коллекторами)
- `sa-wallet-orchestrator.mjs`
- `wallet-orchestrator-lib.mjs` (импортируется orchestrator-ом)
- `jupiter-route-watcher.mjs`
- `direct-lp-detector.mjs`
- `snapshot-freshness-watch.mjs`
- `collector-log-watch.mjs`
- `live-oscar-universal-strategy-v2.ts` (через tsx, основной live-oscar)
- `dashboard-server.ts` (live-oscar-dashboard)

## Категория B — KEEP, npm-скрипты (вызываются вручную, но живые)

Аналитика и health-check (используются в `package.json`):
- `paper2-healthcheck.mjs`, `paper2-advisor.mjs`
- `paper2-diagnose-dip-recovery.ts`, `paper2-diagnose-holders-gpa.mjs`
- `live-chain-pnl-audit.ts`, `live-reentry-exit-price-gap-counterfactual.ts`
- `live-oscar-universal-strategy-grid.ts`, `live-oscar-killstop-golden-sweep.ts`
- `live-oscar-retrace-pnl-vs-prev-fill.ts`
- `analyze-kill-sl-roots.mjs`, `post-trade-compare-strategies.mjs`
- `collector-http-budget.mjs`, `collector-profile-once.mjs`
- `hourly-telegram-report.mjs`, `advisor-digest.mjs`
- `jupiter-shadow-hourly.mjs`, `jupiter-shadow-watch.mjs`
- `sa-qn-budget-check.mjs`, `sa-qn-global-report.mjs`, `sa-qn-global-budget-lib.mjs`, `sa-qn-json-rpc.mjs`
- `sa-grws-collector.mjs`, `sa-grws-analytics.mjs`, `sa-grws-pilot-diagnose.mjs`
- `post-mortem-paper-v1.mjs`
- `restore-from-r2-chunks.sh`, `backup-db-r2-api.sh` (R2 backups)

## Категория C — ARCHIVE, исследования и одноразовые отчёты

Старые backtest-исследования (могут пригодиться для повторного запуска, но не нужны в живом репо):
- `live-oscar-killstop-drawdown-grid.ts`, `live-oscar-dca-killstop-analysis.ts`,
  `live-oscar-strategy-mega-grid.ts`, `live-oscar-simple-kill-averaging-sweep.ts`,
  `live-oscar-touch-dca-vs-kill-birdeye.ts`, `live-oscar-max-drawdown-from-avg-report.ts`,
  `live-oscar-dip-min-counterfactual-all.ts`, `live-oscar-volatility-vs-pnl-diagnostic.ts`,
  `live-oscar-killstop-counterfactual-thresholds.mjs`, `live-oscar-watchdog.mjs`
- `mint-entry-grid-research.ts`, `report-live-opens-vs-wallet.ts`
- `_swing_corridor_param_grid.py`, `_swing_corridor_multi_backtest.py`
- `_troll_corridor_backtest.py`, `_troll_full_backtest.py`, `_troll_envelope_sim.py`
- `_wave_b_backtest_v2.py`, `_altszn_trail.py`
- `_babytroll_*.py` (4 файла), `_spcx_*.py` (5 файлов), `_vps_spcx_*.py` (3 файла)

Куда: `archive/scripts-tmp/2026-05-pre-refactor/` (или вне git, если место берегём).

## Категория D — DELETE, мусор и дубликаты диагностики

Сделанные мной этим вечером и за последние недели одноразовые скрипты:
- Сегодня (можно удалять): `_audit_pm2.sh`, `_audit_scripts_tmp.sh`,
  `_collectors_revive.sh`, `_collector_once_test.sh`, `_snapshot_stale_diag*.sh` (4 файла),
  `_worlcup_dip_1805.mjs`, `_verify_wl_enrich_fix.mjs`, `_probe_toes_*.mjs` (8 файлов)
- Старые: `_dip_funnel_probe.mjs`, `_dip_funnel_v2.mjs`, `_kinds_probe.mjs`,
  `_no_buys_probe.mjs`, `_recent_pg_eval.mjs`, `_pg_state_probe.sh`,
  `_runner_*` (3 файла), `_post_deploy_check.mjs`, `_post_deploy_env_check.sh`,
  `_verify_deploy.sh`, `_find_pg_env.sh`, `_check_schema.sh`,
  `_journal_mcap_probe.mjs`, `_count_trades_per_mint.mjs`,
  `_export_*.sh` (3 файла), `_run_triplet_price.sh`, `_triplet_*` (3 файла),
  `_buy_attempts_8h.py`, `_sim_err_breakdown.py`, `_wl_near_entry_rank.py`,
  `_analytics_probe.mjs`, `_exec_probe*.mjs` (3 файла)
- VPS one-off скрипты: `_vps_closed_ladder_report2.py`, `_vps_mcap_at_buy.sh`,
  `_vps_remove_mint_from_deny.sh`, `_vps_restore_troll_whitelist.sh`,
  `_vps_troll_staged_check.py`, `_vps_wl_eval_last3h.py`,
  `_vps_dip_bot_*.sh` (3 файла), `_vps_pg_load_snapshot.sh`,
  `_vps_setup_botadmin_ssh.sh` (если уже применён)

Итого к удалению: **~60–70 файлов**. Все — в git history останутся, при необходимости поднимутся `git show <hash>:<path>`.

## Категория E — UNCLEAR, требует решения

- `live-whitelist-telegram-ping.ts` (была демонстрация, не подключена)
- `paper2-full-analysis-batch.sh` (когда-то использовали для отчётов)
- `archive-pt1-oscar-journal.sh` (ротация лога — возможно, подключить в cron)
- `read-risky-wallet-pubkey.cjs` (одноразовый ритуал)
- `diag-oscar-triple-strategy-compare.ts`, `diag-sim-buy-logs.ts` (диагностика)
- `_grws-pilot-measure.sh`, `server-fee-sample.py`, `server-live-journal-audit.py`

## Предложение по этапу 1 → 2

1. Переименовать `scripts-tmp/` → создать **`src/collectors/`** для категории A (PM2 продакшен).
2. Сохранить `scripts-tmp/` для категории B (npm-скрипты, ad-hoc CLI).
3. Категорию C — в `archive/scripts-tmp/2026-05-pre-refactor/` либо в `.gitignore` + сохранить локально.
4. Категорию D — `git rm`.
5. Категория E — на отдельный проход после ревью.

Минимально-инвазивно: A и D в одном коммите, B остаётся, C вынести отдельным коммитом.

## Что НЕ делаю в этом этапе

- Не правлю `src/`.
- Не трогаю `ecosystem.config.cjs` (только когда переношу A — пути обновлю в одном коммите).
- Не правлю `package.json` (только когда переношу B-файлы; B пока не переносим).
- Не правлю env-параметры (это Этап 3).
