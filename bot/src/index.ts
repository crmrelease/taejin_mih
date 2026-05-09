import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { App, LogLevel } from '@slack/bolt';
import { registerSelf, loadRegistry, formatRegistryForPrompt } from './registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(__dirname, '../..');
const AGENT_NAME = path.basename(WORKSPACE_DIR).replace(/^agent_/, '');
const SESSIONS_FILE = path.resolve(__dirname, '../sessions.json');
const LOGS_WORKTREE = `/tmp/${AGENT_NAME}-logs-wt`;

dotenv.config({ path: path.resolve(WORKSPACE_DIR, '.env') });

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'crmrelease';
const GITHUB_REPO = process.env.GITHUB_REPO || 'taejin_mih';

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(`Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN in ${path.basename(WORKSPACE_DIR)}/.env`);
  process.exit(1);
}

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO,
});

// ───────────────── Claude session continuity ─────────────────

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  result?: string;
  session_id?: string;
  is_error?: boolean;
  error?: string;
}

async function loadSessions(): Promise<Record<string, string>> {
  try { return JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}

async function saveSession(threadKey: string, sessionId: string): Promise<void> {
  const sessions = await loadSessions();
  if (sessions[threadKey] === sessionId) return;
  sessions[threadKey] = sessionId;
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function runClaude(prompt: string, sessionId?: string): Promise<{ text: string; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--add-dir', WORKSPACE_DIR,
      '--dangerously-skip-permissions',
      '--output-format', 'json',
    ];
    if (sessionId) args.push('--resume', sessionId);

    const proc = spawn('claude', args, { cwd: WORKSPACE_DIR });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}\n${stderr || stdout}`));
      try {
        const parsed: ClaudeJsonResult = JSON.parse(stdout.trim());
        if (parsed.is_error) return reject(new Error(parsed.error || 'Claude error'));
        resolve({
          text: parsed.result || '(빈 응답)',
          sessionId: parsed.session_id || '',
        });
      } catch (err) {
        reject(new Error(`parse failed: ${(err as Error).message}\n${stdout.slice(0, 500)}`));
      }
    });
  });
}

// ───────────────── Work log + git push (worktree to main) ─────────────────

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.slice(0, 4).join(' ')} exited ${code}: ${(stderr || stdout).trim()}`));
    });
  });
}

async function ensureWorktreeFresh(): Promise<void> {
  let exists = false;
  try { await fs.access(LOGS_WORKTREE); exists = true; } catch {}

  if (exists) {
    try {
      await execGit(['fetch', 'origin', 'main'], LOGS_WORKTREE);
      await execGit(['reset', '--hard', 'origin/main'], LOGS_WORKTREE);
      await execGit(['clean', '-fd'], LOGS_WORKTREE);
      return;
    } catch {
      // fall through to recreate
    }
  }

  try { await execGit(['worktree', 'remove', '--force', LOGS_WORKTREE], WORKSPACE_DIR); } catch {}
  try { await fs.rm(LOGS_WORKTREE, { recursive: true, force: true }); } catch {}
  await execGit(['fetch', 'origin', 'main'], WORKSPACE_DIR);
  await execGit(['worktree', 'add', '--detach', LOGS_WORKTREE, 'origin/main'], WORKSPACE_DIR);
}

function nowKST(): { date: string; time: string } {
  const d = new Date();
  const dateF = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const timeF = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return { date: dateF.format(d), time: timeF.format(d) };
}

let logMutex: Promise<void> = Promise.resolve();
function lockedLog(fn: () => Promise<void>): Promise<void> {
  const next = logMutex.then(() => fn().catch((e) => console.error('log error:', (e as Error).message)));
  logMutex = next;
  return next;
}

