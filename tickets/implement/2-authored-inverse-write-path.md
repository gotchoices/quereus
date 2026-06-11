description: Validate and consume the `with inverse` clause — build-time target/NEW resolution wherever the clause appears, update-lineage upgrade of computed columns to writable-with-supplied-put, and INSERT/UPDATE lowering through the authored expressions in view-mutation.
prereq: authored-inverse-parser-ast
files:
  - packages/quereus/src/planner/building/select-projections.ts   # carry inverse metadata onto projections; build-time validation
  - packages/quereus/src/planner/analysis/update-lineage.ts       # computed + authored inverse → writable base site
  - packages/quereus/src/planner/analysis/scalar-invertibility.ts # authored-wins precedence over inferred profiles
  - packages/quereus/src/planner/building/view-mutation-builder.ts # UPDATE/INSERT lowering through authored expressions
  - packages/quereus/test/logic/                                  # new authored-inverse sqllogic file
  - docs/view-updateability.md                                    # § Authored inverses (already written — reconcile)
----

# Authored inverse clause — validation + write path

Second step. The clause parses and round-trips (`authored-inverse-parser-ast`);
this ticket makes it *do* something. Normative design:
`docs/view-updateability.md` § Authored inverses (`with inverse`).

## Build-time validation (position-independent)

Wherever a select with the clause is planned — top-level query, view body,
CTE, subquery-in-FROM — validate eagerly, so a typo fails loud even when the
relation is never written:

- every assignment **target** resolves to a column of the select's FROM
  sources (a base/basis column, possibly alias-qualified resolution by the
  same rules as any column ref in the body);
- every **`new.<name>`** reference inside an assignment expression resolves to
  an **output column** of this select (the view row), by output name
  (case-insensitive, same as coverage matching);
- a non-`new.`-qualified column reference inside an assignment expression is
  an error (the inverse is over the written row only — bare base columns are
  not in scope; this is what keeps the clause unambiguous);
- duplicate targets within one clause, and the same target across two result
  columns of one select, are errors (two puts for one base column is
  ill-defined).

Sited diagnostics naming the result column and the offending target/ref.
Until the relation is a write target the clause is otherwise **inert**.

## Lineage upgrade

In `update-lineage.ts`, a projection output whose expression classifies
`computed` (opaque) but which carries an authored inverse resolves to a
**writable `base` site with supplied put assignments** (shape at the
implementer's discretion — it must carry the target base column + expression
pairs through to the mutation builder, and must compose with the existing
per-side/per-member ownership routing).

**Authored wins**: an authored inverse on a column the registry could invert
(or a passthrough/identity column) overrides the inferred put entirely. The
clause is **total per column** — never composed with registry-inferred steps
around it.

`view_info` / `column_info` report the column writable (and insertable — see
below), agreeing with the dynamic truth as always.

## Mutation lowering

- **UPDATE** — `set viewCol = <value>` lowers to one base assignment per
  authored target. Inside each authored expression, substitute:
  `new.<assigned col>` → the user's assignment value expression;
  `new.<other col>` → that column's **forward expression over base columns**
  (its read image — sound for any output column whose forward is expressible
  over the base row). The result is a plain base-table `set` per target,
  riding the existing spine (identifying predicate, eager key capture, etc.).
  A `new.<x>` reference whose column's forward cannot be expressed over the
  base row of the *same* source (e.g. a cross-source column in a join body)
  is rejected with a sited diagnostic for now — name it precisely.
- **INSERT** — the envelope evaluates each authored expression per produced
  row with `new.*` bound to the supplied (post-view-defaulting) row values,
  writing the results to the target base columns. This **lifts the
  insertability gate** for authored-inverse columns (registry-`inverse`
  columns stay non-insertable — the gate change is scoped to authored sites).
- **Routing** — each target assignment routes to the base relation owning the
  target column via the existing ownership walk: single-source bodies and
  multi-source join bodies are in scope. The **decomposition fan-out** may be
  deferred if non-trivial — if so, reject with a sited diagnostic naming the
  member, and record the deferral in docs + handoff (do not silently
  mis-route).

## Edge cases & interactions

- **Self-referential inverse** — `x + 0 as x with inverse (x = new.x)` (target
  shares the output name): resolution must keep target-namespace (base) and
  `new.`-namespace (view output) distinct.
- **Multi-target across two sides of a join** — `with inverse (a_col = …, b_col = …)`
  where `a_col`/`b_col` live on different join sides: two child ops, atomic,
  ordered by the existing FK-parent-first rule.
- **Both-targets-one-column collision** — two view columns authoring puts to
  the same base column: build-time error (named above); pin it.
- **Interaction with `insert defaults`** — an authored-inverse target column
  must take the inverse-computed value ahead of any `insert defaults` entry or
  base `default` for that column (it is a supplied value, not an omission).
- **Conflict resolution** — `insert or replace` / upsert through a view with
  an authored-inverse column: the lowered base values participate normally;
  one logic test.
- **RETURNING** — reads back through the *forward* expression
  (post-mutation): `returning code` after writing through the inverse shows
  the normalized representative (this IS the PutGet observable — pin it).
- **Unused clause stays inert** — a top-level `select … with inverse (…)`
  that is never a write target executes identically to the same select
  without the clause (plan shape unaffected — the metadata must not block
  optimization; golden-plan or plan-shape probe).
- **NULL flow** — authored expression producing NULL into a NOT NULL base
  column: ordinary constraint error, sited at the base op (no special case).
- **Lens bodies** — the clause inside a `declare lens` view body flows
  through the sparse-override merger per covered column (the merger must
  carry the field; a gap-filled column never has one). One lens-shaped logic
  test here; full prover integration is `authored-inverse-lens-prover`.

## Tests

New `test/logic/authored-inverse.sqllogic`: the 20→3 code-collapse worked
example (update through the view stores the representative; insert through
the view; read-back normalization via RETURNING and re-select), error cases
(unknown target, bare base ref in inverse expr, duplicate target, `new.`
ref to a non-output column), authored-wins-over-inferred, multi-target
two-sided join write, inert-unused clause. Plus unit coverage in the
update-lineage/view-mutation spec neighborhood if one exists.

## TODO

- Build-time validation (all four rules, sited diagnostics)
- Lineage upgrade + authored-wins precedence
- UPDATE substitution lowering; INSERT envelope evaluation; insertability gate scoped lift
- Ownership routing (single + multi-source; decomposition defer-with-diagnostic if needed)
- view_info / column_info parity
- Logic tests + edge cases above
- Reconcile docs/view-updateability.md § Authored inverses with what landed
- `yarn build`, `yarn lint`, `yarn test`
