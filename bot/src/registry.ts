import path from 'node:path';
import { promises as fs } from 'node:fs';

const REGISTRY_DIR = '/Users/somi/Desktop/mih/.agents';

export interface AgentInfo {
  name: string;
  userId: string;
  updatedAt: string;
}

export async function registerSelf(name: string, userId: string): Promise<void> {
  await fs.mkdir(REGISTRY_DIR, { recursive: true });
  const file = path.join(REGISTRY_DIR, `${name}.json`);
  const info: AgentInfo = { name, userId, updatedAt: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(info, null, 2));
}

export async function loadRegistry(): Promise<AgentInfo[]> {
  try {
    const entries = await fs.readdir(REGISTRY_DIR);
    const agents: AgentInfo[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(REGISTRY_DIR, entry), 'utf8');
        agents.push(JSON.parse(content) as AgentInfo);
      } catch {
        // ignore individual file failures
      }
    }
    return agents;
  } catch {
    return [];
  }
}

export function formatRegistryForPrompt(agents: AgentInfo[], selfName: string): string {
  if (agents.length === 0) return '';
  const lines = agents.map((a) => {
    const tag = a.name === selfName ? ' (나)' : '';
    return `- ${a.name}${tag}: <@${a.userId}>`;
  });
  return [
    '<agent_registry>',
    '협업 중인 에이전트들의 슬랙 사용자 ID입니다. 다른 에이전트를 깨우거나 직접 멘션하려면 메시지 본문에 `<@USER_ID>` 형식으로 넣으세요. 그러면 해당 봇이 app_mention 이벤트로 받아 응답합니다.',
    '',
    ...lines,
    '',
    '예시: 답변에 `<@U12345ABC>` 라고 쓰면 그 에이전트가 깨어납니다. 무한 루프 방지를 위해 꼭 필요할 때만 사용하세요.',
    '</agent_registry>',
    '',
  ].join('\n');
}
