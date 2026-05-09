import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { WebClient } from '@slack/web-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(__dirname, '../..');
const STATE_FILE = path.resolve(__dirname, '../monitor_state.json');

dotenv.config({ path: path.resolve(WORKSPACE_DIR, '.env') });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID || '69ff0dbf250b1311c3260b83';
const JSONBIN_MASTER_KEY = process.env.JSONBIN_MASTER_KEY;
const ALERT_TARGET = process.env.MONITOR_ALERT_TARGET;
const POLL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 300_000;
const PAGE_URL = process.env.MONITOR_PAGE_URL || 'https://crmrelease.github.io/taejin_mih/players.html';

if (!SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN missing in .env'); process.exit(1); }
if (!JSONBIN_MASTER_KEY) { console.error('JSONBIN_MASTER_KEY missing in .env'); process.exit(1); }
if (!ALERT_TARGET) { console.error('MONITOR_ALERT_TARGET missing in .env (Slack user or channel id)'); process.exit(1); }

const slack = new WebClient(SLACK_BOT_TOKEN);

interface Player { id?: string; name?: string; player?: string; createdAt?: number; }
interface State {
  seenIds: string[];
  bootstrapped: boolean;
  pollCount: number;
  notifyCount: number;
  consecutiveErrors: number;
  lastError?: string;
  lastPollAt?: number;
}

const initialState = (): State => ({
  seenIds: [], bootstrapped: false, pollCount: 0, notifyCount: 0, consecutiveErrors: 0,
});

async function loadState(): Promise<State> {
  try { return { ...initialState(), ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) }; }
  catch { return initialState(); }
}
async function saveState(s: State): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

function fmtKST(epochMs: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(epochMs));
}

function extractPlayers(body: unknown): Player[] {
  if (Array.isArray(body)) return body as Player[];
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.players)) return o.players as Player[];
    if (o.record !== undefined) return extractPlayers(o.record);
  }
  return [];
}

async function fetchPlayers(): Promise<Player[]> {
  const url = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`;
  const res = await fetch(url, {
    headers: { 'X-Master-Key': JSONBIN_MASTER_KEY!, 'X-Bin-Meta': 'false' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jsonbin ${res.status}: ${body.slice(0, 200)}`);
  }
  return extractPlayers(await res.json());
}

function playerKey(p: Player): string {
  if (p.id) return p.id;
  return `${p.name ?? ''}|${p.player ?? ''}|${p.createdAt ?? ''}`;
}

async function notifyNew(p: Player): Promise<void> {
  const lines = [
    ':soccer: *축구선수 보드 — 새 등록*',
    `• 이름: *${p.name ?? '?'}*`,
    `• 좋아하는 선수: *${p.player ?? '?'}*`,
  ];
  if (p.createdAt) lines.push(`• 등록 시각: ${fmtKST(p.createdAt)} KST`);
  lines.push(`<${PAGE_URL}|보드 열기>`);
  await slack.chat.postMessage({
    channel: ALERT_TARGET!,
    text: lines.join('\n'),
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function pollOnce(state: State): Promise<State> {
  const players = await fetchPlayers();
  state.pollCount += 1;
  state.consecutiveErrors = 0;
  state.lastPollAt = Date.now();

  if (!state.bootstrapped) {
    state.seenIds = players.map(playerKey);
    state.bootstrapped = true;
    console.log(`[bootstrap] marked ${players.length} existing items as seen`);
    await saveState(state);
    return state;
  }

  const seen = new Set(state.seenIds);
  const newOnes = players.filter((p) => !seen.has(playerKey(p)));

  if (newOnes.length === 0) {
    if (state.pollCount % 12 === 1) {
      console.log(`[poll #${state.pollCount}] seen=${state.seenIds.length} no new`);
    }
    await saveState(state);
    return state;
  }

  newOnes.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  console.log(`[notify] ${newOnes.length} new entries`);
  for (const p of newOnes) {
    try {
      await notifyNew(p);
      state.seenIds.push(playerKey(p));
      state.notifyCount += 1;
    } catch (err) {
      console.warn(`[notify-fail] ${playerKey(p)}: ${(err as Error).message}`);
    }
  }
  await saveState(state);
  return state;
}

let stopping = false;
const stop = (sig: string) => { console.log(`[${sig}]`); stopping = true; };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

(async () => {
  console.log(`[start] interval=${POLL_MS}ms bin=${JSONBIN_BIN_ID} target=${ALERT_TARGET}`);
  let state = await loadState();
  while (!stopping) {
    try {
      state = await pollOnce(state);
    } catch (err) {
      state.consecutiveErrors += 1;
      state.lastError = (err as Error).message;
      console.warn(`[poll-err #${state.consecutiveErrors}] ${state.lastError}`);
      await saveState(state);
    }
    const backoff = state.consecutiveErrors >= 3 ? Math.min(POLL_MS * 4, 30 * 60_000) : POLL_MS;
    await new Promise((r) => setTimeout(r, backoff));
  }
  console.log('[stop] exiting');
  process.exit(0);
})();
