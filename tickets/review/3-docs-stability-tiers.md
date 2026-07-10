description: Published a page defining four stability labels (Stable, Beta, Experimental, Internal), labeled every user-facing documentation page with one, and summarized the labels in the package README so a reader can tell which features are safe to build on.
files:
  - docs/stability.md (NEW — tier definitions + per-area assignment table)
  - docs/.stability.json (NEW — machine-readable doc→tier map for the follow-on gate)
  - docs/doc-conventions.md (§ The stability banner — new)
  - docs/store.md (§ Isolation Gap — honesty paragraph on what @quereus/isolation actually guarantees)
  - docs/.doc-budget.json (six ratchet entries raised)
  - packages/quereus/README.md (§ Current Status → ### Stability; ## Documentation index entry; three capability bullets tagged)
  - 37 × docs/*.md (one header banner each); 4 of those also carry a section banner
  - scripts/check-docs.mjs (read-only — run, not edited)
difficulty: medium
----

## What landed

A labeling change only. **No feature's behavior changed**; not one line of `packages/*/src`
was touched.

**`docs/stability.md`** (new, ~1,050 words) is the canonical home. It opens by stating the
load-bearing distinction — a tier says *how much a future release may break you*, and says
nothing about whether a feature computes the right answer today; **a wrong answer is a bug at
every tier, including Experimental**. It works that through the two Experimental parallel-track
optimizer rules (`rule-fanout-lookup-join.ts`, `rule-async-gather-zip-by-key.ts`) that are
registered in `planner/optimizer.ts` and fire on ordinary user `select`s, and through the
functional-dependency framework (Internal, but soundness-guarded by property tests). Then
`## Tiers` with one `###` per tier and the promise table, the full per-area assignment table,
and the three edge calls (views split Stable/Beta; declarative schema Beta inside a Stable
`sql.md`; FD framework Internal).

**`docs/.stability.json`** is the machine-readable form: `tiers`, a `docs` map, and an
`untiered` list. Together they name **all 50** `docs/*.md` — every doc on disk except the two
frozen review artifacts (`review.md`, `review.html`). 37 tiered, 13 untiered.

**Banners.** Every doc in the `docs` map carries exactly one header banner, directly under its
H1:

```markdown
> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).
```

Four docs also carry a **section banner** overriding the header tier for one section:

| Doc | Doc tier | Section | Section tier |
| --- | --- | --- | --- |
| `sql.md` | Stable | `### 2.0 Declarative Schema (Optional, Order-Independent)` | Beta |
| `usage.md` | Stable | `## Change-scope introspection` | Beta |
| `module-authoring.md` | Stable | `### 3. Concurrency Mode (Parallel Runtime)` | Experimental |
| `runtime.md` | Internal | `## ParallelDriver (Runtime Primitive)` | Experimental |

**`docs/store.md` § Isolation Gap** gained the honesty paragraph the ticket asked for:
`@quereus/isolation` gives read-committed plus read-your-own-writes, is **not** snapshot
isolation, and does **no** write-write conflict detection (last flush wins). Wording was
checked against `packages/quereus-isolation/README.md` § Isolation Level and
`docs/design-isolation-layer.md` § Isolation Level Provided rather than invented, and it links
to the latter rather than restating it.

**`docs/doc-conventions.md`** gained `## The stability banner`, recording the exact banner form,
that the tier word must match `docs/.stability.json`, that a section may override its doc's tier,
and that every `docs/*.md` lands in `docs` or `untiered`.

**`packages/quereus/README.md`**: `### Stability` at the top of `## Current Status` with the
four-row tier table and the compatibility-not-correctness sentence; the bold
`**Current capabilities include:**` line was promoted to a sibling `### Capabilities` heading so
the capability bullets do not fall under `### Stability`; `[Stability Tiers](../../docs/stability.md)`
added as the first bullet of the `## Documentation` user docs list; and three capability bullets
tagged — materialized views *(Beta)*, updatable views *(Beta)*, logical schemas and lenses
*(Experimental)*.

## Ratchet-raise justification — lift this into the commit body verbatim

> Raised the doc ratchet for six docs: the stability-banner convention adds one
> header line to every user-facing topic doc. See docs/doc-conventions.md § The size
> ratchet.

## Validation performed

- `node scripts/check-docs.mjs` **before** any edit → `Docs OK`. Clean baseline confirmed.
- After edits, pre-ratchet, the checker failed with **exactly six** Check C violations and
  nothing else — so links and anchors resolved on the first try across ~41 new banner links.
- `node scripts/check-docs.mjs --update-ratchet --force` printed **exactly six** `RAISED` lines,
  no `ADDED`, no stowaways:

  ```
  RAISED docs/lens.md: 17927 -> 17934 (+7)
  RAISED docs/runtime.md: 13018 -> 13032 (+14)
  RAISED docs/schema.md: 15683 -> 15690 (+7)
  RAISED docs/sql.md: 28643 -> 28657 (+14)
  RAISED docs/sync.md: 14314 -> 14321 (+7)
  RAISED docs/view-updateability.md: 28014 -> 28021 (+7)
  ```

  The banner is **7** checker-words, not the ~13 the plan estimated (`>`, `**Stability:`,
  `Stable**`, `—`, `see`, `[Stability`, `Tiers](stability.md#tiers).`). `sql.md` and `runtime.md`
  are `+14` because each also took a section banner. `module-authoring.md` and `usage.md` took
  section banners too but are unratcheted, so they do not appear.
- `node scripts/check-docs.mjs` after → `Docs OK: links resolve, invariants well-formed, sizes within ratchet.`
- Three-way agreement verified by a throwaway script (deleted; the follow-on ticket makes it a
  real check): every `docs/*.md` on disk minus the two frozen artifacts appears exactly once
  across `docs` + `untiered`; no entry names a missing file; every tier value is in `tiers`;
  every tiered doc has **exactly one** banner in the 3-line window under its H1 and its tier
  string equals its JSON value; no untiered doc carries a header banner. Result:
  `OK: 50 docs, 37 tiered, 13 untiered`.
- `yarn lint` → clean (`packages/quereus` eslint + `tsc -p tsconfig.test.json`; every other
  package's no-op). Run because `packages/quereus/README.md` is under `packages/`.
- `yarn check` / `test:full` **not** run: it is well past the ten-minute idle window and is not
  agent-runnable, and this diff contains no code. `scripts/check-docs.mjs` is the test that
  matters here.

## What a reviewer should actually check

The mechanical properties above are all machine-verified. What is **not** machine-verified, and
where the review value is:

1. **Are the tier assignments right?** This is a judgment call encoded in 37 banners plus one
   table. The three edge calls came from the plan and I did not relitigate them. Spot-check the
   ones that would embarrass us if wrong: `schema.md` → Beta (the `SchemaManager` API is
   consumed by every plugin), `module-authoring.md` → Stable (its `concurrencyMode` section is
   Experimental, but is `getBestAccessPlan` really major-only?), `store.md` → Beta (its on-disk
   key encoding is explicitly not frozen — is Beta strong enough given a Beta *format* break
   means an unreadable database?).
2. **Is the store.md isolation paragraph over- or under-claiming?** I sourced it from two
   existing docs, but neither is the code. If `@quereus/isolation` actually detects some
   write-write conflicts (e.g. via a UNIQUE constraint at flush), "no write-write conflict
   detection" is technically true but reads stronger than reality.
3. **Does `### Capabilities` break any inbound anchor?** I converted a bold line into a heading
   in `packages/quereus/README.md`. A repo-wide grep for `#current-status` and
   `#current-capabilities` across `*.md` and `*.ts` returns nothing, and the `## Current Status`
   H2 is unchanged — but Check A only resolves in-repo links, so an external consumer (npm page,
   blog post) is out of scope for both of us.

## Known gaps, honestly

- **The map is enforced by nothing yet.** Adding a new `docs/*.md` today silently leaves it
  unclassified, and editing a banner to disagree with `docs/.stability.json` passes every check.
  That is by design — `docs-stability-tier-gate` is the follow-on. Until it lands, the three-way
  agreement is a hand-verified snapshot, not an invariant.
- **A gotcha for whoever writes that gate:** `docs/doc-conventions.md` contains a banner line
  *inside a fenced code block* as the illustrative example. A naive line-scan for
  `> **Stability:` will flag it as a banner on an untiered doc. The gate must run its scan
  through the checker's existing `stripFences()`. `docs/stability.md` has the same example, also
  fenced. (Parked as this bullet, not a ticket — the gate ticket exists and will meet it.)
- **`runtime.md`'s section banner covers a range, not a subtree.** It sits on
  `## ParallelDriver (Runtime Primitive)`; the Experimental material continues through
  `### Parallel runtime fork contract`, `### EagerPrefetchNode`, and `### AsyncGatherNode`, which
  are its children — so the scope reads correctly to a human, but nothing in the file says where
  the override *ends*. Same shape in the other three section-bannered docs. If the follow-on gate
  ever wants to attribute a line to a tier, it will need a scoping rule the docs do not currently
  express.
- **`FanOutLookupJoinNode` is named as Experimental in `stability.md`'s assignment table but has
  no doc of its own**; it is covered by `optimizer-parallel.md` (Internal, as an optimizer doc)
  and `runtime.md`'s Experimental section. A reader chasing "is the fan-out lookup join
  experimental?" from `optimizer-joins.md` (Internal, no section banner) will not find a banner
  saying so. Judged acceptable — `optimizer-*.md` is Internal throughout, so no compatibility
  promise is being made either way — but it is a seam.
- **Word counts are close to the cap in one place:** `docs/stability.md` is ~1,050 words against
  a 12,000-word unratcheted cap, so there is plenty of room. But five docs are now within a few
  hundred words of a ratchet that was just raised; the next banner-shaped convention will need
  its own `--force`.
- **I did not touch the "freeze the parallel track" question.** The plan explicitly reserved it
  as a product call for a human, and declaring the tier does not force it.
- `docs/review.md` and `docs/review.html` were not opened or modified.
