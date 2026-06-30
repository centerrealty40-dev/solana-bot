# Live Oscar — документация стратегии

Каталог нормативов и дорожных карт для prod PM2 **`live-oscar`** (Solana Alpha, ветка `v2`).

**Источник истины по env:** `ecosystem.config.cjs` → блок `live-oscar`.  
**Semver продукта:** [`../release/VERSION`](../release/VERSION), [`../release/CHANGELOG.md`](../release/CHANGELOG.md).

---

## Оглавление

| Документ | Статус | Назначение |
|----------|--------|------------|
| [**LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md**](./LIVE_OSCAR_COIN_INTELLIGENCE_SPEC.md) | **normative** | Coin intelligence (superpowers): wallet-intel overlay, **§4 lifecycle scope**, PG strategy, rollout, collector safety, copy-trader fusion |
| [OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md](./OPTIMIZATION_ROADMAP_SHYFT_HYBRID.md) | active | Гибрид Shyft + PG для свежести цены; этапы 0–2 |
| [LIVE_OSCAR_TRADING_SPEC_STREAM.md](./LIVE_OSCAR_TRADING_SPEC_STREAM.md) | DEPRECATED | Снимок prod-параметров; oscar-stream закрыт |

## Смежные спеки (вне каталога)

| Тема | Путь |
|------|------|
| Live Oscar phases W8.0 | [`../specs/W8.0_IMPLEMENTATION_PHASES.md`](../specs/W8.0_IMPLEMENTATION_PHASES.md) |
| Idealized Oscar stack | [`../specs/IDEALIZED_OSCAR_STACK_SPEC.md`](../specs/IDEALIZED_OSCAR_STACK_SPEC.md) |
| Wallet intel / scam-farm | [`../../Smart Lottery V2/README.md`](../../Smart Lottery V2/README.md) |
| dip_bot intel | [`../specs/W9.0_dip_bot_intel_spec.md`](../specs/W9.0_dip_bot_intel_spec.md) |
| Release / deploy | [`../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md`](../release/NORM_UNIFIED_RELEASE_AND_RUNTIME.md) |

---

*Cross-product: none.*
