description: Read half of set-operation membership columns — the `<setop> exists <branch> as <col>` clause (parser/AST/stringify), the set-op-branch variant of `RelationalComponentRef`, the combinator-derived membership-flag projection on `SetOperationNode` (a per-branch semijoin probe yielding a clean `{true,false}` NOT NULL), the `existence` `UpdateSite` registration for set-op branches (read-only here), and the FD ramifications (distinct union stays keyed by data columns; `union all` bag makes no `key → flag` claim). No write semantics — reads only; writing the column still rejects. The write half (membership-flip ⇒ branch insert/delete) is `set-op-membership-write`.
prereq: outer-join-existence-read
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/select-compound.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/runtime/emit/set-operation.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md
----

## Why

This is the **read** half of set-operation membership columns — the set-op sibling of the
outer-join existence column (`outer-join-existence-read` § Why). An outer-join existence
column reifies "is this row present in **component X**" where X is a *join side*; here X is
a *set-op branch*. It is the same idea (state presence explicitly instead of inferring it)
applied to a vertical (row) combination. Reading a membership column tells you which branch(es)
the current row came from. The write side (membership-flip ⇒ branch insert/delete) needs the
per-row conditional-materialization substrate from `view-write-optional-member-transitions`
(via `outer-join-existence-column`) and is deferred to `set-op-membership-write`; this front
half is a pure query-path concern (plain `select` never invokes `propagate()`) and lands first.

The parent design (`set-operator-membership-columns`, now retired into this chain) settles the
read/nesting model: a membership flag is a **derived predicate** `inA ≡ (result-tuple ∈ A)`,
computed at the combinator over operand **data** relations — **never** a stored column inside a
branch. That is what keeps it sound and dedup-safe at any nesting depth.

## Substrate state (read before implementing)

- Set-operation **view writes do not exist today** — `propagate.ts` rejects `SetOperation` as
  `unsupported-set-op` (`classifyViewBody`, ~L85). The `union-branch` / `delete_via` routing
  tags in `reserved-tags.ts` are declared-but-dead (no parser syntax, no consumer). This read
  half changes nothing about that; it only adds the *read projection* + the `existence`-site
  substrate the write half will activate.
- `SetOperationNode` (`set-operation-node.ts`) reuses the **left child's attributes verbatim**
  (`buildAttributes`, ~L37) and drops all FDs/ECs/domains in `computePhysical` (~L66). The flag
  attributes are appended *after* the data columns; the data-column attributes/keys are left
  exactly as today (the flags must never perturb identity/dedup).
- `UpdateSite` (`plan-node.ts` ~L244) gains the `existence` kind + `RelationalComponentRef`
  from `outer-join-existence-read`. This ticket **extends** `RelationalComponentRef` with the
  set-op-branch variant — it does not fork a parallel mechanism.

## The flag is derived at the combinator — not a stored operand column

Load-bearing (shared with `outer-join-existence-read` § The flag is derived at the combinator):
the membership value is **derived at the `SetOperationNode` from the actual operand data**,
never a constant column stored inside a branch. The tempting desugaring
`(select *, true as inA from A) union …` does **not** work as an *exposed* column: a stored
`inA` would re-enter the union's schema and **dedup**, perturbing set identity (the vertical
analogue of the join's null-extended `{true, NULL}` symptom). The combinator must yield a clean
`{true, false}` computed *after* the set operation, so the dedup still operates on data columns
only.

### Recommended implementation: a per-branch membership probe appended at the SetOperationNode

Model each membership column as an **extra output attribute of the `SetOperationNode` itself**,
not a `ProjectNode` expression layered above it (which could only see set-op *outputs* and would
type `computed`, not `existence`-sited). The derivation is **uniform across all four operators**:
build a set (`BTree`) of each branch's **data** rows (reusing the comparator/`BTree` machinery
already in `emit/set-operation.ts`), produce the operator's normal output rows, and for each
output row append one boolean per requested flag = `data-tuple ∈ <that branch's set>` (a
semijoin probe on the data-column identity).

