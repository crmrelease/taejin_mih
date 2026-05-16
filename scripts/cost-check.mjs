#!/usr/bin/env node
// Detect ANTHROPIC_API_KEY in .env / shell rc files; alert via Slack if found.
// Designed to be invoked periodically (e.g., launchd every 5 min).
// Posts to MONITOR_ERROR_CHANNEL using agent_mo's bot token, so the alert
// appears as mo. State is persisted so the alert fires only on transitions.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const MIH_DIR = path.resolve(HOME, 'Desktop/mih');
const STATE_FILE = path.resolve(HOME, 'Library/Application Support/taejin-mih/cost-check-state.json');

const SCAN_FILES = [
  path.join(MIH_DIR, 'agent_som/.env'),
  path.join(MIH_DIR, 'agent_rang/.env'),
  path.join(MIH_DIR, 'agent_mo/.env'),
  path.join(HOME, '.zshrc'),
  path.join(HOME, '.zprofile'),
  path.join(HOME, '.zshenv'),
  path.join(HOME, '.bashrc'),
  path.join(HOME, '.bash_profile'),
];

const DRY_RUN = process.argv.includes('--dry-run');
const SMOKE_TEST = process.argv.includes('--smoke-test');

function parseEnvForVar(content, varName) {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(new RegExp(`^(?:export\\s+)?${varName}\\s*=\\s*(.+)$`));
    if (!m) continue;
    let val = m[1].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val.length > 0) return val;
  }
  return null;
}

async function readMoEnv() {
  const content = await fs.readFile(path.join(MIH_DIR, 'agent_mo/.env'), 'utf8');
  return {
    SLACK_BOT_TOKEN: parseEnvForVar(content, 'SLACK_BOT_TOKEN'),
    MONITOR_ERROR_CHANNEL: parseEnvForVar(content, 'MONITOR_ERROR_CHANNEL'),
    MONITOR_OWNER_USER_ID: parseEnvForVar(content, 'MONITOR_OWNER_USER_ID'),
  };
}

async function detectKeys() {
  const hits = [];
  for (const f of SCAN_FILES) {
    try {
      const content = await fs.readFile(f, 'utf8');
      if (parseEnvForVar(content, 'ANTHROPIC_API_KEY')) {
        hits.push(f.replace(HOME, '~'));
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  if (process.env.ANTHROPIC_API_KEY) hits.push('(launchd process env)');
  return hits.sort();
}

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch { return { alerted: [] }; }
}

async function saveState(s) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

async function postSlack(token, channel, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text, unfurl_links: false, unfurl_media: false }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`slack: ${body.error}`);
}

async function main() {
  const env = await readMoEnv();
  const token = env.SLACK_BOT_TOKEN;
  const channel = env.MONITOR_ERROR_CHANNEL || 'C0B2RBZJE22';
  const owner = env.MONITOR_OWNER_USER_ID;
  if (!token) throw new Error('SLACK_BOT_TOKEN not found in agent_mo/.env');

  if (SMOKE_TEST) {
    await postSlack(token, channel, ':bell: cost-check 스모크 테스트 — 알림 경로 정상 작동 확인용 메시지입니다. (한 번만 발송)');
    console.log('[cost-check] smoke test posted');
    return;
  }

  const found = await detectKeys();
  const state = await loadState();
  const prev = new Set(state.alerted);
  const curr = new Set(found);
  const newHits = found.filter((h) => !prev.has(h));
  const cleared = state.alerted.filter((h) => !curr.has(h));

  console.log(`[cost-check] hits=${found.length} new=${newHits.length} cleared=${cleared.length}${DRY_RUN ? ' (dry-run)' : ''}`);
  if (found.length > 0) console.log(`[cost-check] current: ${found.join(', ')}`);

  if (DRY_RUN) return;

  if (newHits.length > 0) {
    const lines = [
      ':money_with_wings: *Anthropic API 키 감지 — Max 외 추가 비용 발생 가능*',
      '아래 위치에 `ANTHROPIC_API_KEY`가 설정돼 있어요. Claude Code가 Max 인증 대신 API 키로 빠지면 토큰당 별도 과금됩니다.',
      ...newHits.map((h) => `• \`${h}\``),
      '의도한 게 아니면 키를 제거해 주세요.',
    ];
    if (owner) lines.push(`<@${owner}>`);
    await postSlack(token, channel, lines.join('\n'));
  }

  if (cleared.length > 0) {
    const lines = [
      ':white_check_mark: *Anthropic API 키 제거 확인*',
      ...cleared.map((h) => `• \`${h}\``),
    ];
    await postSlack(token, channel, lines.join('\n'));
  }

  await saveState({ alerted: found });
}

main().catch((err) => {
  console.error(`[cost-check] error: ${err.message}`);
  process.exit(1);
});
