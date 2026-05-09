# 멀티 에이전트(솜·랑·모) 메모리·세션 아키텍처

> 작성: 2026-05-09 · 솜이
> 대상 레포: [crmrelease/taejin_mih](https://github.com/crmrelease/taejin_mih)

이 문서는 슬랙 봇으로 운영되는 세 에이전트가 **무엇을 기억하고, 어디에, 얼마나 오래** 저장하는지 정리합니다. 새 에이전트를 추가하거나 기억 공유 범위를 바꿀 때 참고용입니다.

## TL;DR

- 같은 슬랙 스레드 = 같은 Claude 세션 (`--resume`).
- 같은 스레드에서는 세 에이전트가 서로의 발언을 봄 (옵션 A).
- 새 스레드/새 세션에서는 각 에이전트가 자기 자동 메모리만 참조 — **에이전트별 분리**.
- 모든 멘션은 `logs/<agent>/YYYY-MM-DD.md`에 표면 요약으로 자동 누적되어 main에 커밋됨.

## 1. 기억이 저장되는 3가지 장소

| 저장소 | 들어가는 내용 | 위치 | 공유 범위 | 영속성 |
|---|---|---|---|---|
| **세션 캐시** | 스레드의 풀 트랜스크립트 (도구 사용·내부 추론·검색 결과 포함) | `~/.claude/projects/<encoded-cwd>/sessions/<session_id>.jsonl` | 에이전트별, 스레드별 | 디스크 보존 |
| **자동 메모리 (auto-memory)** | 사용자 선호·피드백·프로젝트 사실 등 세션을 넘어 유지하고 싶은 것 | `~/.claude/projects/<encoded-cwd>/memory/*.md` | 에이전트별 (다른 에이전트는 못 봄) | 디스크 보존, 명시적으로 작성 |
| **워크 로그** | 멘션·응답의 표면 요약 (질문 + 응답 첫 4줄/400자) | `<repo>/logs/<agent>/YYYY-MM-DD.md` | **세 에이전트 모두 공유** (main에 commit) | git 영구 보존 |

> 핵심: 자동 메모리는 *에이전트의 두뇌*, 워크 로그는 *팀 회의록*에 가깝습니다.

## 2. 슬랙 스레드 ↔ Claude 세션 매핑

각 봇은 슬랙 `thread_ts`를 키로 Claude `session_id`를 매핑합니다.

```
agent_<name>/bot/sessions.json
{
  "1715234567.890": "78a03ac2-dc3c-...",
  "1715240000.123": "a1b2c3d4-e5f6-..."
}
```

- 첫 멘션: 새 Claude 세션 생성 → `session_id` 저장.
- 후속 멘션 (같은 스레드): `claude -p "..." --resume <session_id>` → 이전 대화 그대로 이어감.
- 새 스레드: 다른 `thread_ts` → 새 세션.

`bot/sessions.json` 자체는 `.gitignore`로 차단되어 워크스페이스별 로컬 캐시로만 존재합니다.

## 3. 옵션 A — 스레드 풀 컨텍스트 주입 (크로스 에이전트 협업)

각 봇은 멘션을 받을 때 `conversations.replies`로 **스레드 전체**를 가져와 프롬프트 앞에 `<thread_history>` 블록으로 넣습니다.

```
<thread_history>
[<@user>] 내가 좋아하는 색은 보라색이야
[rang-bot] 보라색 멋지네요. 기억해둘게요.
</thread_history>

<user_request>
내가 무슨 색 좋아한다고 했지?
</user_request>
```

이로써 같은 스레드 안에서는 **솜·랑·모가 서로의 발언을 모두 인지**합니다. 새 스레드에서는 효과가 없습니다.

`--resume`도 함께 유지되므로 봇 자신의 도구 사용 이력은 자동 메모리/세션 캐시에서 회상되고, 팀 발언은 주입 컨텍스트에서 회상됩니다.

## 4. 워크 로그 (자동 push to main)

각 봇이 멘션 처리 후 다음을 수행합니다.

1. `/tmp/<agent>-logs-wt` git worktree를 main 기준으로 갱신
2. `logs/<agent>/<오늘날짜>.md`에 한 블록 append:
   ```markdown
   ## HH:MM — <@user> · <#channel> (`thread_ts`)

   **요청**
   > 사용자 메시지

   **처리 요약**
   응답 첫 4줄 또는 400자
   ```
3. `commit` + `push origin HEAD:main`
4. 푸시 충돌 시 1회 `rebase` 후 재시도, 그래도 실패하면 슬랙 답변은 정상 진행하고 경고만 로그.

워크 로그는 표면만 담습니다 — 봇 내부의 도구 사용·추론은 세션 캐시에 남고 워크 로그에는 안 들어갑니다.

## 5. 시나리오별 "기억" 유무

| 상황 | 답할 수 있나? | 근거 |
|---|---|---|
| 같은 스레드 후속 멘션, 자기 발언 회상 | ✅ | `--resume` 세션 |
| 같은 스레드, 다른 에이전트 발언 회상 | ✅ | 옵션 A 컨텍스트 |
| 새 스레드, 자동 메모리에 적힌 사용자 선호 회상 | ✅ (그 에이전트 한정) | 자동 메모리 MD |
| 새 스레드, **다른 에이전트가** 자동 메모리에 적은 내용 회상 | ❌ | 메모리 분리 |
| 봇 재시작 후 같은 스레드 이어가기 | ✅ | `sessions.json` 디스크 보존 |
| 맥북 재부팅 후 | ✅ | 캐시 디스크 보존, 봇만 재기동 |
| `~/.claude/projects/...` 통째로 삭제 후 | ❌ | `--resume` 실패, 폴백 미구현 (V2 후보) |

## 6. 한계와 향후 후보

- **세션 캐시 손실 시 자동 폴백**: 현재는 에러 답변. 워크 로그를 다시 주입해 새 세션으로 시작하도록 보강 가능.
- **자동 메모리 공유**: 세 에이전트가 공통으로 읽는 "팀 메모리" 디렉토리 셋업.
- **로그 풀 트랜스크립트 옵션**: 요약 대신 전체 대화를 묶어서 보관 (선택적).
- **클라우드 호스팅**: Mac이 꺼져 있어도 봇이 동작하도록 옮기려면 API 키 또는 헤드리스 인증 필요 (Max 구독 한정에선 어려움).

## 7. 관련 파일/경로 한눈에

| 파일 | 역할 |
|---|---|
| `agent_<name>/bot/src/index.ts` | 봇 본체 (Slack Bolt + Claude subprocess + 로그 push) |
| `agent_<name>/bot/sessions.json` | 스레드 → 세션 매핑 (gitignored) |
| `agent_<name>/.env` | Slack 토큰, GitHub 토큰 (gitignored, chmod 600) |
| `agent_<name>/CLAUDE.md` | 모든 에이전트 공유 규칙 (커밋됨) |
| `agent_<name>/CLAUDE.local.md` | 에이전트별 페르소나 (gitignored) |
| `<repo>/logs/<agent>/YYYY-MM-DD.md` | 일별 작업 로그 (커밋됨) |
| `/tmp/<agent>-logs-wt/` | 봇이 main에 push할 때 쓰는 worktree |
| `~/.claude/projects/<encoded-cwd>/sessions/` | Claude 세션 캐시 |
| `~/.claude/projects/<encoded-cwd>/memory/` | 자동 메모리 (에이전트별) |