- **`union` / `union all`** — both probes are informative: a result row may be in left, right, or
  both. `inA = tuple ∈ A`, `inB = tuple ∈ B`. For `union all` the probe is against a **set**, so
  the flag is boolean "present ≥ once" (bag multiplicity collapses — documented limit, count
  variant deferred to `set-op-membership-ergonomic-extensions`).
- **`except`** (`A except B`) — every visible row is `inLeft = true, inRight = false` by
  construction; the uniform probe yields exactly that (the row is in `A∖B`, so `tuple ∈ B` is
  false). No special-casing needed.
- **`intersect`** — every visible row is in every branch, so all flags probe `true`.

`computePhysical` **may** constant-fold the trivially-determined flags as an optimization —
`inRight = false` for `except`, all flags `= true` for `intersect` (a `constantBindings` entry) —
eliding the probe. The probe is the general baseline (required for `union`); the constant-fold is
a sound shortcut. Emit the constant-fold if cheap; the probe is the correctness floor.

**Cost note (perf, not correctness):** each exposed flag is a semijoin probe, so many flags / deep
nesting scales read cost. Document this; do not gate on it.

## The set-op-branch `RelationalComponentRef` (the shared substrate)

`outer-join-existence-read` adds (`plan-node.ts`):

```typescript
export type RelationalComponentRef =
  | { kind: 'join-side'; table: number; side: 'left' | 'right' }
  // set-op branch variant — added by THIS ticket:
  ;
```

Add the set-op-branch variant. It must identify (a) the owning `SetOperationNode` and (b) which
operand the flag reifies, so the write half can route to that branch's sub-plan:

```typescript
  | { kind: 'set-op-branch';
      /** The owning SetOperationNode's plan-node id. */
      setOp: number;
      /** Which immediate operand the flag's membership reifies. */
      branch: 'left' | 'right' }
```

- `resolveBaseSite` (`update-lineage.ts` ~L332): an `existence` site whose component is a
  `set-op-branch` resolves to `{ writable: false, nullExtended: false }` **in this read half**
  (no base column; no write effect yet — the write half flips its routing on). `identityBaseColumn`
  returns `undefined`; `viewColumnsFromUpdateLineage` maps it to a non-base column.
- Register one `existence` `UpdateSite` per flag's output attribute id, component = the
  `set-op-branch` ref, `guard` = the branch's accumulated selection predicate (the conjunction
  of σ predicates on the path from the combinator to that branch's base — the write half uses
  this for predicate-honest leaf addressing; here it is carried, not consumed).

## FD ramifications (Invariants 1–2, shared with the join existence column)

`SetOperationNode.computePhysical` / `getType` must extend the forward FD surface per flag:

- **Invariant 1 — key-determined, never in a key.** A **distinct** `union` / `intersect` /
  `except` carries the all-columns `isSet` key on its **data** columns. When the node is keyed,
  emit `key → flag` (so DISTINCT-elimination / ORDER-BY-trailing-key pruning still fire when the
  flag is projected). The flag must **never** be claimed as part of a key (`getType` keys, ~L54)
  — over-claiming lets those rules drop real rows. For `union all` (a **bag**, `isSet=false`) the
  node makes **no `key → flag` claim** — there is no data-column key to determine the flag from.
- **Invariant 2 — constant-true below the combinator, free boolean above.** Within its own branch a
  membership flag is constant-true; the combinator *releases* it into the (key-determined, for
  distinct) free boolean. This is the FD statement of "derived at the combinator, never stored in
  the operand."
- **New attribute, own provenance.** Each flag carries information not FD-derivable from the other
  columns — its own attribute id, never folded into another column's FD nor made an EC member of a
  data column.
- **Domain + NOT NULL.** Domain `{true,false}` NOT NULL — a boolean `domainConstraint` and a
  genuinely-NOT-NULL column. (`except`/`intersect` may additionally carry the constant-fold above.)
