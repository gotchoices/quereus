description: The project's single list of code rules that must always hold has grown to just under the 12,000-word limit every design document must stay inside, so the next rule anyone adds will fail the documentation check; a human needs to decide whether that list is split up, exempted from the limit, or kept small by pruning.
architecture: docs/doc-conventions.md#the-invariant-register
files:
  - docs/invariants.md (11,850 words after the lens area landed; `wc -w docs/invariants.md`)
  - docs/doc-conventions.md (§ The invariant register — "one file, read end-to-end in one sitting"; § The size ratchet — the 12,000-word cap)
  - scripts/check-docs.mjs (`INVARIANTS_PATH`, `checkInvariants`, the size check)
  - docs/.doc-budget.json (empty `ratchet` map — no doc is grandfathered any more)
----
**Blocked — category (a): the specification contradicts itself.** It unblocks when a maintainer picks one of the options below (or edits the recommended text). Two written rules now collide: `docs/doc-conventions.md` says the invariant register is **one file** (`docs/invariants.md`), and the same document caps **every** doc at 12,000 words with no grace band. The register measures 11,850 words, so the documentation check (`yarn docs:check`) already prints a near-cap notice for it, and the next invariant of normal size (about 150 words with its metadata) turns the build red.

## Background, for a reader with no context

`docs/invariants.md` is the list of statements the code must always satisfy — "a logical removal never drops basis storage", "every registered optimizer rule declares its side-effect mode". Each entry is at most 120 words, names the code that upholds it and the test that guards it, and the checker verifies those pointers still exist. Topic docs link to entries by their heading anchor (126 such links across `docs/` and source today).

The register is organised by area. Measured with `awk '/^## /{…}' docs/invariants.md` (words per `##` section):

| Area | Words |
| --- | --- |
| OPT — Query optimizer | 5,240 |
| MV — Materialized views | 3,210 |
| SCH — Schema | 1,012 |
| VU — View updateability | 985 |
| LENS — Lens | 657 |
| RT, SYNC, TXN | 166 / 128 / 156 |
| Preamble | ~240 |

## How this surfaced

`debt-docs-split-lens-when-stable` split `docs/lens.md` and was asked to fill the reserved `LENS` area. Its first draft had 11 lens invariants (about 1,500 words), which put the register at 12,691 words and failed the check. It shipped the 6 strongest (657 words) instead. The other 5 are drafted at the end of this ticket so they are not lost.

## Options

1. **RECOMMENDED DEFAULT — split the register by area, keep the cap.** One file per area (`docs/invariants-opt.md`, `docs/invariants-mv.md`, …), with `docs/invariants.md` reduced to the preamble plus a table of areas. The checker's Check B iterates every `docs/invariants*.md` instead of one path, and keeps enforcing ID uniqueness and ascending order across the set. Proposed replacement for the first paragraph of `docs/doc-conventions.md` § The invariant register:

   > The register is one file per area — `docs/invariants-<area>.md` — indexed from `docs/invariants.md`. An area file is read end-to-end against the code in one sitting; that is the whole point of it — an invariant buried in the middle of a 38,000-word doc is an invariant nobody audits.

   Cost: every back-link (`invariants.md#opt-014--…`) is repointed to its area file — mechanical, and the checker already fails on any link left dangling. The largest area (OPT, 5,240 words) gets plenty of room.
2. **Exempt the register from the word cap.** One line in the checker and one sentence in the conventions. Cheapest, but the cap exists so that no doc grows past what someone can re-read against the code, and the register is the doc whose entire purpose is being re-read against the code.
3. **Grandfather the register in the ratchet** (`node scripts/check-docs.mjs --update-ratchet --force`). This buys 500 words of grace once, then the same question returns. The conventions treat a forced raise as an exceptional event, not routine.
4. **Keep it under the cap by pruning or tightening entries.** Keeps both rules literally, but every new invariant then has to evict or compress an existing one, and the five lens invariants below stay out.

## What happens if we do nothing

Nothing breaks today. The next ticket that adds an invariant of normal size fails `yarn docs:check`. That agent then has to choose between options 2–4 under time pressure, or (as here) quietly ship fewer invariants than the work deserves.

## How reversible is this call

Fully reversible: it is documentation layout plus a small checker change. Option 1 is the most work to undo, because the back-links would be repointed twice.

## Lens invariants drafted but held back for room

Each is checked against the code as of this ticket. When added, number them after the last `LENS` entry and add the `> **Invariant:**` back-link under the named doc section.

**A lens deploy proves every table before it mutates the catalog.** code: `packages/quereus/src/schema/lens-compiler.ts` — `deployLogicalSchema`. guard: `packages/quereus/test/lens-prover.spec.ts` — `aggregates every blocking error into one atomic deploy failure`. doc: `lens-deployment.md#deployment-is-a-compile-step`. Body: `apply schema` on a logical schema resolves each table's mapping advertisement, compiles its body, and runs the prover for every table before registering any lens view or slot. A malformed advertisement, an alignment failure, or any blocking prover diagnostic aborts the whole deploy, with the blocking errors of all tables aggregated into one failure, and leaves the previously deployed lens state untouched. Module deployment notifications fire only after a deploy that succeeded.

