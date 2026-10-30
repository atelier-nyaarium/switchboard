# Task board

The owner's board, its attachments, and edit awareness.

## Where the board lives

`/task-board` reads and writes the Router-held board over the gateway's own WS. The Router stores
clear structure with sealed title, body and attachment filenames. It never opens them.

## Router-held board

`gateway/router/boardClient.ts` is the gateway's only door to it.

- **It is the sole sealer and opener of board text:** Titles seal under `board.title`, bodies under
  `board.body`, filenames under `board.name` keyed by `blobId` so a reorder cannot mislabel a file.
- **Every board kind binds the entry id into the AAD:** filenames bind the `blobId` after it. The
  phone builds the same kind in `BoardSealing`.
- **It is the sole mapper between a local session key and the Router's triple:** Another gateway's
  session comes back as an opaque joined key, never as a local one.
- Writes are CAS on `revision`. A conflict answer carries the board that won, so the mutation
  rebuilds against it without a second read.
- **A Router that cannot answer is a transport fault, not a refusal:** The route answers 503. Only a
  refusal retires the caller's write.
- Text with no key held opens to a placeholder rather than dropping the entry.
- An upsert that leaves attachments alone keeps their sealed names. Naming attachments replaces both.
- `set_session` carries claim and release. Its authority is `mayTake`, not `mayWrite`: a session may
  take an unheld entry and drop one it holds, and only the owner reassigns.
- Claim and release act on the whole subtree, as one batch.
- Observations arrive as `board_observation` inbox rows, opened into the awareness bank by the
  delivery pump.

## Sibling order

`src/shared/board-order.ts` holds the rule; `BoardOrder.kt` is the phone's twin, pinned by
`tests/fixtures/board-order/vectors.json`.

- **A rank is a position, from 1, among the parent's live children:** trash takes no part, and keeps
  whatever rank it had.
- **Only the Router numbers:** a client never names a rank. A new entry lands last, `move` names an
  index among the live siblings without the moved entry (absent lands last), and a restore puts the
  topmost restored entry last. Every write renumbers each group 1..n, which closes the gap a trash or
  a removal leaves. Renumbering touches entries no session holds, which only the Router may write.
- **A shifted sibling is written but not observed:** only an entry the write names, or the cascade,
  reaches its holder. A rank-only change is never announced.
- The phone runs the same rule over its pending writes, renumbering after each, so a drag shows where
  the Router will put it.
- A Router that finds ranks stored as text numbers them in their old order and the board sweep stores
  them. That reading goes after 2026-11-13.

## Attachments

Attachment bytes live on the Router; no Gateway keeps a copy and no attachment names one. A
Router-held entry may name only blobs the Router already holds; the write and the entry's reference
set land in one journal line, and a write naming anything else is refused `attachment_missing`.

- **`set_attachments` replaces the field:** Other writes preserve stored attachments.
- **The phone uploads first and intends once:** every new blob goes up through the blob owner ops,
  and `set_attachments` is posted only when all of them are held. The staged source stays for a
  retry.
- **A read reaches the Router only:** `AttachmentOps` fetches through `blob_fetch`; `absent` is a
  proven Router absence, drawn as such and retried by tap. Failures, not absence, count toward the
  give-up.
- `/task-board` exposes display facts only. Blob ids travel through the separate attachment fetch
  action.
- A cross-Gateway move rewrites the entry's Gateway; the bytes do not move, since nothing holds them
  but the Router.

**File map:**

- `src/gateway/router/boardClient.ts`, `src/federation-server/board/boardService.ts` - attachment projection and mutation.
- `src/mcp/board/boardTools.ts` - attachment name lookup and byte fetch.
- `android/.../BoardOps.kt`, `AttachmentOps.kt` - console queueing and fetch state.

## Awareness

- **Awareness rides the next message:** The send route leases each session's bank into
  `channel_push`. Standalone pushes are only the `act_now` fallback.
- **The model reads it as a reminder block, never as the sender's words:** the plugin renders
  `awareness` as data lines (its sources, its `act`, then the notice) between the files and the body,
  through `shared/system-reminder.ts`. A standalone push carries it as `awareness` beside an empty body.
  The MCP instructions state once what `act_now` and `no_act` ask for, so the block carries no
  instruction. A standalone push's `instructions` attribute still repeats that no reply is wanted,
  as every message's does.
- **A lease settles by whether its carrier landed** (`AwarenessBank.prepareFor`): `commit` once the
  message is accepted removes exactly what it carried, and a change observed meanwhile keeps its delta
  from what was delivered; `release` on a refusal leaves everything banked. One carrier holds a bank at a
  time. The deadline push commits only when delivered, retries each second, and is dropped once the hold
  runs out. A bank with no deadline is dropped once its session has been gone past the hold.
- The bank keeps the first pre-state and last post-state per identity, then diffs at flush.
  Intermediate edits, moves, and undo sequences collapse into one net fact.
- Reply disposition and gateway `no_ack` are separate axes; `no_ack` wins. `act_now` starts its hold
  at the first observation and is not extended. Board `gone` is `act_now`; other board changes are
  `no_act`.
- The route commits only once the delivery queue accepts the message or a socket takes it.
- `no_ack`, `act`, and `awareness` are plain `ChannelPushPayload` fields. Notification metadata must
  be strings with snake_case keys.
- No-reply interception is valid only when the store has no job for the fallback id. The `na-` prefix
  alone is insufficient across federation.
- Both holders of a changed entry receive awareness, classified from pre/post visibility. A self-echo
  is skipped.
- Rank-only reorders announce nothing.
- Awareness bodies are bounded by the bank (`MAX_AWARENESS_BODY_CHARS`), whatever each subscriber renders.
  Liveness distinguishes waking from gone and uses `WAKE_TIMEOUT_MS`.
- The phone drains board edits before sending the next wire message.
- **Files the owner changed from the phone ride too:** each span save or file mutation the console answers
  banks one `no_act` line per path, the latest change to it, and an `unknown` answer says "may have". A
  forgotten session's bank is dropped with it; a closed one keeps it for its wake.

**File map:**

- `src/gateway/awarenessBank.ts` - subscriber bank, flush deadline, liveness.
- `src/gateway/boardAwareness.ts` - board recipients and net-change classification.
- `src/gateway/workspaceAwareness.ts` - what a phone workspace op changed, and the files notice.
- `src/gateway/routes/routesSend.ts` - awareness delivery on channel pushes.
