description: Precision refinement — screen `old.` row-image refs per AND-conjunct instead of per whole CHECK, so mixed transition/invariant checks keep contributing their invariant conjuncts.
difficulty: easy
files:
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/test/optimizer/check-derived-fds.spec.ts
  - docs/optimizer.md
----

# Per-conjunct `old.`-screen in CHECK fact extraction

The row-invariant gate used to kill an entire CHECK when any `old.<col>`
reference appeared anywhere in its expression. The refinement moves the
`old.`-screen from check level into `walkConjunction`'s AND-conjunct level so
checks that AND a transition conjunct with plain invariant conjuncts — e.g.
`check ((old.id is null or id = old.id) and status in ('a','i'))` — keep
contributing the invariant conjunct's facts (here the `status` enum domain).

**Soundness.** Under SQL ternary logic `C1 AND C2` is FALSE whenever `C2` is
FALSE, so every stored row satisfies "each `old.`-free conjunct not FALSE" —
exactly what a standalone `check (C2)` guarantees. The argument does not
extend through OR: an `old.` ref inside any non-AND conjunct (OR disjunct,
BETWEEN bound, IN list, compound operand) still kills that whole conjunct.

## Final shape

- `isRowInvariantCheck` keeps only the two **check-level** legs (mask covers
  INSERT+UPDATE; not deferred).
- `walkConjunction` tests each non-AND conjunct with `containsOldRowImageRef`
  and skips it if it references OLD; siblings extract normally.

## Review findings

**Implementation note.** Per the implement handoff, the diff for this ticket
was swept into commit `c04e512e` ("ticket(implement):
maintained-table-attach-detach-verbs") alongside ticket 6.2's
`getTrustedCheckExtraction` / capability-gate work. Only the
`walkConjunction` / `isRowInvariantCheck` changes and the two new spec pins
belong to this ticket; the capability-gate code is reviewed under its own
ticket and was not in scope here.

**Reviewed (diff read first, then handoff):**

- *Soundness of the per-conjunct screen.* Confirmed. `walkConjunction`
  decomposes top-level ANDs and applies `containsOldRowImageRef` to each
  maximal non-AND subtree. The union of those subtrees covers every leaf
  except the AND binary nodes themselves (which can't be column refs), so no
  `old.` ref the old whole-check screen caught is now missed. Ternary-logic
  argument holds: AND is FALSE iff some operand is FALSE ⇒ whole-not-FALSE ⇒
  every conjunct not-FALSE over stored rows, which is exactly the standalone
  `check(Ci)` guarantee each shape's extraction relies on.
- *OR / non-AND non-extension.* `containsOldRowImageRef` walks the full
  conjunct subtree via `walkAstNodes`, so an `old.` ref inside an OR disjunct,
  BETWEEN bound, IN list, or compound operand screens out the entire conjunct.
  Verified by the existing kill tests (still single-conjunct ⇒ fully killed)
  plus the new OR-disjunct pin.
- *Regressions.* All pre-existing row-invariant kill tests unchanged and
  green; `new.<col>` same-row path unchanged; `containsNonDeterministicCall`
  check-level kill unchanged. Full optimizer folder: 1362 passing.
- *Type safety / DRY / altitude.* No `any`; `containsOldRowImageRef` reused
  unchanged at the new call site; no duplication introduced. Perf neutral —
  the screen walks the same total node set, just partitioned per conjunct.

**Found and fixed inline (minor):**

- *Stale doc.* `docs/optimizer.md` § Check-derived contributions still listed
  the `old.`-screen as whole-check leg (3). Rewrote the Row-invariant gate
  paragraph to describe the two check-level legs plus the per-conjunct
  `old.`-screen, including the ternary-logic soundness note and the
  non-extension-through-OR caveat, with the mixed-check example.

**Filed (major):** none — the change is a self-contained, sound precision
improvement.

**Validation:** `eslint` clean on both touched source files;
`test/optimizer/check-derived-fds.spec.ts` 47 passing (including the two new
pins); full `test/optimizer/**` folder 1362 passing. No pre-existing failures
encountered.
