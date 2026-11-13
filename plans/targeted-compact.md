# Questionaire

Targeted compact: cut a managed Claude session's conversation at a chosen row. Asked of the owner one question at a time, 2026-11-13.

Settled before the questions, with the NyaaCode session and by measurement:

- A cut builds a new session file under a new id while the CLI is closed, then the session resumes it. The source file is only read, and deleted once the session is back up on the new file. Owner: "let's not keep the old session file after we prove it works once." Proven 2026-11-13.
- Rows from the chosen one on stay byte for byte. Everything above becomes a summary or is dropped.
- Three modes: trim (drop what the session no longer loads), clear above (no summary), compact above (a summary).
- The rules live in `claudeSessionCut` (`indexSession`, `planCut`, `buildCut`, `verifyCut`, `cutSession`), host neutral, so they move into NyaaAI's operator package.
- A cut point is a message the session was sent, whether it started a turn or was taken in mid-turn, once no tool call above it is open.

## Question 1 - Where the cut point is picked

Q: Where do you pick the cut point?
A: On the chat row, for now: a long-press, matched to the session's turn by its text and time, with the confirmation naming the turn it found. The code is shaped so a "Session context" sheet with two doors can follow. The mode to make work is compact: the last known summary through the selected message becomes the new summary.

> "prep the code for A. but use B. I just need you to make work the compactor of last known summary to selected message."

# Plan

## Phase 1 - Compact above a pressed message (host Claude sessions)

Built: the file rules, the daemon's `sessionCut` host op, the Gateway's road in `createSessionCuts`, the `submit_session_summary` tool, and the phone's "Compact above" row entry with its plan confirmation. The owner tests it on the Switchboard session.

## Later

- The "Session context" sheet with two doors, over the same `session_cut_plan` and `session_cut_start`.
- Trim and clear on the phone (the daemon and the Gateway already take both).
- Devcontainer sessions: the daemon reads the file through the container.