async function writeAndPushLog(entry: { user: string; channel: string; thread: string; question: string; answer: string }): Promise<void> {
  if (!GITHUB_TOKEN) {
    console.warn('GITHUB_TOKEN missing — skipping log push');
    return;
  }

  await ensureWorktreeFresh();

  const { date, time } = nowKST();
  const logsDir = path.join(LOGS_WORKTREE, 'logs', AGENT_NAME);
  await fs.mkdir(logsDir, { recursive: true });
  const file = path.join(logsDir, `${date}.md`);

  let exists = false;
  try { await fs.access(file); exists = true; } catch {}

  const summaryLines = entry.answer.split('\n').filter((l) => l.trim()).slice(0, 4);
  const summary = summaryLines.join('\n').slice(0, 400);
  const truncated = entry.answer.length > 400 ? '\n*(이하 생략 — 슬랙 스레드 참고)*' : '';

  const block = [
    ``,
    `## ${time} — ${entry.user} · <#${entry.channel}> (\`${entry.thread}\`)`,
    ``,
    `**요청**`,
    `> ${entry.question.replace(/\n/g, '\n> ')}`,
    ``,
    `**처리 요약**`,
    summary + truncated,
    ``,
  ].join('\n');

  if (!exists) {
    const header = `# ${AGENT_NAME} — ${date}\n\n${AGENT_NAME} 에이전트의 일별 작업/결정 로그.\n`;
    await fs.writeFile(file, header + block);
  } else {
    await fs.appendFile(file, block);
  }

  const tokenizedRemote = `https://${GITHUB_USERNAME}:${GITHUB_TOKEN}@github.com/${GITHUB_USERNAME}/${GITHUB_REPO}.git`;
  const rel = path.relative(LOGS_WORKTREE, file);

  await execGit(['add', rel], LOGS_WORKTREE);
  await execGit([
    '-c', 'user.email=bot@taejin.local',
    '-c', `user.name=${AGENT_NAME}-bot`,
    'commit', '-m', `log(${AGENT_NAME}): ${date} ${time}`,
  ], LOGS_WORKTREE);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await execGit(['push', tokenizedRemote, 'HEAD:main'], LOGS_WORKTREE);
      return;
    } catch (err) {
      if (attempt === 0) {
        try {
          await execGit(['fetch', 'origin', 'main'], LOGS_WORKTREE);
          await execGit(['rebase', 'origin/main'], LOGS_WORKTREE);
        } catch {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }
}

// ───────────────── Slack thread context ─────────────────

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  subtype?: string;
}

async function fetchThreadContext(
  client: { conversations: { replies: (args: { channel: string; ts: string; limit?: number }) => Promise<{ messages?: SlackMessage[] }> } },
  channel: string,
  threadTs: string,
  currentTs: string,
): Promise<string> {
  try {
    const res = await client.conversations.replies({ channel, ts: threadTs, limit: 200 });
    const msgs = res.messages ?? [];
    if (msgs.length === 0) return '';

    const lines: string[] = [];
    for (const m of msgs) {
      if (m.ts === currentTs) continue;
      if (m.subtype === 'bot_message' && m.text === '_작성 중..._') continue;
      const speaker = m.bot_id
        ? (m.username || m.bot_profile?.name || `bot:${m.bot_id}`)
        : (m.user ? `<@${m.user}>` : 'unknown');
      const text = (m.text ?? '').replace(/<@[A-Z0-9]+>\s*/g, '').trim();
      if (!text || text === '_작성 중..._') continue;
      lines.push(`[${speaker}] ${text}`);
    }
    if (lines.length === 0) return '';

    return [
      '<thread_history>',
      '아래는 이 슬랙 스레드의 이전 대화입니다 (시간순). 사용자와 다른 에이전트(솜/랑/모)의 발언이 모두 포함되며, 그들과 자연스럽게 협업하세요.',
      '',
      lines.join('\n'),
      '</thread_history>',
      '',
    ].join('\n');
  } catch (err) {
    console.warn(`thread context fetch failed: ${(err as Error).message}`);
    return '';
  }
}

// ───────────────── Slack handler ─────────────────

const stripMention = (text: string) => text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();

