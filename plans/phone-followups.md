# Phone follow-ups

Four architecture items from the Phase 14 audits, run as one item-mode cycle. Each lands with its
gates, a commit and its docs; the task board holds the status.

1. ✅ `bd_5465b1d07f2498b744bb0af338e015a6` ComposedRequests: one road for a composed request's lifecycle, admission included. Shipped `4b80c6a2`.
2. ✅ `bd_05317acf3d06ae839e721c38bc444c73` AskedStore settles against an observation; the preflight's claim is one value. Shipped `020183d1`.
3. ✅ `bd_717e3a19d49b736f6796974b297f5233` `AskGrammar` renders and parses the Ask message's tree, pinned by `tests/fixtures/ask-grammar/vectors.json`. Shipped `094abc11`.
4. `bd_eb11a34b18d4335a7e0248d43268b354` FacetRules split.

## ComposedRequests

### Bug Classes

- **Mechanism:** a generation checked beside a write instead of inside it. **Class:** the check
  passes, the generation moves, the write lands anyway; in the road, the claim commits after the
  clear and nothing is left to settle it. **Rounds:** `PublishedViews` (`c0e79754`, a ticket minted
  before the await and checked under the lock); `ComposedRequests` (`4b80c6a2`, the ledger carries
  its generation and one CAS decides admission, claim and landing). One class, two mechanisms: any
  per-key state fenced by `WorkspaceHost.generation` carries the generation in the value it CASes,
  never an `isCurrent` beside it.
- **Mechanism:** a test asserting before releasing a send held inside `NonCancellable`. **Class:** a
  broken rule hangs `runBlocking` instead of failing. **Rounds:** `6c9161ee` (three ticket tests);
  `4b80c6a2` (two collision tests). Each round released first, then asserted. A hold that releases
  itself when the test body exits would make it inexpressible; not built this lap.
