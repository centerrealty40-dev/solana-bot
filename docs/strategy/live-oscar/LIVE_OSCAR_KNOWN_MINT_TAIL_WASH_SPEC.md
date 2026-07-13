# Known-mint re-entry tail_wash gate — LERA + Live Oscar

**Продукты:** `live-lera` / `live-lera10` (VPS `/opt/lera`), `live-oscar` (VPS `/opt/solana-alpha`)  
**Ветка:** `v2`  
**Статус:** **NORMATIVE** (guard parity)  
**Версия спеки:** 1.0 (2026-07-13)  
**Код:** `src/papertrader/discovery/volume-ephemeral-guard.ts` + `config.ts`

## Changelog

| Версия | Дата | Изменение |
|--------|------|-----------|
| **1.0** | 2026-07-13 | Known-mint re-entry: `tail_wash` при `vol5m/vol1h < 8%`; RCA mint `6AVA…pump` (SCAM) 12.07 ~22:00 MSK |

**Связанные документы:**

| Документ | Роль |
|----------|------|
| [`NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md) | Deploy Oscar через `origin/v2` |
| [`LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md`](./LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md) | Intel overlay (не заменяет volume guards) |

---

## §1. Проблема (RCA)

**Mint:** `6AVAUKa9uxQpruHZUinFECpXEh1usRVtzQWK8N2wpump` (SCAM)  
**Событие:** 12 июля 2026 ~22:00 MSK — повторный вход `live-lera` на $250 после закрытия первой сделки ~2 ч ранее.

| Метрика PG в момент eval | Значение |
|--------------------------|----------|
| marketCapUsd | ~$765k |
| vol1hUsd | ~$105k |
| vol5mUsd | ~$2.6k |
| vol5m / vol1h | **~2.9%** |

`live-lera10` в ту же секунду: `pass: false`, reason `volume_ephemeral:tail_wash_vol5m_vol1h=2.9%<8%`.  
`live-lera`: `pass: true` — known/familiar mint **полностью обходил** `volume_ephemeral` (legacy `PAPER_FAMILIAR_MINT_GATE_BYPASS` на старом LERA runtime).

**Операторский intent:** если монета **теряет краткосрочный объём** (мертвый vol5m при «надутом» vol1h), **не re-enter**, даже если бот уже торговал этот mint.

---

## §2. Правило (normative)

### 2.1. Когда применяется

- `knownMint === true` (prior bot entry/exit в lookback `PAPER_PG_DATA_COVERAGE_KNOWN_MINT_LOOKBACK_DAYS`, default 14d)
- `PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED=1`
- `PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED=1` (default **on**)

### 2.2. Условие блока (`tail_wash`)

Все одновременно:

1. `volume_1h >= PAPER_VOLUME_GUARD_NEW_MINT_VOL1H_WASH_MIN_USD` (default **$36_000**)
2. `volume_5m < PAPER_VOLUME_EPHEMERAL_MIN_ACTIVE_HOUR_VOL5M_USD` (default **$8_000**)
3. `volume_5m / volume_1h < PAPER_VOLUME_GUARD_NEW_MINT_MIN_VOL5M_TO_VOL1H_RATIO` (default **0.08** = 8%)

**Journal reason (unchanged):**

```text
volume_ephemeral:tail_wash_vol5m_vol1h=2.9%<8%_vol5m=$3028_vol1h=$103586
```

### 2.3. Исключения (не ломать NEST/world RCA)

Порядок в `evaluateKnownMintVolumeEphemeral`:

1. **Single-tick stale bypass** — если `vol5m` мёртвый, но соседние PG-часы здоровые (`neighborVolumeHealthy`) → **pass**, флаг `volume_ephemeral:single_tick_stale_ignored`.
2. **tail_wash** (этот spec) → block при decaying volume.
3. **known_mint_sustained_dead** — sustained dead neighbors (существующее правило).

`tail_wash` **не** применяется к first-time mints через known path — new-mint path уже имел это правило.

### 2.4. Что по-прежнему relaxed для known mint

- `new_mint_min_active_hours`
- narrow-window / spike / peak-tail blocks
- (Oscar main) full `familiarMint` bypass **удалён** в #404/#409 — только audit field

---

## §3. Env contract

| Env | Default | LERA | Oscar |
|-----|---------|------|-------|
| `PAPER_VOLUME_EPHEMERAL_GUARD_ENABLED` | `0` (global schema); **LERA/Oscar prod: `1`** | `1` | `1` |
| `PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED` | `1` | **`1`** | **`1`** |
| `PAPER_VOLUME_GUARD_NEW_MINT_MIN_VOL5M_TO_VOL1H_RATIO` | `0.08` | `0.08` | `0.08` |
| `PAPER_VOLUME_GUARD_NEW_MINT_VOL1H_WASH_MIN_USD` | `36000` | `36000` | `36000` |
| `PAPER_VOLUME_EPHEMERAL_MIN_ACTIVE_HOUR_VOL5M_USD` | `8000` | `8000` | `8000` |

**LERA-only legacy (deprecate on sync):** `PAPER_FAMILIAR_MINT_GATE_BYPASS_ENABLED` — после merge этого патча **не должен** отключать `tail_wash` на known mint. На каноническом коде bypass удалён; tail_wash enforced через `knownMint` path.

---

## §4. Код (единый модуль)

| Файл | Изменение |
|------|-----------|
| `src/papertrader/discovery/volume-ephemeral-guard.ts` | `appendTailWashVol5mVol1hReasons()`; вызов в `evaluateKnownMintVolumeEphemeral` |
| `src/papertrader/config.ts` | `volumeEphemeralKnownMintTailWashBlockEnabled` |
| `tests/volume-ephemeral-guard.test.ts` | SCAM RCA fixture + MUSHU known-mint regression |
| `ecosystem.config.cjs` | Oscar: `PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED: '1'` |

---

## §5. Deploy checklist

### 5.1. LERA (`/opt/lera`, PM2 `live-lera`, `live-lera10`)

1. Merge commit в LERA repo / sync `volume-ephemeral-guard.ts` с `solana-alpha` `v2`.
2. В `ecosystem.config.cjs` (оба live-процесса):

   ```text
   PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED: '1',
   ```

3. `npm ci` → `pm2 reload ecosystem.config.cjs --update-env --only live-lera,live-lera10`
4. Smoke: grep journal `tail_wash_vol5m_vol1h` на known mint с низким ratio — eval `pass: false`.

### 5.2. Live Oscar (`/opt/solana-alpha`, PM2 `live-oscar`)

1. `git fetch origin v2 && git reset --hard origin/v2 && npm ci` (NORM §5)
2. `pm2 reload ecosystem.config.cjs --update-env --only live-oscar`
3. `bash scripts/release/post-deploy-smoke.sh`

### 5.3. Rollback

```text
PAPER_VOLUME_EPHEMERAL_KNOWN_MINT_TAIL_WASH_BLOCK_ENABLED=0
```

→ `pm2 reload … --update-env`. Поведение known mint возвращается к pre-1.0 (без re-entry tail_wash).

---

## §6. Test plan

```bash
npm run test -- tests/volume-ephemeral-guard.test.ts
```

Обязательные кейсы:

- SCAM-like known mint (vol5m=3028, vol1h=103586) → **blocked**
- NEST/world neighbor-healthy stale tick → **pass** + `single_tick_stale_ignored`
- known mint healthy ratio (vol5m=12k, vol1h=82k) → **pass**
- flag `…_TAIL_WASH_BLOCK_ENABLED=0` → known mint low ratio **pass**

---

## §7. Counterfactual (SCAM 12.07)

При включённом патче eval `live-lera` в `ts=1783882830641` получил бы `pass: false` с `tail_wash_vol5m_vol1h=2.9%<8%` — повторный вход $250 **не состоялся бы**.