- **Pruning / scope.** An unused flag is a semijoin probe → dead-column-eliminate it when not
  selected (it must not force a branch to be retained or probed if no other column needs it).

## Syntax (finalized for this ticket)

Anchored at the set-op boundary, reusing the already-reserved `exists` keyword — **no new
keyword**, additive grammar. The clause sits **after a set-op leg's operator and before its
operand**, naming the two immediate operands of that binary combinator:

```sql
create view U as
  (select id, x from A)
  union exists left as inA, exists right as inB
  (select id, x from B);
```

Resolution rules:

- `exists left as <col>` / `exists right as <col>` — the flag for that immediate operand of the
  binary combinator. Comma-separated; either or both may be exposed. `left` = the leg already
  parsed before the operator; `right` = the operand that follows.
- The binary combinator always names its **own** two operands; the **n-way** case is covered by
  **nesting** (`((A ∪ B) ∪ (C ∪ D))` with flags at both levels — write half / nested ticket), so
  no global positional naming of a "middle branch" is ever needed. (A flat n-way shorthand is
  deferred to `set-op-membership-ergonomic-extensions`.)
- Applies to `union` / `union all` / `intersect` / `except`. **Reject** the clause on `diff`
  (symmetric difference desugars to `(A except B) union (B except A)` in `select-compound.ts`
  ~L65 — membership is ambiguous over the two `except`s); a clear parse/plan diagnostic.

Disambiguation (confirm against the real grammar, `parser.ts` ~L644, compound-op parsing):

- The clause appears only **immediately after a set-op keyword** (`union [all]` / `intersect` /
  `except`), where today the parser expects a leg start (`select` / `values` / `(` / a DML
  keyword — `set-op-membership.read` adds `exists` to that position). `exists` here is **always**
  followed by `left` / `right` — **never `(`** — so one-token lookahead distinguishes it from the
  `exists (<subquery>)` predicate (which never legally begins a compound leg). The trailing
  operand (the leg) still parses after the comma-separated clause.
- This occupies **currently-unused** grammatical space — confirmed additive/non-breaking (the
  `compound` AST node carries no clause there today; `ast.ts` ~L185). **Document** the post-`union`
  interaction in `docs/sql.md`; record the major-version decision as forward-looking governance
  (AGENTS.md: back-compat not yet a concern → today the bar is documentation, not a bump).

