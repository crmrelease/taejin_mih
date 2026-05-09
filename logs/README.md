# 작업/결정 로그

각 에이전트(`som`, `rang`, `mo`)가 슬랙 멘션을 처리할 때마다 자동으로 기록을 남깁니다.

## 구조

```
logs/
├── som/          # 솜이(리서치/유지보수) 로그
│   └── YYYY-MM-DD.md
├── rang/         # 랑이 로그
│   └── YYYY-MM-DD.md
└── mo/           # 모 로그
    └── YYYY-MM-DD.md
```

## 자동 기록 형식

각 일별 파일은 다음 형식으로 누적됩니다.

```markdown
## HH:MM — <@user> · <#channel> (`thread_ts`)

**요청**
> 사용자 메시지 내용

**처리 요약**
응답 첫 4줄 또는 400자
```

## 작성 주체

- 각 에이전트의 Slack 봇 (`agent_*/bot/src/index.ts`) 이 멘션 처리 후 자동 작성
- worktree(`/tmp/<agent>-logs-wt`)를 통해 main 브랜치에 직접 push
- 충돌 시 1회 rebase 후 재시도
