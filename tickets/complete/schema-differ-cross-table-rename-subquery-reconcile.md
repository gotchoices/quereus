description: COMPLETE — generalized the differ-side inverse table-rename reconcile (CHECK bodies and partial-index WHERE) from owning-table-only to ALL in-diff table renames; 3 new equivalence tests; reviewed.
files:
  - packages/quereus/src/schema/schema-differ.ts          # reconciledDeclaredBody case 'check' (~1095); declaredIndexCanonicalBody (~885) + call site (~490)
  - packages/quereus/test/declarative-equivalence.spec.ts # 3 new tests after the "UNQUALIFIED ref under a pure table rename" guard (~2978)
  - docs/schema.md                                        # constraint + index body-change sections updated to all-renames scope (review pass)
  - packages/quereus/src/runtime/emit/alter-table.ts      # reference: rewriteTableForTableRename — the forward all-tables loop this mirrors
----

# Cross-table rename reconcile in CHECK / index-predicate bodies (diff side)

## What was done

A CHECK (or partial-index WHERE) whose body references ANOTHER table — e.g. `check (qty <= (select max(cap) from lim))` — churned a benign drop+recreate when that other table was renamed in the diff, because the diff-side inverse reconcile applied only the owning table's own rename while the forward migration (`rewriteTableForTableRename`) walks ALL tables.

- `reconciledDeclaredBody` case `'check'`: single self-rename find/if → loop inverse-applying EVERY in-diff table rename over the cloned expression. The OLD-seeded column-rename loop below is unchanged (cross-table renames never alter the seed).
- `declaredIndexCanonicalBody`: parameter `tableRename: RenameOp | undefined` → `tableRenames: ReadonlyArray<RenameOp>`; WHERE clone loops all renames; the index's OWN rename lookup (column-rewrite seed) moved from the call site into the function; clone guard widened to `tableRenames.length > 0`.
- Doc comments at both functions and the index-loop call site state the all-renames scope, the sequential-application safety rationale, and the index cross-table unreachability note.
- 3 new tests in `declarative-equivalence.spec.ts`: pure cross-table rename (no churn, forward propagation follows, enforcement intact, converges); owning + other table renamed in one diff (no churn, both stored refs follow); regression — genuine body edit (`max`→`min`) layered on the cross-table rename still drops+recreates and enforces the edited boundary.

## Review findings

**Reviewed:** implement diff `ce856ee4` read fresh before the handoff; full current source of `reconciledDeclaredBody`, `declaredIndexCanonicalBody`, the index call site, `resolveRenames`, `renameTableInAst` (rename-rewriter.ts), the forward paths `propagateTableRenameInSchema` / `rewriteTableForTableRename` / `propagateColumnRenameInSchema`, the memory backend's `compilePredicate`, the 3 new tests in surrounding-suite context, and `docs/schema.md`.

**Correctness — confirmed:**
- The safety argument holds against `resolveRenames`' actual rules: a `RenameOp` is pushed only when no `nameMatch` exists (the name-match branch `continue`s first), so every `newName` is absent from the actual catalog while every `oldName` (a hint match drawn from `actual`) is present; `consumedActuals` forbids duplicate `oldName`s and the declared-map keying forbids duplicate `newName`s. Hence no inverse output can match another inverse input — sequential in-place application is order-independent, as the doc comments claim.
- `tableRenames` at both call sites is the table-kind `resolveRenames` result only (schema-differ.ts ~309) — no view/index renames leak into the loop.
- The index path's moved own-rename lookup is byte-equivalent to the deleted call-site lookup (case-insensitive match on the declared table name). The widened clone guard only adds a no-op clone+walk for predicates on non-renamed tables when some other table renamed — verified `renameTableInAst` can't match there (a rename's newName can't equal an existing table's name, and a declared-new table can't share a rename's newName since declared names are unique). Negligible cost, no behavior change for reachable inputs.
- Unreachability claim verified: `compilePredicate` (memory backend) throws on subqueries (`predicate.ts` ~111) and on schema-qualified refs, so no actual catalog index can carry a cross-table reference — the index-side generalization is symmetry/future-proofing, exercised indirectly by every existing partial-index rename test (own rename is one loop iteration).
- The FK branch's existing single-parent `tableRenames.find` and the PK reconcile are correctly untouched (PK references only local columns).

**Tests:** the 3 new tests cover diff shape, forward-propagated stored bodies, post-rename enforcement (both accept and reject sides), and re-diff convergence; the regression test pins drop+recreate precedence with a semantically observable boundary change (min vs max). I accepted the implementer's flagged omission of a hand-built-catalog index test — the path is unreachable end-to-end, documented as such, and mechanically identical to the well-tested CHECK loop; a synthetic test would pin behavior no backend can produce.

**Found + fixed inline (minor):** `docs/schema.md` was stale — the constraint body-change section still said the CHECK qualifier pass runs "against the table's own in-diff rename", and the index section said "the index table's own in-diff rename is threaded in". Both updated to the all-renames scope, with the sequential-safety rationale, the index unreachability note, and the per-rename scope-naïveté wording ("a renamed table's new name"). No other stale doc references found.

**Found + filed (major, out of scope):** the sibling gap for cross-table COLUMN renames — `check (qty <= (select max(cap) from lim))` with `lim.cap → capacity` renamed in-diff still churns, because the CHECK branch applies only the owning table's `colRenames` (the already-threaded `columnRenamesByTable` is used only by the FK branch) while the forward `propagateColumnRenameInSchema` walks all tables. Benign/converging by the same argument, but scope-sensitive to fix (unqualified subquery columns need a `ResolveColumnInSource`-style resolver the differ lacks). Filed as `tickets/backlog/schema-differ-cross-table-column-rename-subquery-reconcile`.

**Validation:** `yarn lint` (packages/quereus) clean; `tsc --noEmit` clean; full root `yarn test` green (quereus core 5577 passing / 9 pending, declarative-equivalence 108 passing incl. the 3 new; all other workspaces green). Review-pass changes are docs/tickets only, so no re-run was needed after the inline fix.

**Error handling / resource cleanup / type safety:** nothing to flag — the change is pure-function reconcile logic over clones (no I/O, no resources), `ReadonlyArray<RenameOp>` typing is correct and `any`-free, and the rewriters' in-place mutation is contained by the pre-existing `cloneExpr` discipline at both sites.