app.event('app_mention', async ({ event, client, logger }) => {
  const channel = event.channel;
  const ts = event.ts;
  const e = event as unknown as { thread_ts?: string; user?: string; text?: string };
  const threadKey = e.thread_ts || ts;
  const userText = stripMention(e.text ?? '');
  const userId = e.user || 'unknown';

  let thinkingTs: string | undefined;
  let eyesAdded = false;
  const progressTickers: Array<{ ts: string }> = [];
  const progressTimers: NodeJS.Timeout[] = [];
  const startedAt = Date.now();

  const scheduleProgressTick = (delayMs: number) => {
    const timer = setTimeout(async () => {
      try {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const res = await client.chat.postMessage({
          channel,
          thread_ts: e.thread_ts || ts,
          text: `_:hourglass_flowing_sand: 아직 작업 중입니다 (${elapsedSec}초 경과)._`,
        });
        if (res.ts) progressTickers.push({ ts: res.ts });
      } catch (err) {
        logger.warn(`progress push failed: ${(err as Error).message}`);
      }
    }, delayMs);
    progressTimers.push(timer);
  };

  const cleanupProgress = async () => {
    for (const t of progressTimers) clearTimeout(t);
    for (const tick of progressTickers) {
      await client.chat.delete({ channel, ts: tick.ts }).catch(() => {});
    }
  };

  try {
    await client.reactions.add({ channel, timestamp: ts, name: 'eyes' });
    eyesAdded = true;

    const thinking = await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: '_작성 중..._',
    });
    thinkingTs = thinking.ts;

    scheduleProgressTick(60_000);
    scheduleProgressTick(180_000);
    scheduleProgressTick(420_000);

    let answer: string;
    if (!userText) {
      answer = '안녕하세요. 무엇을 도와드릴까요?';
    } else {
      const sessions = await loadSessions();
      const existing = sessions[threadKey];
      const threadCtx = e.thread_ts
        ? await fetchThreadContext(client, channel, threadKey, ts)
        : '';
      const registry = await loadRegistry();
      const registryCtx = formatRegistryForPrompt(registry, AGENT_NAME);
      const prompt = registryCtx + threadCtx + `<user_request>\n${userText}\n</user_request>`;
      const { text, sessionId } = await runClaude(prompt, existing);
      answer = text;
      if (sessionId) await saveSession(threadKey, sessionId);
    }

    await cleanupProgress();

    await client.chat.update({
      channel,
      ts: thinkingTs!,
      text: answer.slice(0, 39000),
    });

    if (eyesAdded) {
      await client.reactions.remove({ channel, timestamp: ts, name: 'eyes' });
    }
    await client.reactions.add({ channel, timestamp: ts, name: 'white_check_mark' });

    if (userText) {
      lockedLog(() => writeAndPushLog({
        user: `<@${userId}>`,
        channel,
        thread: threadKey,
        question: userText,
        answer,
      })).catch((err) => logger.warn(`log push failed: ${(err as Error).message}`));
    }
  } catch (err) {
    logger.error(err);
    await cleanupProgress();
    const msg = err instanceof Error ? err.message : String(err);
    if (thinkingTs) {
      await client.chat.update({
        channel,
        ts: thinkingTs,
        text: `:x: 에러: ${msg.slice(0, 2000)}`,
      }).catch(() => {});
    }
    if (eyesAdded) {
      await client.reactions.remove({ channel, timestamp: ts, name: 'eyes' }).catch(() => {});
    }
    await client.reactions.add({ channel, timestamp: ts, name: 'x' }).catch(() => {});
  }
});

(async () => {
  await app.start();
  try {
    const auth = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
    const userId = auth.user_id;
    if (typeof userId === 'string' && userId.length > 0) {
      await registerSelf(AGENT_NAME, userId);
      console.log(`registry: ${AGENT_NAME} → ${userId}`);
    } else {
      console.warn(`registry: auth.test returned no user_id for ${AGENT_NAME}`);
    }
  } catch (err) {
    console.warn(`registry: failed to register ${AGENT_NAME}: ${(err as Error).message}`);
  }
  console.log(`⚡ ${AGENT_NAME}-bot is running (Socket Mode)`);
})();
