#!/usr/bin/env bash
# Обновить код Живого Оскара на VPS и перезапустить PM2.
# Запуск: от root на сервере (или sudo bash …).
# Переменные: APP_DIR (по умолчанию /opt/solana-alpha), GIT_BRANCH (по умолчанию v2).
#
# Отдельный GitHub-репозиторий «только Oscar» этим скриптом не создаётся — это другой объём работ.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/solana-alpha}"
GIT_BRANCH="${GIT_BRANCH:-v2}"

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Нужен root (или sudo), чтобы выполнить команды от пользователя salpha."
  exit 1
fi

# Не держать приложения под PM2 от root (иначе второй дамп и путаница с пользователем процессов).
pm2 kill 2>/dev/null || true

# login-shell (-lc) ломает PM2_HOME; задаём явно и неинтерактивный bash -c.
sudo -u salpha env PM2_HOME=/home/salpha/.pm2 HOME=/home/salpha bash -c "
set -euo pipefail
cd '${APP_DIR}'
git fetch origin '${GIT_BRANCH}'
git reset --hard \"origin/${GIT_BRANCH}\"
mkdir -p data/live data/paper2
if [[ ! -f data/paper2/organizer-paper.jsonl ]]; then
  touch data/paper2/organizer-paper.jsonl
fi
npm ci
pm2 delete dashboard-organizer-paper 2>/dev/null || true
for n in pt1-oscar pt1-dno pt1-diprunner pt1-oscar-regime pt1-smart-lottery; do pm2 delete \"\$n\" 2>/dev/null || true; done
pm2 startOrReload '${APP_DIR}/ecosystem.config.cjs' --update-env
pm2 save
git rev-parse HEAD
git status -sb
"
