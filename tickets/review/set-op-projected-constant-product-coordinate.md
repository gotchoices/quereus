description: A view that unions several branches each tagged with a constant label column can already be written through by filtering on those labels; this documents that idiom as the way to get "product-coordinate" addressing, and fixes a rough edge where a delete/update whose filter matched no branch raised an internal error instead of doing nothing.
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/logic/93.6-set-op-flagless-write.sqllogic, docs/view-updateability.md
difficulty: medium
----

## What this ticket did

It did **not** build the shelved bespoke product-coordinate model. The plan-pass finding (recorded in
the implement ticket) was that the already-shipped flag-less predicate-honest write path serves the
product *use case* via **multiple projected-constant discriminator columns**, so the work here was:

1. **Bug fix** — a zero-leg flag-less DELETE / data-UPDATE no longer raises an internal error; it is now
   a clean no-op (0 rows).
2. **Tests** — pin the product-coordinate addressing matrix and the no-op behaviour.
3. **Docs** — document the projected-constant idiom as the recommended product surface and remove the
   stale "shelved backlog ticket" framing.

## The bug + fix (the load-bearing change to scrutinize)

A flag-less set-op DELETE / data-UPDATE whose predicate is provably `unsat` for **every** leg fans to
zero legs, so `buildFlaglessDelete` / `buildFlaglessUpdate` return `{ baseOps: [] }`, and
`buildSetOpMutation` then constructed `ViewMutationNode([])`, whose constructor throws
`ViewMutationNode requires at least one base operation` (`StatusCode.INTERNAL`).

**Fix** (`view-mutation-builder.ts`, in `buildSetOpMutation`): after `writeFn` returns, when
`req.op !== 'insert'` **and** the decomposition is empty (`baseOps.length === 0` and no
`joinLegInserts`), return a void no-op sink — `new SinkNode(scope, new EmptyRelationNode(scope, [],
<void relation type>), req.op)` — via the new `buildNoOpMutationSink` helper, instead of constructing the
`ViewMutationNode`. The emitter drains the zero-row source and reports 0 rows affected, exactly like a
base-table delete/update that matches nothing.

Why this locus: it is the shared boundary for **both** set-op write paths (the `exists`-membership
`buildSetOpWrite` and the flag-less `buildFlaglessSetOpWrite`), so it defends the membership path too and
is robust against any future fan rule that legitimately narrows to zero branches.

The INSERT path is deliberately **untouched**: a flag-less insert routing to no leg raises
`consistent with no writable leg` inside `buildFlaglessInsert` (before control returns to
`buildSetOpMutation`), so it never reaches the guard with an empty decomposition for a real reject — and
must stay an error (the row would be invisible through every branch).

### Reviewer: things worth an adversarial look

- **Guard condition correctness.** `req.op !== 'insert' && baseOps.length === 0 && (joinLegInserts?.length
  ?? 0) === 0`. Confirm it cannot fire when a single consistent leg exists (a real write), and cannot
  mask a legitimate error. `nestedCaptures` are deliberately not in the condition — they carry no ops, so
  an empty `baseOps`+`joinLegInserts` already means "nothing to run"; the discarded `capture` /
  `nestedCaptures` are plan-time descriptors with no runtime side effect.
- **Void relation type.** `buildNoOpMutationSink` fabricates an `EmptyRelationNode` with empty attributes
  and a minimal `{ typeClass:'relation', columns:[], keys:[], rowConstraints:[], … }`. Confirm an
  attribute-less empty relation under a `SinkNode` survives the optimizer untouched (the empty-relation
  *folding* rules act on Filter/Project/Join/Sort, not Sink; the Sink itself is the side effect and has
  no children to fold). The full suite passing is evidence, but it's worth a direct read.
- **Return-type shape.** `buildViewMutation` now returns a `SinkNode` (not a `ViewMutationNode`) on this
  path. Both are valid void statement roots, but confirm nothing downstream of `buildViewMutation`
  assumes a `ViewMutationNode` specifically for a set-op write.

## Tests added (a floor, not a ceiling) — `93.6-set-op-flagless-write.sqllogic`

Two new sections appended at end of file:

