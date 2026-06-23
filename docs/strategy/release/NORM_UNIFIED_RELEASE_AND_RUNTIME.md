# Единый норматив: параллельные агенты, версия продукта, GitHub, локальный диск и прод-сервер

**Статус:** обязательный сводный документ для всей цепочки «код → GitHub → прод».  
**Репозиторий:** каноническая копия для **`solana-bot`** лежит **в этом каталоге** (`docs/strategy/release/`).  
**Не отменяет:** детальные инварианты в [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) и [`PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md) — при расхождении по **деплою на VPS** приоритет у **§5 настоящего документа**.

**Зачем файл:** устраняется противоречие между нормативом «прод = конкретный SHA из Git» и практикой «залить каталог через `scp`». Второе ломает **`npm ci`**, **`package-lock.json`** и **`git pull`** на VPS.

---

## 1. Иерархия источников правды

| Уровень | Что считается правдой | Запрещено |
|--------|------------------------|-----------|
| **GitHub** | Ветка интеграции (**`v2`**) и **коммит SHA**, прошедший CI | Публиковать в прод изменения без записи в Git |
| **Локальный диск** | Рабочая копия; ветки **`task/*`** / согласованные с интегратором | Прод без push в интеграционную ветку |
| **VPS (`/opt/solana-alpha`)** | **Клон Git**; **`HEAD` = заданный SHA** | «Смесь» ручных правок и файлов, скопированных мимо `git` поверх клона |

**Инвариант VPS-Git:** после деплоя **`git rev-parse HEAD`** на сервере совпадает с ожидаемым SHA; **`git status`** чистый для отслеживаемых файлов (политика игноров — по команде).

---

## 2. Параллельные агенты и локальный диск

1. Роли **исполнитель / интегратор**, слоты **`task/agent-n-*`**, **`git worktree`** — см. [`PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md).
2. Исполнитель **не** меняет [`VERSION`](./VERSION) и релизный [`CHANGELOG.md`](./CHANGELOG.md) (**I7** в [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md)).
3. Интегратор: **`git fetch origin`**, **`v2` = `origin/v2`**, один bump, один push, **один** деплой на этот SHA.

---

## 3. Версионирование продукта (semver)

[`VERSION`](./VERSION), [`CHANGELOG.md`](./CHANGELOG.md), MAJOR/MINOR/PATCH — см. [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) §4.  
**CI:** `package.json` и **`package-lock.json`** всегда в синхроне; после смены зависимостей — локально **`npm install`** и коммит lock-файла.

---

## 4. GitHub

Ветка **`v2`**, проверки **`npm run typecheck`**, **`npm run check:hygiene`**, перед push в **`v2`** — **`npm run check:hygiene:integration`** (**I6**). Зелёный CI на SHA — критерий готовности к деплою (если не оговорено исключение).

### 4.1 Branch protection и роли (рекомендуемая политика)

| Элемент | Рекомендация |
|---------|----------------|
| Ветка **`v2`** | Включить **branch protection**: обязательный **CI** (required status checks) перед merge. |
| Прямой push | По возможности **запретить** прямой push в **`v2`**; изменения через **PR**. |
| Force-push | **Запретить** force-push на **`v2`** (сохранить линейную историю интеграции). |
| Агенты / исполнители | Работа в **`task/*`** или согласованных ветках; **merge в `v2`** выполняет человек (интегратор) после **просмотра diff** и зелёного CI — агент **не считается** автоматическим владельцем **`v2`**. |

### 4.2 Изменения кода: атомарность контрактов и совпадение с CI

**Цель:** на GitHub в том же коммите (или в том же merge в **`v2`**), что попадает в прод, выполняется **`npm run typecheck`** без ошибок. Локальная «работает у меня», но красный CI — признак **несогласованного дерева** или не тех файлов в **`git add`**.

1. **Один вертикальный срез.** Если меняется **публичный контракт** между модулями (`export type` / `export interface` / публичные поля результата функции, форма события JSONL), в **одной** интеграции в **`v2`** должны оказаться одновременно:
   - **определение** контракта (тип, схема, парсер);
   - все места, которые контракт **создают** (присваивают поля, возвращают объект);
   - все места, которые контракт **потребляют** (импорт типа, чтение полей).

2. **Антипаттерн (запрещён как дефект процесса, инвариант I9 в [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md)):** обновлён **только** потребитель (например, `src/live/entry-scale-in.ts` импортирует `LiveBuyIncreaseDeny` и читает `buyRes.increaseDeny`), а в репозитории на момент push **ещё нет** соответствующих **`export`** и поля в `LiveBuyPipelineResult` в `src/live/phase4-types.ts` (и обновлённых реализаций в `phase4-execution.ts` / `phase5-runtime.ts` и т.д.). Типичный симптом в CI:  
   `Module has no exported member '…'` / `Property '…' does not exist on type '…'`.  
   **Локально** ошибка может не проявляться, если в рабочей копии лежат **незакоммиченные** правки в `phase4-types.ts`, а в индекс попал один файл.

3. **Перед `git push` (для любой ветки, ведущей в `v2`):** в чистом смысле — без сюрпризов от чужих незакоммиченных правок в зоне контракта:
   - **`npm run typecheck`** (тот же вызов, что в GitHub Actions);
   - для интегратора перед merge в **`v2`** — ещё **`npm run check:hygiene:integration`** (I6 / [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md)).

4. **Проверка «все зовы»:** после смены имени типа или поля — поиск по репо (`rg` / поиск в IDE) по **старому и новому** идентификатору; убедиться, что нет веток кода, ожидающих старый контракт.

5. **VPS:** после **`git pull` / `git reset --hard origin/v2`** на клоне в **`/opt/solana-alpha`** перед перезапуском PM2 выполнять **`npm run typecheck`** (или полный цикл из §5.2). Не вести на сервере долгоживущие **непроиндексированные** правки в `src/` — перед обновлением: **`git stash`** или фиксация в ветке и merge в **`v2`**, иначе при **`pull`** снова возникает «смесь» и скрытая несовместимость.

6. **Откат:** откат **по путям** из [`CHANGELOG.md`](./CHANGELOG.md) обязан снова давать **зелёный `tsc`**. Частичный `git checkout <tag> -- один-файл` без проверки зависимостей может восстановить только потребителя или только тип — это та же ошибка, что и при внесении изменений.

---

## 5. Прод-сервер (канон) — Solana Alpha

### 5.1 Правило

Обновление **отслеживаемого** кода в **`/opt/solana-alpha`** — **только через Git** к состоянию **`origin/v2`**, затем **`npm ci`**, затем PM2.

**Запрещено по умолчанию:** **`scp`/`rsync`** деревьев **`src/`**, **`package.json`**, **`package-lock.json`** поверх клона без немедленного **`git reset --hard`** на тот же SHA, что на GitHub.

### 5.2 Последовательность (после `git push origin v2`)

**Канонический деплой Live Oscar** — скрипт от **root** (гасит случайный PM2 в `/root/.pm2`, затем `startOrReload` только под **`salpha`**):

```bash
cd /opt/solana-alpha
bash scripts/ops/deploy-live-oscar-vps.sh
```

Скрипт выполняет: `pm2 kill` (root) → `git fetch` / `reset` / `npm ci` (salpha) → `pm2 startOrReload` → **`post-deploy-smoke.sh`** (в т.ч. ровно один `live-oscar.ts` под `salpha`, env split leg = ecosystem, нет online `live-oscar` в `/root/.pm2`).

**Ручной эквивалент** (если скрипт недоступен):

```bash
# от root
pm2 kill 2>/dev/null || true
sudo -u salpha env PM2_HOME=/home/salpha/.pm2 HOME=/home/salpha bash -c '
  cd /opt/solana-alpha
  git fetch origin v2 && git reset --hard origin/v2 && npm ci
  pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save
  bash scripts/release/post-deploy-smoke.sh
'
```

SSH от **`root`** с ключом из [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) §7.4. Для salpha-команд — **`env PM2_HOME=/home/salpha/.pm2 HOME=/home/salpha bash -c`** (не `bash -lc`: login-shell ломает PM2_HOME).

Зафиксировать: **`git rev-parse HEAD`**, **`git status -sb`**.

**Обязательно после PM2 reload:** `bash scripts/release/post-deploy-smoke.sh` (PM2 online, **singleton `live-oscar.ts`**, env parity, нет `ERR_MODULE_NOT_FOUND`, discovery пишет `live_discovery_eval`). Без зелёного smoke — **не считать деплой успешным**.

**Деплой только если** GitHub Actions job **`hygiene`** на целевом SHA **зелёный** (см. [`BRANCH_PROTECTION_SETUP.md`](./BRANCH_PROTECTION_SETUP.md)).

### 5.3 PM2

Только под **`salpha`** (`PM2_HOME=/home/salpha/.pm2`). **Запрещено** держать `live-oscar` в **`/root/.pm2`** — второй демон торгует со старым env в обход деплоя. При смене env — **`--update-env`** и по политике **`pm2 flush`**; после изменения списка приложений — **`pm2 save`**.

### 5.4 Исключения

Аварийный hotfix — минимальный коммит в **`v2`** → push → §5.2. Секреты — только неотслеживаемые пути (`.env`, `data/`), без подмены tracked-файлов.

### 5.5 Резерв и disaster recovery (краткий runbook)

**Полный runbook:** [`DR_RESTORE.md`](./DR_RESTORE.md) (JSONL, runtime state, secrets, restore checklist).

**Ежедневные бэкапы** (cron **`salpha`**, установка: `bash scripts/ops/install-backup-cron.sh`):

| Время UTC | Объект | Скрипт |
|-----------|--------|--------|
| 03:10 | PostgreSQL → R2 | `scripts/ops/backup-db-r2-api.sh` |
| 03:20 | `.env` + keypairs (gpg) | `scripts/ops/backup-secrets-encrypted.sh` |
| 03:30 | JSONL + runtime state | `scripts/ops/backup-live-data.sh` |
| вс 04:00 | `pt1-oscar-live.jsonl` → R2 | `backup-live-data.sh --r2-full-journals` |

**PostgreSQL → R2** (03:10 UTC):

| Элемент | Значение |
|---------|----------|
| Скрипт | `scripts/ops/backup-db-r2-api.sh` (helpers: `_backup-common.sh`) |
| Лог | `/opt/solana-alpha/data/logs/db-backup.log` |
| Локальный staging | `/home/salpha/backups/postgres/` (retention 14 суток `.dump.zst`) |
| R2 bucket | `R2_BUCKET` из `.env` (default `solana-alpha-backups`) |
| Ключи объектов | `postgres/chunks/solana_alpha_YYYYMMDD-HHMMSS.dump.zst/part_XXXX` + `…/manifest.txt` |
| Env (`.env`) | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `R2_BUCKET`; опционально `TELEGRAM_*` для алертов |

Схемы в дампе: **`public`**, **`drizzle`** (БД `solana_alpha`; чужие product-схемы не включаются). Формат: `pg_dump -Fc` → `zstd` → chunk upload (≤90 MB) через Cloudflare R2 HTTP API.

**Проверка бэкапа вручную** (на VPS под `salpha`, секреты не печатать):

```bash
cd /opt/solana-alpha
bash scripts/ops/backup-db-r2-api.sh
tail -20 data/logs/db-backup.log
```

**Восстановление PostgreSQL из R2** (на чистом или существующем хосте с Postgres):

1. В `.env` задать `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `R2_BUCKET` (как на проде).
2. Скачать и проверить последний архив:
   ```bash
   cd /opt/solana-alpha && set -a && . ./.env && set +a
   bash scripts/ops/restore-from-r2-chunks.sh
   ```
   Без аргумента скрипт берёт **последний** `manifest.txt` в `postgres/chunks/`. Для конкретного снимка: `bash scripts/ops/restore-from-r2-chunks.sh postgres/chunks/solana_alpha_YYYYMMDD-HHMMSS.dump.zst`.
3. После проверки (`RESTORE CHECK OK` в stdout) — восстановить в БД (пример; **перезаписывает** схемы):
   ```bash
   cd /tmp/r2-restore-check
   dropdb --if-exists solana_alpha
   createdb -O salpha solana_alpha
   pg_restore --no-owner --no-acl -d solana_alpha dump.file
   ```
4. Перезапустить PM2 под `salpha` (`pm2 reload ecosystem.config.cjs --update-env`).

**Восстановление кода solana-alpha:** клон `/opt/solana-alpha` из Git **`origin/v2`** (§5.2): `git fetch origin v2 && git reset --hard origin/v2 && npm ci`. Секреты и `data/` — из отдельного хранилища / ручного `.env`, не из Git.

**dc-trader** (отдельный продукт на том же VPS): каталог **`/opt/dc-trader`**, PM2 **`dc-trader`**. Код — свой Git-репозиторий (ветка по политике продукта); state/journal — **`/opt/dc-trader/data/`** (не входят в PG-бэкап solana-alpha). После rebuild VPS: восстановить `.env`, `data/`, затем `git pull` / deploy по runbook продукта.

**Минимальный чеклист rebuild VPS**

1. OS + Postgres + Node + PM2; пользователь **`salpha`**; каталоги `/opt/solana-alpha`, `/opt/dc-trader`.
2. Восстановить **`/opt/solana-alpha/.env`** (и при необходимости `/opt/dc-trader/.env`) из secure backup.
3. §5.2 — checkout **`v2`**, `npm ci`, `pm2 startOrReload ecosystem.config.cjs --update-env`, `post-deploy-smoke.sh`.
4. PG restore из R2 (§5.5 выше) **или** свежий дамп, если R2 недоступен.
5. `install-backup-cron.sh` + `install-vps-github-sync-cron.sh` — cron бэкапа и drift-audit.
6. Проверить: `tail data/logs/db-backup.log`, `pm2 ls`, smoke green.

Перед рискованным деплоем — дополнительно §7.3 [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) (JSONL / точечный `pg_dump`).

---

## 6. Платформа, агенты и Cursor rules в этом репозитории

Канонические **`docs/platform/**`**, **`docs/agents/**`**, **`scripts/platform/**`**, **`.cursor/rules/**`** версионируются **в этом репозитории** (`solana-bot`). При локальной структуре **Ideas/** (родительская папка над рабочей копией продукта) не держите расходящуюся вторую правду только в Ideas: после правок интегратор переносит изменения сюда и делает push в **`v2`**.

Любое изменение этих путей требует bump **`docs/platform/VERSION`** и записи в **`docs/platform/PLATFORM_CHANGELOG.md`** (см. правило в `.cursor/rules/multi-product-platform.mdc`).

---

## 7. Карта детальных документов

| Тема | Файл (от корня репозитория) |
|------|----------------------------------------|
| SSOT, replay JSONL, риски | [`docs/strategy/release/RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) |
| Параллельные агенты | [`docs/strategy/release/PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md) |
| CI hygiene | [`scripts/check-release-hygiene.mjs`](../../../scripts/check-release-hygiene.mjs) |
| Git hooks / smoke | [`scripts/release/install-git-hooks.sh`](../../../scripts/release/install-git-hooks.sh), [`scripts/release/post-deploy-smoke.sh`](../../../scripts/release/post-deploy-smoke.sh), [`BRANCH_PROTECTION_SETUP.md`](./BRANCH_PROTECTION_SETUP.md) |
| PG backup / DR | [`DR_RESTORE.md`](./DR_RESTORE.md), [`scripts/ops/backup-db-r2-api.sh`](../../../scripts/ops/backup-db-r2-api.sh), [`scripts/ops/restore-from-r2-chunks.sh`](../../../scripts/ops/restore-from-r2-chunks.sh), [`scripts/ops/install-backup-cron.sh`](../../../scripts/ops/install-backup-cron.sh) |
| Платформа и агенты | [`docs/platform/BOUNDARIES.md`](../../platform/BOUNDARIES.md), [`docs/agents/AGENT_BOOTSTRAP.md`](../../agents/AGENT_BOOTSTRAP.md) |

---

## 8. Чеклист интегратора

- [ ] **`bash scripts/release/install-git-hooks.sh`** установлен на машине, с которой пушите (pre-commit / pre-push gates).
- [ ] **`git fetch`**, **`v2`** выровнена с **`origin/v2`** перед bump.
- [ ] **`npm run verify`** (или минимум **`npm run typecheck`** + **`npm run check:imports`**) на том же наборе файлов, что уйдёт в push.
- [ ] Нет **расщеплённого API**: типы / продюсеры / потребители контракта попали в **`v2` одним потоком** (§4.2, I9 в [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md)); **`check-staged-imports`** не ругается на untracked deps.
- [ ] **`npm run check:hygiene:integration`** зелёный перед merge в **`v2`**.
- [ ] Push в **`v2`**, CI job **`hygiene`** зелёный на SHA.
- [ ] Деплой §5.2 (`bash scripts/ops/deploy-live-oscar-vps.sh` или ручной эквивалент с `pm2 kill` root); зафиксированы SHA и **`git status`**.
- [ ] **`bash scripts/release/post-deploy-smoke.sh`** зелёный (в т.ч. **один** `live-oscar.ts` под `salpha`, нет online `live-oscar` в `/root/.pm2`).
- [ ] На сервере после обновления дерева — **`npm run typecheck`** (или полный §5.2), затем PM2 с **`--update-env`** / **`pm2 flush`** по политике процесса.
- [ ] Нет рутинного **`scp`** tracked-кода на VPS-клон.

---

## 9. История этого документа

| Дата | Версия продукта | Суть |
|------|-----------------|------|
| 2026-06-24 | — | §5.5 — PG→R2 cron, R2 path, restore и rebuild VPS (DR runbook). |
| 2026-06-13 | 1.11.446 | §5.2 — канонический `deploy-live-oscar-vps.sh` + singleton smoke (один `live-oscar.ts`, запрет `/root/.pm2`). |
| 2026-05-22 | 1.11.253 | Git hooks (staged imports + typecheck), CI `check:imports`, post-deploy smoke, branch protection doc. |
| 2026-05-04 | 1.11.62 | §4.2 — атомарность изменений TypeScript/контрактов модулей; совпадение с CI; VPS и откат; §8 — расширенный чеклист интегратора (в т.ч. против ошибки `LiveBuyIncreaseDeny` / `increaseDeny`). |
| 2026-05-04 | 1.11.52 | §6 — канон платформы/`agents`/`.cursor` в репозитории; синхронизация с деревом Ideas. |
| 2026-05-04 | 1.11.51 | §4.1 — рекомендуемая branch protection на **`v2`**, CI, запрет force-push; роли при merge. |
| 2026-05-03 | 1.10.2 | Публикация сводного норматива; приоритет Git на VPS; согласование с Cursor rule `server-autodeploy`. |

---

*Конец документа.*
