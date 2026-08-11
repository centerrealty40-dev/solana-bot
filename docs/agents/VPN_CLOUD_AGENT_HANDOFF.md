# VPN + серверы — handoff для Cloud Agent (телефон / web)

Этот файл — **замена локального чата** про VPN и карту серверов.  
Локальные Agent-чаты Cursor **не синхронизируются** в облако. Облачный агент видит только: **GitHub-репо** + **Secrets** + то, что ты напишешь в новом Cloud-чате.

**Репозиторий:** `centerrealty40-dev/solana-bot` (ветка интеграции `v2`).

---

## Как запускать с телефона

1. Открой [cursor.com/agents](https://cursor.com/agents) (или приложение Cursor iOS).
2. Выбери репо **`centerrealty40-dev/solana-bot`**, ветка **`v2`**.
3. В первый промпт вставь блок **«Стартовый промпт»** ниже.
4. Secrets должны быть уже добавлены (см. § Secrets).

---

## Secrets (обязательно для SSH на VPN / Oscar / LERA)

В [cursor.com/dashboard/cloud-agents](https://cursor.com/dashboard/cloud-agents) → **Secrets** добавь:

| Secret name | Содержимое |
|-------------|------------|
| `BOTADMIN_SSH_KEY` | **Весь** приватный ключ `botadmin_187_auto` (текст файла, включая `BEGIN`/`END`) |
| `VPN_SUB_URL` (опционально) | `https://72.62.50.93.nip.io:8443/hiddify.txt` |

На старте агент пишет ключ во временный файл и использует `-i`:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
printenv BOTADMIN_SSH_KEY > ~/.ssh/botadmin_187_auto
chmod 600 ~/.ssh/botadmin_187_auto
ssh -i ~/.ssh/botadmin_187_auto -o StrictHostKeyChecking=accept-new root@72.62.50.93 "hostname"
```

**Не коммить** ключ в Git. Только Secrets.

Если Oscar по публичному IP недоступен из cloud VM — подключи **Tailscale** к окружению Cloud Agent (см. Cursor docs: Cloud Agent security / private network) и используй `100.82.221.89`.

---

## Карта серверов

| # | Имя | IP | Роль | Каталог |
|---|-----|-----|------|---------|
| 1 | **VPN (DE, primary)** | `72.62.50.93` | Hiddify / Amnezia Xray Reality (Xray-core **v26.3.27**) | Docker `amnezia-xray`, подписки `/var/www/vpn-sub/`, ensure `/root/ensure-xray.sh`, meta `/root/xray-client/connection.txt` |
| 2 | **VPN (LT, legacy)** | `187.124.133.200` | Старый VPN; с ~2026-08 у клиентов timeout (DPI/маршрут). Не использовать как primary. | тот же стек |
| 3 | **Oscar** | `187.124.38.242` (TS `100.82.221.89`) | live-oscar, copy-trader, коллекторы | `/opt/solana-alpha`, user `salpha` |
| 4 | **LERA** | `72.62.152.201` | live-lera | `/opt/lera`, user `lera` |
| 5 | **Catchers** | тот же хост LERA | knife + awakening | `/opt/lera-catchers`, user `lera` |

### SSH

- User: **`root`**
- Key: из secret `BOTADMIN_SSH_KEY` → файл `~/.ssh/botadmin_187_auto` (comment `cente@DESKTOP-B53V0UU`)
- Windows-десктоп путь (только локально): `c:/Users/cente/.ssh/botadmin_187_auto` — в cloud его нет.

### VPN для людей (Hiddify / Happ) — **DE primary**

- HTTPS sub: `https://72.62.50.93.nip.io:8443/hiddify.txt`
- iOS sub: `https://72.62.50.93.nip.io:8443/ios.txt`
- HTTP sub (fallback): `http://72.62.50.93:8080/hiddify.txt`
- Reality SNI/dest: `www.google.com` (без fragment в подписке)
- После `docker restart amnezia-xray` обязательно: `/root/ensure-xray.sh`
- Проверка клиента: ifconfig.me → `72.62.50.93`

Полная `vless://` строка **не хранится в Git** — бери из подписки на сервере или из secret.

---

## Правила

1. VPN **не** ставить на Oscar (live-деньги).
2. knife / awakening **не** на Oscar — только `/opt/lera-catchers`.
3. Деплой Oscar tracked-кода: только Git **`origin/v2`** → `reset --hard` → `npm ci` → PM2 под `salpha`.
4. Не `pm2 stop/delete/restart all` на Oscar.
5. Деструктивные действия — только по явной задаче пользователя.
6. Не печатать в ответ: `.env`, DSN, wallet keypair, полный SSH private key, root password VPS.

Канон релиза: `docs/strategy/release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`.

---

## Контекст из локальных чатов (кратко)

- KVM-1 VPN LT = `187.124.133.200`; DCA-боты с него **удалены**, остался VPN-only; с 2026-08 массовый timeout с RU → заменён на DE `72.62.50.93`.
- Xray в Docker `amnezia-xray` часто «жив» контейнером, но процесс xray мёртв → чинит `ensure-xray.sh` + cron `*/2`.
- iOS Hiddify/Happ: HTTP sub часто запрещён → использовать **HTTPS** `:8443` (Caddy + cert).
- Timeout на Windows часто из‑за **Happ + Hiddify одновременно** — один клиент.
- ifconfig.me показывает домашний IP → туннель не поднят / не Global+TUN.
- iOS Happ: тяжёлый routing (geo+ads) → «лимит памяти туннеля 50 МБ» / NEAging — роутинг выключить или Lite-профиль.
- Xray 26 `x25519` печатает `PrivateKey` / `Password (PublicKey)` (не старые `Private key` / `Public key`).

Локальный файл на десктопе (не в cloud): `C:\Users\cente\Ideas\CURSOR_LAPTOP_HANDOFF.md`.

---

## Стартовый промпт (копируй в новый Cloud Agent)

```text
Прочитай docs/agents/VPN_CLOUD_AGENT_HANDOFF.md целиком.

Задача: работа с VPN-сервером и картой ботов по этому handoff.
1) Возьми BOTADMIN_SSH_KEY из secrets, сохрани в ~/.ssh/botadmin_187_auto (chmod 600).
2) Проверь SSH: root@72.62.50.93 (VPN DE primary) — xray + подписки.
3) При необходимости Oscar 187.124.38.242 / Tailscale 100.82.221.89 и LERA 72.62.152.201.
4) Не коммить секреты. Не деструктив без явной просьбы.

Дальше: [опиши проблему: timeout Hiddify / перезапуск xray / подписка / статус ботов]
```

---

*Обновляй этот файл при смене IP/хостов и мержи в `v2`, иначе cloud/телефон устареют.*