1. **Product-coordinate addressing** — a fresh `PC` view (`pca`/`pcb`), a two-axis discriminator grid
   `kind ∈ {red,large}` × `src ∈ {A,B}` (structurally identical to the existing `U`/`U4`). Asserts:
   - static surface: plain columns `is_updatable=YES`, discriminators `NO`, `view_info` all-`YES`
     (a view that *can* produce a zero-leg write is still statically writable);
   - **cross-axis pin** (`where kind='red' and src='A'`) → writes the one co-satisfiable leg only;
   - **single-axis UPDATE fan** (`where kind='red'`) → fans to both red legs (the UPDATE companion to the
     existing one-axis DELETE/UPDATE fans);
   - **same-axis contradiction no-op** (`where kind='red' and kind='large'`, and the `src` symmetric) →
     0 rows, base tables unchanged (the bug-fix assertion — these *threw* before);
   - **off-grid no-op** (`where kind='zzz'` DELETE, `where src='zzz'` UPDATE) → 0 rows;
   - a **positive DELETE** (`where kind='large'`) beside the no-ops, proving the guard doesn't swallow
     real writes;
   - the **INSERT contrast** (`values (8,80,'zzz','A')`) still errors `consistent with no writable leg`;
   - **RETURNING** on a no-op-predicate delete still errors `RETURNING` (the reject precedes the
     short-circuit).
2. **`intersect` / `except` zero-leg** — fresh `ZIV` / `ZEV` views. A discriminator-less body has no
   literal axis, so the zero-leg case is driven by a contradictory base-column predicate
   (`where id=1 and id=2`, provably `unsat`). Asserts the no-op for both `intersect` (every leg unsat) and
   `except` (left operand inconsistent → `fanLegsForFanOut` returns `[]`), each with a positive delete
   beside it.

**Deviation from the ticket worth noting:** the ticket suggested reusing the `U`/`U4` fixtures in place.
I used a **fresh dedicated `PC` fixture** instead, because by end-of-file `U`/`U4` are already mutated by
earlier sections — a fresh grid keeps the matrix assertions self-contained and readable. Same grid shape,
same coverage; the reviewer may prefer to also exercise the literal `U`/`U4` views if they want the exact
spellings from the ticket table.

### Known gaps / floors for the reviewer

- **`exists`-membership path parity is verified by reasoning, not a dedicated new test.** The membership
  write path fans to **all** branches and relies on the runtime member-exists filter, so a no-match
  delete/update produces *non-empty* `baseOps` and never reaches the zero-leg guard — it already no-ops
  at runtime today, independent of this fix. The shared-boundary guard is therefore inert for membership
  (and defends it only if a future change ever made it emit empty `baseOps`). The existing membership
  write tests still pass in the full suite, but no *new* membership no-match-delete assertion was added.
  A reviewer wanting belt-and-suspenders coverage could add one against a membership (`exists … as flag`)
  view fixture.
- **Halloween / capture in the no-op path** is asserted only indirectly (the row-count / base-table
  assertions show nothing is touched). The discarded capture carries no runtime op, so there is no
  fork/drain to leak, but this is argued rather than independently instrumented.

## Docs updated — `docs/view-updateability.md` § Set Operations

- New **"Product-coordinate addressing via projected-constant discriminators"** note (with the
  pin / fan / no-op table) framed as the recommended product surface.
- New **"Zero-leg DELETE / data-UPDATE is a clean no-op"** note, contrasting it with the INSERT
  `consistent with no writable leg` diagnostic.
- The two "shelved `set-op-product-coordinate-model` (backlog)" mentions (sum-surface §, membership-writes
  §) reframed: the product use case is served by projected-constant discriminators; the only genuinely
  out-of-scope residue is **writable boolean membership over a non-literal σ-guard** (the sat-checker
  returns `unknown` on exactly that fragment; reopen only if a concrete use case needs it).

## Validation run

- `yarn workspace @quereus/quereus typecheck` — green (src tsc `--noEmit`).
- `yarn workspace @quereus/quereus lint` — green (eslint src+test + test tsc).
- `yarn workspace @quereus/quereus test` — green, **6330 passing**, 9 pending, 0 failing.
- Focused `93.6-set-op-flagless-write.sqllogic` run — passes.

No pre-existing failures surfaced; no `.pre-existing-error.md` written.