**A surrogate shared key is evaluated once per logical row.** code: `packages/quereus/src/planner/mutation/decomposition.ts` — `resolveInsertSharedKey`, and `requireKeyDefault`. guard: `packages/quereus/test/lens-put-fanout.spec.ts` — `sources the surrogate from the anchor default once per row, threaded across members, distinct per row`. doc: `lens-default-mapper.md#insert`. Body: an insert through a decomposition resolves the shared key once per produced logical row, at the mutation envelope, and threads that one value into every member's key column, so all members of a logical row agree on its identity. A surrogate key's value comes only from the anchor key column's declared `default`, evaluated once per row with `mutation_ordinal()` in scope; the engine fabricates no surrogate, and a surrogate anchor column with no default is rejected at deploy and at insert. A logical-tuple key threads the supplied logical primary key unchanged.

**A lens key's conflict action is honored or rejected, never dropped.** code: `packages/quereus/src/planner/building/view-mutation-builder.ts` — `rejectLensSetLevelConflictResolution`, and `packages/quereus/src/schema/lens-prover.ts` — `rejectBasisGovernedConflictActionForProvedKey`. guard: `packages/quereus/test/lens-prover.spec.ts` — `lens prover: unenforceable conflict action (commit-time set-level)`. doc: `lens-constraints.md#conflict-actions-on-a-logical-key`. Body: only a basis key resolves a duplicate on a logical key, so the logical key's own declared action is never consulted. A key-level `on conflict replace` / `ignore` is therefore rejected at deploy with `lens.unenforceable-conflict-action` when the key is enforced by the commit-time scan (which can only ABORT) or when a basis key governing it declares a different action; where governance cannot be pinned (a multi-source body) it rejects conservatively. A statement's `or replace` / `or ignore` / upsert against a commit-time key is rejected at plan time.

**A generated backfill never violates an unguarded NOT NULL.** code: `packages/quereus/src/schema/basis-backfill.ts` — `computeBasisBackfill`. guard: `packages/quereus/test/lens-backfill.spec.ts` — `lens backfill: partial with a NOT-NULL no-default new column`. doc: `lens-deployment.md#classification--re-decomposition-vs-needs-data`. Body: every non-NULL `backfill_sql` that `quereus_basis_backfill` reports runs without failing an unguarded NOT NULL constraint. A skeleton insert seeds only the reconstructible columns of a new basis relation and relies on basis defaults for the rest, so it is emitted only when every NOT NULL, undefaulted, non-generated column of that relation is among the reconstructible ones. Otherwise `backfill_sql` is NULL and the application owns the whole insert; the category and the record of reconstructible columns are kept.

**A stored lens body qualifies every basis source.** code: `packages/quereus/src/schema/lens-compiler.ts` — `qualifyBasisSources`. guard: `packages/quereus/test/lens-overrides.spec.ts` — `carries the basis qualifier into effective_sql`. doc: `lens.md#body-shape-restrictions`. Body: the effective body stored on a lens slot names every basis relation it reads with the basis schema the compiler resolved (`<basis>.<relation>`), whether the author wrote the name bare or qualified; only CTE references, and sources a CTE name shadows, stay bare. The read path, the prover, `explain`, and `resolveSlotBasisSource` all consume that stored body, so they agree on which relation a name means and none re-resolves a bare name against its own schema path. The authored `declare lens` text is kept as written.

## Schema invariant drafted but held back for room

Added by `debt-schema-change-notice-must-carry-registered-schema`, which built the runtime check but could not add the entry: the register measured 11,983 words before it (`git show HEAD:docs/invariants.md | wc -w`) and this entry took it to 12,099. The rule is stated in prose in `docs/schema.md` § Event Types ("Registered-object contract") meanwhile. When added, number it after the last `SCH` entry (SCH-008 at the time of writing), and replace the `schema.md` sentence's pointer to `assertAnnouncedTableIsRegistered` with a link to the entry.

**An announced table definition is the registered one.** code: `packages/quereus/src/schema/schema.ts` — `addTable`. guard: `packages/quereus/src/schema/change-events.ts` — `assertAnnouncedTableIsRegistered` (called by `SchemaChangeNotifier.notifyChange` before dispatch). doc: `schema.md#event-types`. Body: the table definition carried by a `table_added`, `table_modified`, `materialized_view_added`, `materialized_view_modified` or `materialized_view_refreshed` event is, by reference, the object the catalog holds under the event's schema and name when the event is announced. An emitter announces what `Schema.addTable` returned, not what it passed in: registration can correct its input. Listeners cache the payload — the store module builds later ALTER results from it — so an uncorrected announcement re-enters the catalog on the next ALTER. Removal events are exempt; their payload is leaving the catalog.
