# Router ledger and journal

Not started. No question has been asked yet, and nothing below is decided.

## Brief

A rewrite of the Router's op ledger and journal, in place of sweeping the ledger by age.

> "I think we need a rewrite of the ledger/journal system instead of just manually cleaning up."

> "Look at NyaaDot journal system. The journal keeps track of current positions and the oldest position a client has observed. Anyone disconnected for too long resyncs. Perhaps we take a learning lesson from this."

## Look first

- **NyaaDot's journal system,** in the `nyaadot` project. How it keeps current positions, how it tracks the oldest position a client has observed, what counts as disconnected for too long, and what a resync costs the client.
- **What Switchboard already has of that shape.** `compactInbox` moves an inbox's floor to the lowest consumer cursor. The consumer registry holds each consumer's cursor and epoch. The fold in `src/shared/versioned-list.ts` restarts on a stale answer, and `src/shared/versioned-slot.ts` orders a plane by lineage. The op ledger uses none of them.

## What is known

Measured on the live Router, 2026-11-12.

- **The owner store for the live Domain is 20.1 MB, and the op ledger is 97.6% of it.** 23,040 entries at about 850 bytes, one per op since 2026-09-03. Nothing has ever removed one. The interrupted pass below left 19,853.
- **An entry is a receipt.** In the clear it holds the inbox address, the time, the conversation id, the op id, the outcome and a sequence number. About 9,200 also hold the op's result as a sealed envelope. No message is kept: inbox rows are retired on delivery or at `INBOX_ROW_TTL_MS`.
- **What the ledger is for.** A retried op finds its entry and is answered with the same result, so nothing runs twice. `appendInboxRow` reads it.
- **Every write copies the whole store.** `OwnerStateStore.commit` clones the state before it applies a journal line: 78 to 99 ms per write at this size, and one delete alone took 82 ms. Every owner op the Router takes pays that.
- **The incident.** The first live pass of `sweepOpLedger` made one write per entry for 8,785 entries inside one pass of `RouterServer.sweep`, and the Router answered nothing from 18:42:57 to 18:48:33 PST.
- **A batched sweep exists and is on no pass.** `sweepOpLedger` is one write of at most `OP_LEDGER_SWEEP_BATCH` per pass, read in place through `OwnerStateStore.pick`. Rehearsed on a copy of the live store: three passes of about 75 ms, 20 MB to 12 MB. The owner paused it in favour of this plan.
- **No sweeper on the Router's pass has a bound,** and no test runs one at the live store's size.

## Questions to ask

Foundational first.

1. What a receipt must still do: answer a retried op with the same result, and for which clients.
2. Whether an entry leaves by position or by age. By position, it goes once every client that could retry it has observed past it, and a client too far behind resyncs.
3. What a resync is for each kind of client: a phone, a Gateway, a session.
4. Whether an entry keeps the op's sealed result, or only its outcome.
5. Whether the store keeps copying itself on every write.
6. Scope: the op ledger alone, or the other records the store holds too.
7. What happens to the entries held today, and whether older clients are carried or the break is clean.
8. Whether every sweeper on the Router's pass gets a bound and a test at the live size.
