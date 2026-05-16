#!/usr/bin/env bash
# PostToolUse hook for Bash / Edit / Write / MultiEdit.
# Appends one line per tool call to ~/Library/Logs/claude-tool-trail.log
# (or /tmp fallback when ~/Library/Logs is unwritable).

set -uo pipefail

input=$(cat || true)
tool=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
target=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.command // ""' 2>/dev/null | head -c 240 | tr '\n' ' ')

ts=$(date "+%Y-%m-%d %H:%M:%S")
agent=$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")

log_dir="$HOME/Library/Logs"
log_file="$log_dir/claude-tool-trail.log"
if ! mkdir -p "$log_dir" 2>/dev/null || ! touch "$log_file" 2>/dev/null; then
  log_file="/tmp/claude-tool-trail.log"
fi

printf '%s [%s] %s | %s\n' "$ts" "$agent" "$tool" "$target" >> "$log_file"
exit 0