**Deferred (not in scope here):** the optional projection-position sugar `exists(<branch>) as inA`
(mirrors the join's deferred `exists(<alias>)` sugar). The combinator-anchored clause is the
substance; revisit the sugar after the write half.

### AST + stringify

- `compound` (`ast.ts` ~L185): extend `{ op, select }` with
  `existence?: ReadonlyArray<{ branch: 'left' | 'right'; name: string }>`.
- `ast-stringify.ts` (`case` compound, ~L465): emit ` exists <branch> as <name>` per entry
  **between** the operator keyword and the right leg, so `parse(stringify(ast)) ≡ ast`.

## Static surfaces (`func/builtins/schema.ts`)

- `column_info(view)` — a `set-op-branch` `existence`-sited output column reports
  `is_updatable = 'NO'` **in this read half**, `base_table` / `base_column` = `null` (no base
  column even when the write half lands — it is writable through an *effect*). The write half flips
  `is_updatable` to `'YES'`, `base_*` still null.
- `view_info(view)` — a set-op view is still non-insertable/non-updatable/non-deletable here (writes
  unimplemented); the membership column does not change that. The write half turns these on.

## Tests (TDD seeds — acceptance gate: `test/property.spec.ts`)

Add a set-op membership family alongside the outer-join family. Use a simple base, e.g.
`create table A (id integer primary key, x integer); create table B (id integer primary key, x integer);`
and `create view U as (select id, x from A) union exists left as inA, exists right as inB (select id, x from B);`

- **Read agreement.** `select id, x, inA, inB from U` — `inA` is `true` exactly on rows whose data
  tuple is present in `A`, `inB` exactly on rows present in `B`; assert row-by-row against
  `tuple ∈ A` / `tuple ∈ B` over seeded data (including a row in both → both true).
- **Operator coverage.** `except`: every visible row reads `inLeft=true, inRight=false`.
  `intersect`: every visible row reads all flags `true`. `union all` (bag): a tuple duplicated
  within a branch still reads the flag `true` (boolean "present ≥ once"; document the multiplicity
  collapse).
- **Clean boolean.** Every flag is NOT NULL and `in (true,false)` for every row.
- **Key Soundness** (`test/property.spec.ts`): adding flags to a **distinct** union leaves its
  `isSet` / claimed keys unchanged; `key → flag` is present in the forward FDs (when keyed); the
  flag never appears inside a claimed key (Invariants 1–2). A **`union all`** flag-bearing node
  makes no `key → flag` claim. The negative self-test reds if a flag is injected into a key.
- **Write still rejects.** `update U set inB = true where id = K` and
  `insert into U (id, x, inA, inB) values (...)` reject (write half not yet wired) — a clear
  deferral diagnostic, not a silent no-op.
- **AST round-trip.** `parse(stringify(ast)) ≡ ast` for `union exists left as inA, exists right as inB`
  (emit-roundtrip + the structural comparator). Reject parse of the clause on `diff`.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`
and `yarn workspace @quereus/quereus lint`.

## Out of scope (keep rejecting / deferring)

- All write semantics (membership-flip insert/delete, insert-through, data-column fan-out) →
  `set-op-membership-write`.
- Nested / subtree flags, product coordinate system, multi-target fan-out, `predicate-contradiction`
  → `set-op-membership-nested`.
- Flat n-way shorthand, `union all` count-variant membership, projection-position `exists(<branch>)`
  sugar → `set-op-membership-ergonomic-extensions` (backlog) / inline deferral.

## TODO

- Parser (`parser.ts` ~L644): after a set-op keyword, parse the optional
  `exists [left|right] as <ident>` clause(s), comma-separated, before the right leg; one-token
  lookahead after `exists` (not `(`) disambiguates from the `exists (<subquery>)` predicate. Reject
  the clause on `diff`.
- AST (`ast.ts` ~L185): add `existence?` to the `compound` shape.
- Stringify (`ast-stringify.ts` ~L465): emit the clause between the operator keyword and the right leg.
- `RelationalComponentRef` (`plan-node.ts`): add the `set-op-branch` variant.
- `SetOperationNode` (`set-operation-node.ts`): carry the membership specs (new constructor field);
  thread through `getChildren`/`withChildren`/`getType`/`buildAttributes`; append one boolean
  `{true,false}` NOT NULL attribute per flag **after** the data columns (never keyed); in
  `computePhysical` emit `key → flag` for the keyed distinct case (no claim for `union all`), the
  boolean domain constraint, optional `except`/`intersect` constant-fold, and register the
  `existence` `UpdateSite` per flag.
- `select-compound.ts` (`buildCompoundSelect`): pass the parsed membership specs into
  `SetOperationNode`; wire scope/attribute exposure so the flag resolves by its `as` name (alongside
  `createSetOperationScope`).
- Emit (`runtime/emit/set-operation.ts`): build a per-branch data-row `BTree` set and append the
  membership bit(s) per output row by probing (uniform across the four operators); reuse the existing
  `collationRowComparator`.
- `update-lineage.ts`: `resolveBaseSite` returns read-only for a `set-op-branch` `existence` site;
  `identityBaseColumn`/`viewColumnsFromUpdateLineage` treat it as a non-base column.
- Dead-column elimination: an unselected flag does not retain/probe its branch.
- `func/builtins/schema.ts`: report the membership column `is_updatable='NO'` / `base_*` null in
  `column_info`.
- Tests above in `property.spec.ts`; docs (`view-updateability.md` § Set Operations — add the
  membership-column read projection and the derived-not-stored rule; `docs/sql.md` — the
  `<setop> exists … as` clause grammar + additive-grammar note).
