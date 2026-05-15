#!/usr/bin/env bash
# PreToolUse hook for Edit / Write / MultiEdit.
# - Blocks protected files (.env, .pem, .key, .git/config, /etc/)
# - Blocks build artifacts (node_modules/, dist/, build/) and lock files
# - Blocks files larger than 1 MB
#
# Stdin: { tool_input: { file_path | notebook_path: "..." } }

set -uo pipefail

input=$(cat || true)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""' 2>/dev/null || echo "")
[ -z "$file" ] && exit 0

deny() {
  reason="$1"
  jq -n --arg r "$reason" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $r
    }
  }'
  exit 0
}

# ── Protected files ──
base=$(basename "$file")
case "$file" in
  */.env|*/.env.*|*.pem|*.key|*/.git/config|/etc/*|/etc)
    deny "보호된 파일 수정 차단: $file"
    ;;
esac
case "$base" in
  .env|.env.*)
    deny "보호된 파일 수정 차단: $file"
    ;;
esac

# ── Build artifacts / lock files ──
case "$file" in
  */node_modules/*|*/dist/*|*/build/*)
    deny "빌드 산출물/의존성 디렉토리 수정 차단: $file"
    ;;
esac

case "$base" in
  package-lock.json) ;;  # allowed (npm-managed but commit-worthy)
  *.lock)
    deny "lock 파일 직접 수정 차단: $file"
    ;;
esac

# ── 1 MB threshold ──
if [ -f "$file" ]; then
  size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo 0)
  if [ "$size" -gt 1048576 ]; then
    deny "1 MB 초과 파일 수정 차단: $file ($size bytes)"
  fi
fi

exit 0
