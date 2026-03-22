#!/bin/bash

set -e


TMUX_SESSION="claude"
HOST_NAME="$(hostname)"


# Check if tmux session already exists
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Session '${TMUX_SESSION}' already running."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
	exit 0
fi


echo "Starting claude remote-control on ${HOST_NAME}..."
tmux new-session -d -s "$TMUX_SESSION" "claude --name '${HOST_NAME}' --rc --model opus --effort high --dangerously-skip-permissions --dangerously-load-development-channels plugin:agent-team-bridge@agent-team-bridge; exec bash"

# Wait for Claude to start, auto-accept dev channels prompt if it appears
for i in $(seq 1 10); do
	sleep 1
	SCREEN=$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || true)
	if echo "$SCREEN" | grep -q "Claude Code"; then
		break
	fi
	if echo "$SCREEN" | grep -q "Loading development channels"; then
		tmux send-keys -t "$TMUX_SESSION" Enter
	fi
done


if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
	echo "Claude running in background."
	echo "  Attach: tmux attach -t $TMUX_SESSION"
else
	echo "ERROR: tmux session failed to start."
fi
