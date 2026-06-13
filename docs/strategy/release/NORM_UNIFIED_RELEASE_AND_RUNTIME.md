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

### 5.5 Резерв

По [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) §7.3.

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
| 2026-06-13 | 1.11.446 | §5.2 — канонический `deploy-live-oscar-vps.sh` + singleton smoke (один `live-oscar.ts`, запрет `/root/.pm2`). |
| 2026-05-22 | 1.11.253 | Git hooks (staged imports + typecheck), CI `check:imports`, post-deploy smoke, branch protection doc. |
| 2026-05-04 | 1.11.62 | §4.2 — атомарность изменений TypeScript/контрактов модулей; совпадение с CI; VPS и откат; §8 — расширенный чеклист интегратора (в т.ч. против ошибки `LiveBuyIncreaseDeny` / `increaseDeny`). |
| 2026-05-04 | 1.11.52 | §6 — канон платформы/`agents`/`.cursor` в репозитории; синхронизация с деревом Ideas. |
| 2026-05-04 | 1.11.51 | §4.1 — рекомендуемая branch protection на **`v2`**, CI, запрет force-push; роли при merge. |
| 2026-05-03 | 1.10.2 | Публикация сводного норматива; приоритет Git на VPS; согласование с Cursor rule `server-autodeploy`. |

---

*Конец документа.*
