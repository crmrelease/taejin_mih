# 작업 규칙 (taejin_mih)

이 repo는 두 Claude agent 워크스페이스가 공유한다.

## 워크스페이스별 작업 브랜치
- `agent_rang` 워크스페이스 → `rang` 브랜치에서만 작업
- `agent_som` 워크스페이스 → `som` 브랜치에서만 작업
- `main`은 통합 대상. agent들은 직접 푸시하지 않고 PR/사용자 검토를 거쳐 머지된다.

## 응답 스타일
- 사용자에게 응답할 때는 **존댓말**을 사용한다. 반말은 사용하지 않는다.

## 토큰 관리
- GitHub 토큰은 각 워크스페이스의 `.env`에서 관리하며 절대 커밋하지 않는다 (`.gitignore`로 차단).
- 푸시할 때 `origin` URL에 토큰을 박지 않고, `.env`를 source한 뒤 inline tokenized URL을 사용한다.
