#!/usr/bin/env bash
# cursor-agent-session.sh — Session ID + follow-up for cursor-agent -p
#
# One-off:  echo "Hi" | cursor-agent -p
# Session: create ID, then send/follow-up into that conversation.
#
# Usage:
#   cursor-agent-session.sh new              # create session, print ID
#   export CURSOR_AGENT_CHAT_ID=<id>
#   echo "First" | cursor-agent-session.sh   # send (stdin)
#   echo "Follow-up" | cursor-agent-session.sh
#
# Or pass ID explicitly:
#   echo "Hi" | cursor-agent-session.sh <chat-id>
#
# Override agent binary: CURSOR_AGENT_CMD=/path/to/agent

set -euo pipefail

AGENT_CMD="${CURSOR_AGENT_CMD:-cursor-agent}"

cmd="${1:-}"

if [[ "$cmd" == "new" ]]; then
  id=$("$AGENT_CMD" create-chat)
  echo "$id"
  echo "# export CURSOR_AGENT_CHAT_ID=$id" >&2
  exit 0
fi

# If first arg looks like a UUID, use it as session and take prompt from rest or stdin
if [[ "$cmd" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  CURSOR_AGENT_CHAT_ID="$cmd"
  shift
  if [[ $# -gt 0 ]]; then
    printf '%s' "$*" | "$AGENT_CMD" --resume="$CURSOR_AGENT_CHAT_ID" -p
  else
    "$AGENT_CMD" --resume="$CURSOR_AGENT_CHAT_ID" -p
  fi
  exit 0
fi

# Otherwise require CURSOR_AGENT_CHAT_ID for send/follow-up
if [[ -z "${CURSOR_AGENT_CHAT_ID:-}" ]]; then
  echo "No session: set CURSOR_AGENT_CHAT_ID or pass chat ID as first argument." >&2
  echo "  $0 new   # create session and print ID" >&2
  exit 1
fi

"$AGENT_CMD" --resume="$CURSOR_AGENT_CHAT_ID" -p
