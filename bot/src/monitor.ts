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
const ERROR_CHANNEL = process.env.MONITOR_ERROR_CHANNEL;
const OWNER_USER_ID = process.env.MONITOR_OWNER_USER_ID;
const DEV_USER_ID = process.env.MONITOR_DEV_USER_ID;
const POLL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 300_000;
const INCIDENT_TIMEOUT_MS = Number(process.env.MONITOR_INCIDENT_TIMEOUT_MS) || 600_000;
const PAGE_URL = process.env.MONITOR_PAGE_URL || 'https://crmrelease.github.io/taejin_mih/players.html';
const IMGBB_PROBE_URL = process.env.MONITOR_IMGBB_URL || 'https://api.imgbb.com/1/upload';

if (!SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN missing in .env'); process.exit(1); }
if (!JSONBIN_MASTER_KEY) { console.error('JSONBIN_MASTER_KEY missing in .env'); process.exit(1); }
if (!ALERT_TARGET) { console.error('MONITOR_ALERT_TARGET missing in .env (Slack user or channel id)'); process.exit(1); }

const slack = new WebClient(SLACK_BOT_TOKEN);

type HealthStatus = 'up' | 'down' | 'unknown';
type Category = 'page' | 'bin' | 'imgbb';

interface Player {
  id?: string;
  name?: string;
  player?: string;
  photoUrl?: string;
  createdAt?: number;
}

interface Incident {
  category: Category;
  startedAt: number;
  failureReportedAt?: number;
  lastError: string;
}

interface State {
  seenIds: string[];
  bootstrapped: boolean;
  pollCount: number;
  notifyCount: number;
  consecutiveErrors: number;
  lastError?: string;
  lastPollAt?: number;
  pageStatus: HealthStatus;
  binStatus: HealthStatus;
  imgbbStatus: HealthStatus;
  pageFailCount: number;
  binFailCount: number;
  imgbbFailCount: number;
  incidents: Record<string, Incident>;
}

const FAIL_THRESHOLD = 2;

const initialState = (): State => ({
  seenIds: [], bootstrapped: false, pollCount: 0, notifyCount: 0, consecutiveErrors: 0,
  pageStatus: 'unknown', binStatus: 'unknown', imgbbStatus: 'unknown',
  pageFailCount: 0, binFailCount: 0, imgbbFailCount: 0,
  incidents: {},
});

async function loadState(): Promise<State> {
  try {
    const merged = { ...initialState(), ...JSON.parse(await fs.readFile(STATE_FILE, 'utf8')) };
    if (!merged.incidents) merged.incidents = {};
    return merged;
  } catch { return initialState(); }
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

const errorChannel = (): string => ERROR_CHANNEL || ALERT_TARGET!;

const categoryLabel: Record<Category, string> = {
  page: '페이지',
  bin: 'JSONBin',
  imgbb: 'imgbb',
};

async function postSafe(args: Parameters<typeof slack.chat.postMessage>[0]): Promise<void> {
  try { await slack.chat.postMessage(args); }
  catch (err) { console.warn(`[slack-post-fail] ${(err as Error).message}`); }
}

async function notifyIncidentOpened(category: Category, detail: string): Promise<void> {
  const lines = [
    `:rotating_light: *인프라 — ${categoryLabel[category]} 응답 실패*`,
    detail,
    '_자가 복구 시도 중. 결과는 해결/실패 시 다시 보고합니다._',
  ];
  await postSafe({ channel: errorChannel(), text: lines.join('\n'), unfurl_links: false, unfurl_media: false });
}

async function notifyIncidentRecovered(category: Category, downMs: number): Promise<void> {
  const mins = Math.max(1, Math.round(downMs / 60_000));
  const lines = [
    `:white_check_mark: *인프라 — ${categoryLabel[category]} 자가 복구 완료*`,
    `다운 ${mins}분 후 회복.`,
  ];
  if (OWNER_USER_ID) lines.push(`<@${OWNER_USER_ID}>`);
  await postSafe({ channel: errorChannel(), text: lines.join('\n'), unfurl_links: false, unfurl_media: false });
}

async function notifyIncidentFailed(category: Category, elapsedMs: number, lastError: string): Promise<void> {
  const mins = Math.round(elapsedMs / 60_000);
  const lines = [
    `:x: *인프라 — ${categoryLabel[category]} 자가 복구 실패 (${mins}분 경과)*`,
    `최근 에러: \`${lastError.slice(0, 200)}\``,
    '자가 시도는 계속합니다. 사람 개입이 필요할 수 있습니다.',
  ];
  if (OWNER_USER_ID) lines.push(`<@${OWNER_USER_ID}>`);
  if (category === 'page' && DEV_USER_ID) lines.push(`<@${DEV_USER_ID}> (frontend 측 점검 부탁)`);
  await postSafe({ channel: errorChannel(), text: lines.join('\n'), unfurl_links: false, unfurl_media: false });
}

async function trackHealth(
  state: State,
  category: Category,
  ok: boolean,
  detail: string,
): Promise<void> {
  const failKey = (category + 'FailCount') as 'pageFailCount' | 'binFailCount' | 'imgbbFailCount';
  const statusKey = (category + 'Status') as 'pageStatus' | 'binStatus' | 'imgbbStatus';
  const inc = state.incidents[category];

  if (ok) {
    state[failKey] = 0;
    if (inc) {
      const downMs = Date.now() - inc.startedAt;
      await notifyIncidentRecovered(category, downMs);
      delete state.incidents[category];
    }
    state[statusKey] = 'up';
    return;
  }

  state[failKey] += 1;
  if (state[failKey] < FAIL_THRESHOLD) return;
  state[statusKey] = 'down';

  if (!inc) {
    state.incidents[category] = {
      category,
      startedAt: Date.now(),
      lastError: detail,
    };
    await notifyIncidentOpened(category, detail);
    return;
  }

  inc.lastError = detail;
  const elapsed = Date.now() - inc.startedAt;
  if (elapsed >= INCIDENT_TIMEOUT_MS && !inc.failureReportedAt) {
    inc.failureReportedAt = Date.now();
    await notifyIncidentFailed(category, elapsed, detail);
  }
}

async function checkPage(state: State): Promise<void> {
  let ok = false;
  let detail = '';
  try {
    const res = await fetch(PAGE_URL);
    ok = res.ok;
    detail = `HTTP ${res.status} — ${PAGE_URL}`;
  } catch (err) {
    detail = `fetch error: ${(err as Error).message.slice(0, 120)} — ${PAGE_URL}`;
  }
  await trackHealth(state, 'page', ok, detail);
}

async function checkImgbb(state: State): Promise<void> {
  let ok = false;
  let detail = '';
  try {
    const res = await fetch(IMGBB_PROBE_URL, { method: 'HEAD' });
    ok = res.status < 500;
    detail = `HTTP ${res.status} — imgbb`;
  } catch (err) {
    detail = `fetch error: ${(err as Error).message.slice(0, 120)} — imgbb`;
  }
  await trackHealth(state, 'imgbb', ok, detail);
}

async function notifyNew(p: Player): Promise<void> {
  const lines = [
    ':soccer: *축구선수 보드 — 새 등록*',
    `• 이름: *${p.name ?? '?'}*`,
    `• 좋아하는 선수: *${p.player ?? '?'}*`,
  ];
  if (p.createdAt) lines.push(`• 등록 시각: ${fmtKST(p.createdAt)} KST`);
  lines.push(`<${PAGE_URL}|보드 열기>`);
  if (p.photoUrl) {
    lines.push('');
    lines.push(p.photoUrl);
  }
  await slack.chat.postMessage({
    channel: ALERT_TARGET!,
    text: lines.join('\n'),
    unfurl_links: !!p.photoUrl,
    unfurl_media: !!p.photoUrl,
  });
}

async function pollOnce(state: State): Promise<State> {
  await checkPage(state);
  await checkImgbb(state);

  let players: Player[];
  try {
    players = await fetchPlayers();
  } catch (err) {
    await trackHealth(state, 'bin', false, (err as Error).message.slice(0, 200));
    await saveState(state);
    throw err;
  }
  await trackHealth(state, 'bin', true, 'OK');

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
  console.log(`[start] interval=${POLL_MS}ms bin=${JSONBIN_BIN_ID} target=${ALERT_TARGET} errorCh=${ERROR_CHANNEL ?? '(fallback to target)'}`);
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
