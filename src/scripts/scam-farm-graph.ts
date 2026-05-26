import 'dotenv/config';
import { runScamFarmGraphPass } from '../intel/scam-farm-detective/graph/run-phase-b.js';

function hasHelpFlag(): boolean {
  return process.argv.includes('--help') || process.argv.includes('-h');
}

if (hasHelpFlag()) {
  console.log(`scam-farm-graph — фаза B (W6.14): treasury/sink, мета-кластеры, relay, temporal, CEX hint

ENV (см. .env.example блок SCAM_FARM_GRAPH_* / SCAM_FARM_SINK_*):
  SCAM_FARM_GRAPH_ENABLED=0|1     мастер-выключатель (default 0)
  SCAM_FARM_GRAPH_DRY_RUN=0|1    default 1 — без записей в БД
  SCAM_FARM_SINK_WIDE_MODE=0|1   широкий режим sinks (дороже)

Запуск после npm run scam-farm:detect при наличии money_flows и тегов фазы A.
`);
  process.exit(0);
}

runScamFarmGraphPass()
  .then((m) => {
    console.log(JSON.stringify({ ok: true, metrics: m }));
    process.exit(0);
  })
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    process.exit(1);
  });
