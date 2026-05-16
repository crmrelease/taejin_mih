#!/usr/bin/env bash
# PreToolUse hook for Bash.
# - Blocks dangerous commands (rm -rf /, sudo, force push, etc.)
# - Blocks curl|sh / wget|sh patterns
# - Gates git commit when bot/scripts changes are staged (typecheck must pass)
#
# Stdin: { tool_input: { command: "..." }, ... }
# Stdout: JSON with hookSpecificOutput.permissionDecision = "deny" if blocked.
# Allow path: silent exit 0.

set -uo pipefail

input=$(cat || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[ -z "$cmd" ] && exit 0

# Strip the leading `git commit -m "..." / -F file` body before pattern checks —
# commit messages often quote example commands and shouldn't trigger denials.
# We still run the typecheck gate further below on git commit.
is_git_commit=0
case "$cmd" in
  git\ commit*|*\;\ git\ commit*|*\|\ git\ commit*|*\&\&\ git\ commit*)
    is_git_commit=1
    ;;
esac

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

if [ "$is_git_commit" -eq 1 ]; then
  # Skip dangerous-pattern checks for git commit (message body may quote examples).
  # Jump directly to the typecheck gate.
  goto_typecheck=1
fi

if [ "${goto_typecheck:-0}" -ne 1 ]; then
# ── Dangerous patterns (regex, case-sensitive) ──
# rm -rf / or ~ or $HOME
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)[[:space:]]+(/|\$HOME|~)([[:space:]]|$)'; then
  deny "위험: rm -rf 시스템 경로 차단"
fi

# Force push (but allow --force-with-lease)
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push'; then
  if printf '%s' "$cmd" | grep -qE '(--force([^-]|$)|[[:space:]]-f([[:space:]]|$))'; then
    if ! printf '%s' "$cmd" | grep -qE -- '--force-with-lease'; then
      deny "위험: git push --force (--force-with-lease 사용 권장)"
    fi
  fi
fi

# git reset --hard on origin/main
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard[[:space:]]+(origin/)?main'; then
  deny "위험: main 강제 리셋 차단"
fi

# sudo
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])sudo[[:space:]]'; then
  deny "위험: sudo 사용 차단"
fi

# chmod 777
if printf '%s' "$cmd" | grep -qE 'chmod[[:space:]]+[-A-Za-z0-9]*777'; then
  deny "위험: chmod 777 차단"
fi

# curl/wget piped to shell (exfil/exec risk)
if printf '%s' "$cmd" | grep -qE '(curl|wget)[^|]*\|[[:space:]]*(bash|sh|zsh)([[:space:]]|$)'; then
  deny "위험: curl|sh / wget|sh 외부 스크립트 실행 차단"
fi
fi  # end goto_typecheck guard

# ── git commit 전 typecheck 게이트 ──
# Only fires for git commit invocations; only runs typecheck when bot/ or scripts/ is staged.
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+commit'; then
  repo_root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
  if [ -d "$repo_root/bot" ]; then
    cd "$repo_root" 2>/dev/null || exit 0
    staged=$(git diff --cached --name-only 2>/dev/null || true)
    if printf '%s\n' "$staged" | grep -qE '^(bot/|scripts/)'; then
      if [ -f "$repo_root/bot/package.json" ]; then
        if ! npm --prefix "$repo_root/bot" run typecheck >/tmp/claude-typecheck.log 2>&1; then
          deny "bot/scripts/ 변경 커밋 차단 — typecheck 실패. 로그: /tmp/claude-typecheck.log"
        fi
      fi
    fi
  fi
fi

exit 0
