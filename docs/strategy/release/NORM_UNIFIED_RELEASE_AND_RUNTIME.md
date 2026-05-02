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

---

## 5. Прод-сервер (канон) — Solana Alpha

### 5.1 Правило

Обновление **отслеживаемого** кода в **`/opt/solana-alpha`** — **только через Git** к состоянию **`origin/v2`**, затем **`npm ci`**, затем PM2.

**Запрещено по умолчанию:** **`scp`/`rsync`** деревьев **`src/`**, **`package.json`**, **`package-lock.json`** поверх клона без немедленного **`git reset --hard`** на тот же SHA, что на GitHub.

### 5.2 Последовательность (после `git push origin v2`)

От имени владельца репозитория на сервере (**`salpha`**):

```bash
cd /opt/solana-alpha
git fetch origin v2
git reset --hard origin/v2
npm ci
pm2 reload ecosystem.config.cjs --update-env
```

SSH от **`root`** с ключом из [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) §7.4; команды в каталоге — **`sudo -u salpha bash -lc '…'`**.

Зафиксировать: **`git rev-parse HEAD`**, **`git status -sb`**.

### 5.3 PM2

Под **`salpha`**; при смене env — **`--update-env`** и по политике **`pm2 flush`**; после изменения списка приложений — **`pm2 save`**.

### 5.4 Исключения

Аварийный hotfix — минимальный коммит в **`v2`** → push → §5.2. Секреты — только неотслеживаемые пути (`.env`, `data/`), без подмены tracked-файлов.

### 5.5 Резерв

По [`RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) §7.3.

---

## 6. Монорепозиторий Ideas (если ваш клон его содержит)

Если **`solana-alpha`** лежит внутри дерева **Ideas** и правятся **`docs/platform/**`**, **`docs/agents/**`**, **`.cursor/rules/multi-product-platform.mdc`**, **`products.yaml`** — действуют правила платформы: bump **`docs/platform/VERSION`** и **`PLATFORM_CHANGELOG.md`**. При работе **только** в отдельном клоне **`solana-bot`** этот § не применяется.

---

## 7. Карта детальных документов

| Тема | Файл (от корня продукта `solana-alpha`) |
|------|----------------------------------------|
| SSOT, replay JSONL, риски | [`docs/strategy/release/RELEASE_OPERATING_MODEL.md`](./RELEASE_OPERATING_MODEL.md) |
| Параллельные агенты | [`docs/strategy/release/PARALLEL_WORKFLOW.md`](./PARALLEL_WORKFLOW.md) |
| CI hygiene | [`scripts/check-release-hygiene.mjs`](../../../scripts/check-release-hygiene.mjs) |
| Платформа (при дереве Ideas) | `docs/platform/BOUNDARIES.md`, `docs/agents/AGENT_BOOTSTRAP.md` |

---

## 8. Чеклист интегратора

- [ ] **`git fetch`**, **`v2`** выровнена с **`origin/v2`** перед bump.
- [ ] **`npm run typecheck`**, **`check:hygiene:integration`** зелёные.
- [ ] Push в **`v2`**, CI зелёный.
- [ ] Деплой §5.2; зафиксированы SHA и **`git status`**.
- [ ] Нет рутинного **`scp`** tracked-кода на VPS-клон.

---

## 9. История этого документа

| Дата | Версия продукта | Суть |
|------|-----------------|------|
| 2026-05-03 | 1.10.2 | Публикация сводного норматива; приоритет Git на VPS; согласование с Cursor rule `server-autodeploy`. |

---

*Конец документа.*
