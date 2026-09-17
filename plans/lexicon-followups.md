# Lexicon follow-ups

Four architecture items from the Phase 14a audits, run as one item-mode cycle in
`/home/nyaarium/projects/nyaa-lexicon`. Each lands with that repository's gates (lint, tests, every
provider's conformance, `grade.js`), a commit and its docs; the task board holds the status. One
release build covers the four before the pin moves into switchboard.

1. ✅ `bd_a09deee16410576fccffba6cabb2eee9` One `ReadContext` derives a read's topology; `locals.ts` holds the container walk. Shipped `09c5ec8`.
2. ✅ `bd_13b6c85cbd1e4a5d9281b447443adc38` The core publishes `moduleAdmission` after the commit; every binding provider keeps an `AdmissionLedger`; two lifecycle conformance cases. Shipped `8017fdd`.
3. ✅ `bd_6ca2288387a50a6c59b7d3f4870cd612` Kotlin scopes are one immutable `ScopeEnvironment` keyed by node identity; nothing annotates a syntax node; `declarations.ts` split by concept (the per-family split of the walk is a follow-up on the board). Shipped `bad9677`.
4. ✅ `bd_4e6e9f40f7f3e0b1906a0246ea8259ff` A Python signature's references are written in the declaration whose header they sit in; binding stays in the enclosing scope; two Python conformance cases. Shipped `58b2acb`.

## ReadContext

Left on the board, claimed: `refactorPlanner.ts` derives its own containment on the write path, the one
place this class can reappear.
