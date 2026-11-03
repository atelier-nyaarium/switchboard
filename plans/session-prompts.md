# Questionaire

## Question 1 - What should a waiting permission prompt do?

Q: A session holding a permission prompt shows nothing on the phone. What should happen?
A: The daemon presses Down to stop an auto-deny timer. The phone shows a red chip and a Switchboard notification on its next poll, which opens the conversation. A modal like the vault request sheet shows the title and the command, with Approve and Deny. Approve presses 1. Deny takes a reason, moves to the No row, presses Tab, types the reason, and submits.

> 1. Have tmux press down to stop the auto deny timer so I can get to it slowly from phone.
> 2. I need a red chip and a Switchboard notification when the phone next polls. The notification just takes me to the session conversation view.
> 3. New modal like the vault one, that shows: the title, the command, Button for Approve and Deny. Approve presses 1. Deny gives a textbox to fill out and presses Tab and fills the reason.

## Question 2 - Which background work reads as working?

Q: Should a background shell count as working, like a workflow?
A: Workflows only. A bar with an empty segment below the toolbar reads working.

> Workflows only. but you haven't seen it yet. need to keep watching until the 0% bar shows

## Question 3 - When does the modal open?

Q: Does the modal open on its own, or only from a tap?
A: On its own, at the top of the conversation like the vault request. When a vault request is up too, the approval shows first; once it is answered, the vault request transitions in.

> A. yeah like vault, it's just there on the top of the session. If vault and this are up at the same time, transition in and show the approval, instead of vault to save space. then after approve, vault transitions in.

## Question 4 - Can Deny send without a reason?

Q: The mockup sent a plain No when the reason was empty. Keep that?
A: No. The Deny that sends is disabled until the reason has text.

> make Deng button disabled unless reason is filled. Fat finger easy to do. and AI works best when given a steer. otherwise looks good

# Walk

A live prompt, walked in a scratch session:

- Layout below the composer's top rule: title line, optional subtitle lines, a body between two dashed rules (U+254C), optional warning rows, a question line ("Do you want to proceed?", "Do you want to create note.txt?"), a numbered menu, then "Esc to cancel · Tab to amend".
- The menu varies: 2 options from a workflow agent, 3 for a file create, 4 for a Bash command in manual mode. No is not a fixed digit; it is the row labelled "No".
- A workflow agent's prompt prefixes body rows with "│" and shows "Claude Code will automatically deny this request in M:SS".
- A digit selects and confirms. "1" approved.
- Tab amends the HIGHLIGHTED row: on 1 it reads "Yes, and tell Claude what to do next"; on No it reads "No, and tell Claude what to do differently". Typed text replaces that tail ("No, use rm out/a.tmp instead"), and Enter submits it as a steer. The footer drops "· Tab to amend" while amending.

# Plan

## Phase 1 - The prompt reader

A pure reader over a captured pane: `permissionPrompt(screen)` answers null or `{ id, title, body, question, options, cursor, autoDeny }`.

- Structural markers only: the composer's top rule, the dashed rules, a numbered menu with an indented cursor, the "Esc to cancel" line. No tool names.
- `id` hashes title, body, question and option labels. Never the countdown or the cursor, which change under it.
- Body capped by lines and bytes.
- Daemon-only, so no Kotlin twin.
- Fixtures: the workflow prompt with and without the countdown, the 4-option Bash prompt, the file create, the amending states. Each from a live capture.

## Phase 2 - The daemon

- `DerivedState` gains the prompt. The hysteresis compares its `id`.
- First sighting of an `autoDeny` prompt presses Down once per `id`.
- `presence_derive` carries the prompt to the Gateway, loopback only.
- Host op `answerPrompt { target, promptId, decision, reason? }`: re-peek, re-read, refuse a different `id`. Approve presses 1 after checking row 1 is a Yes. Deny with no reason presses the No row's digit. Deny with a reason walks the cursor to No, re-reads to confirm, presses Tab, re-reads for the amend row, types the reason literally, presses Enter. Answers `answered`, `stale` or `failed`.

## Phase 3 - The Gateway and the Router

- The Gateway holds the latest prompt per team beside presence.
- Presence carries `promptId` only. The command never crosses the Router in the clear.
- Value op `session_prompt { target }` answers the held prompt, sealed like every value result.
- Value op `session_prompt_answer { target, promptId, decision, reason? }` relays to `answerPrompt`.
- Router first: its presence schema accepts `promptId`. Then the Gateway, then the daemon.

## Phase 4 - The phone

- `Presence` gains `promptId`. `SessionWord` gains a red "needs approval" ahead of "limit hit".
- A new `promptId` on a team raises one notification per id when the phone polls. Tapping it opens the conversation.
- The modal: title, command in monospace, Approve, Deny. Deny reveals a reason field and a send. Fetched through `session_prompt`, answered through `session_prompt_answer`. A `stale` answer closes it.
- Decisions live in a rules file beside the ops class, not the sheet.

## Phase 5 - Acceptance

Live in a scratch session: a prompt raises the chip and the notification, Approve runs the command, Deny with a reason steers it, a prompt answered in the terminal closes the modal, and an auto-deny prompt stops its timer.
