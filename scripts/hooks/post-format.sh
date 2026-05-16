#!/usr/bin/env bash
# PostToolUse hook for Edit / Write / MultiEdit.
# Auto-runs prettier on the modified file when:
# - The path matches a supported extension
# - prettier is installed (via npx or globally)
# Silent failure — never blocks tool flow.

set -uo pipefail

input=$(cat || true)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // ""' 2>/dev/null || echo "")
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.css|*.scss|*.html|*.yaml|*.yml)
    : # supported, fall through
    ;;
  *) exit 0 ;;
esac

if command -v prettier >/dev/null 2>&1; then
  prettier --write "$file" >/dev/null 2>&1 || true
elif command -v npx >/dev/null 2>&1; then
  npx --no -y -p prettier prettier --write "$file" >/dev/null 2>&1 || true
fi

exit 0
