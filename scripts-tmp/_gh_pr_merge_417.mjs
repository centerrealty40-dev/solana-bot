#!/usr/bin/env node
import { execSync } from 'node:child_process';

function gitCredentialToken() {
  const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const m = out.match(/^password=(.+)$/m);
  if (!m?.[1]) throw new Error('no github token');
  return m[1].trim();
}

const token = gitCredentialToken();
const owner = 'centerrealty40-dev';
const repo = 'solana-bot';
const head = 'release/sa-alpha-1.11.417';
const base = 'v2';

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return body;
}

let pr = (await gh(`/pulls?head=${owner}:${head}&base=${base}&state=open`))[0];
if (!pr) {
  pr = await gh('/pulls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'fix(rpc): Alchemy-only audit + hourly usage Telegram (1.11.417)',
      head,
      base,
      body: [
        '## Summary',
        '- Alchemy-first RPC chain; Helius fallback opt-in only',
        '- ecosystem: combo off by default, all RPC apps get Alchemy env, sa-alchemy-usage-watch',
        '- copy-trader RPC metered; hourly Telegram via internal meter',
        '',
        '## Test plan',
        '- [x] npm run typecheck',
        '- [ ] post-deploy smoke on VPS',
      ].join('\n'),
    }),
  });
}
console.log('PR', pr.number, pr.html_url);

for (let i = 0; i < 80; i++) {
  const runs = await gh(`/commits/${pr.head.sha}/check-runs`);
  const hygiene = runs.check_runs?.find((c) => c.name === 'hygiene');
  const state = hygiene?.conclusion || hygiene?.status || 'pending';
  console.log('hygiene', i, state);
  if (state === 'success') break;
  if (state === 'failure') throw new Error('CI failed');
  await new Promise((r) => setTimeout(r, 15000));
}

const m = await gh(`/pulls/${pr.number}/merge`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ merge_method: 'merge' }),
});
console.log('merged', m.sha);
