#!/usr/bin/env bash
# Codex PreToolUse hook: block shell commands and patches that target
# TabMail's live secret files. Template `.example` files remain allowed.

set -euo pipefail

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "[block-secrets] jq not installed; hook is a no-op. Install jq to enable it." >&2
  exit 0
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
PATTERN='\.dev\.vars|Secrets\.xcconfig|\.env\.idle-proxy'

case "$TOOL_NAME" in
  Bash|apply_patch)
    P=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
    ;;
  *)
    exit 0
    ;;
esac

P_NORMALIZED=$(printf '%s' "$P" | sed -E 's/(\.dev\.vars|Secrets\.xcconfig|\.env\.idle-proxy)\.example//g')

if printf '%s' "$P_NORMALIZED" | grep -qE "$PATTERN"; then
  cat <<EOF >&2
[block-secrets] BLOCKED — Codex tool '$TOOL_NAME' targets a sensitive secret file.

These files must never be read or written by Codex. Use the repository's
secret setup or rotation scripts from your own terminal instead.
EOF
  exit 2
fi

exit 0
