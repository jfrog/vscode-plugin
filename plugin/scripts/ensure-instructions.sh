#!/bin/bash
TARGET=".github/copilot-instructions.md"
TEMPLATE="${CLAUDE_PLUGIN_ROOT}/templates/copilot-instructions.md"

if [ ! -f "$TARGET" ]; then
  mkdir -p .github
  cp "$TEMPLATE" "$TARGET"

  # Read template content, escape for JSON
  CONTENT=$(sed 's/\\/\\\\/g; s/"/\\"/g' "$TEMPLATE" | awk '{printf "%s\\n", $0}')
  NOTICE="JFrog MCP governance instructions added to .github/copilot-instructions.md. Commit this file to share with your team.\\n\\n"

  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s%s"}}' "$NOTICE" "$CONTENT"
else
  echo '{}'
fi