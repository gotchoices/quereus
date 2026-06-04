description: Read-only front half of the outer-join existence column — the `exists [<side>] as <name>` join clause (parser/AST/stringify), the new `existence` UpdateSite kind carrying a generalized relational-component reference, the combinator-derived match-indicator projection (clean `{true,false}` NOT NULL), and the FD ramifications (Invariants 1–2: `key → flag`, flag never in a key). No write semantics — reads only; writing the column still rejects. The write half (existence-flip ⇒ insert/delete) is `outer-join-existence-column`.
prereq: view-write-outer-join-static
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/runtime/emit/join.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md
----

## Why

This is the **read** half of the Dataphor `include rowexists` feature (the parent
ticket `outer-join-existence-column` § Why / § Model / § Dependency). It manifests
the match-existence of an outer join's non-preserved side as a first-class boolean
column. Reading it tells you whether that side matched the current row. The write
side (existence-flip ⇒ insert/delete of that side) needs the per-row conditional
materialization substrate from `view-write-optional-member-transitions` and is
deferred to the companion `outer-join-existence-column`; this front half is
independent of the write substrate (the read projection is a pure query-path
concern — plain `select` never invokes `propagate()`) and can land first.

The parent ticket splits the work this way explicitly: "The read projection
(guard-as-boolean) is independent and could land first if the plan stage splits
this into a read-only front half and a write-enabled second half."

## The flag is derived at the combinator — not a stored operand column

Load-bearing (the principle shared with `set-operator-membership-columns`): the
existence value is **derived at the join from the actual match**, never a constant
column stored inside the operand. The tempting desugaring
`left join (select *, true as inB)` does **not** work as an *exposed* column: the
outer join null-extends the constant, so the exposed value is `{true, NULL}` and
reading it then needs `IS NOT NULL` — the very null-extension test the column was
meant to replace. The combinator must yield a clean `{true, false}`.

**Soundness rule for the indicator:** the match flag must reflect *actual
null-extension at the combinator*, **not** a re-evaluation of the ON predicate over
the joined row. Re-evaluating the predicate is unsound for predicates that are
satisfiable on a null-extended row (`B.aid = A.id or A.id is null` → `true` on a
row where B did not match). The join operator already knows, per emitted row,
whether the right (or left) side matched — that single bit is the flag.

### Recommended implementation: a JoinNode-native flag attribute

Model the existence column as an **extra output attribute of the `JoinNode`
itself**, not a `ProjectNode` expression layered above it. This keeps the flag "at
the combinator" in every machinery layer at once — emit produces the bit, and
`computePhysical` owns its FD / `UpdateSite` / domain. A `ProjectNode` over the
join could only see join *outputs* (it would have to re-derive the match from
nullability, the unsound path) and would type the column `computed`, not
`existence`-sited.

- **Emit** (`runtime/emit/join.ts`): for each requested existence column, append a
  boolean output that is `true` on a matched row and `false` on a null-extended
  row for the referenced side. The outer-join emitter already distinguishes these
  two cases (it is the code that performs null-extension); expose that bit.
- **Attributes** (`join-utils.ts` `buildJoinAttributes` / `buildJoinRelationType`):
  append one attribute per existence column **after** both sides' columns, typed
  boolean **NOT NULL** (never marked nullable — it is the clean-boolean point), and
  **never** a member of any join key (`combineJoinKeys` must not see it).
- A sound fallback if the emitter bit is awkward to surface: an *internal* sentinel
  (`true` literal appended to the operand's rows) threaded through the existing
  outer-join null-extension, read back as `sentinel IS NOT NULL` to form the
  exposed column. This is sound (the sentinel is literally `true` on every operand
  row, so `NULL` arises *only* from null-extension, independent of the predicate) —
  but it touches more nodes. Prefer the native attribute; document whichever ships.

## The `existence` UpdateSite (the shared substrate)

Extend the `UpdateSite` union (`plan-node.ts` ~L244) with a 4th kind. It must carry
a **generalized relational-component reference**, not a hard-coded join side, so
`set-operator-membership-columns` extends it (join-side *or* set-branch) rather than
forking a parallel mechanism (parent ticket § Relationship to the tag surface; the
membership ticket § Concept):

```typescript
export type UpdateSite =
  | { kind: 'base'; table: number; baseColumn: string; inverse?; domain? }
  | { kind: 'computed'; expr: Expression }
  | { kind: 'null-extended'; guard: Expression; inner: UpdateSite }
  | { kind: 'existence';
      /** The relational component whose match the flag reifies. */
      component: RelationalComponentRef;
      /** The join-predicate guard (AST) the flag is the truth-value of. */
      guard: Expression };

/** Generalized component handle — a join side now, a set-op branch later. */
export type RelationalComponentRef =
  | { kind: 'join-side'; /** non-preserved TableReferenceNode plan-node id */ table: number;
      side: 'left' | 'right' }
  // set-op branch variant added by set-operator-membership-columns
  ;
```

- `resolveBaseSite` (`update-lineage.ts` ~L332): an `existence` site resolves to
  `{ writable: false, nullExtended: false }` **in this read half** (no base column;
  no write effect yet). The write half flips its routing on. `identityBaseColumn`
  returns `undefined` for it. `viewColumnsFromUpdateLineage` maps it to a non-base
  column (it has no `baseColumnName`).
- `deriveJoinUpdateLineage`: when the JoinNode carries existence columns, register
  an `existence` `UpdateSite` for each flag's output attribute id (component =
  the non-preserved side it references, guard = the join predicate).

## FD ramifications (Invariants 1–2 are load-bearing)

`JoinNode.computePhysical` (`join-node.ts` ~L97) must extend the forward FD surface
for each flag attribute:

- **Invariant 1 — key-determined, never in a key.** When the join output has a key
  (a 1:1 join's preserved PK), emit `key → flag` so DISTINCT-elimination /
  ORDER-BY-trailing-key pruning / join-elimination still fire when the flag is
  projected. The flag must **never** be claimed as part of a key — over-claiming
  there lets those rules drop real rows. (`propagateJoinFds` / `combineJoinKeys` in
  `join-node.ts` / `join-utils.ts`.)
- **Invariant 2 — constant-true below the combinator, free boolean above.** Within
  its own component the flag is constant-true (`∅ → flag = true`); the combinator
  *releases* it into the key-determined free boolean. This is the FD statement of
  "derived at the combinator, never stored in the operand."
- **New attribute, own provenance.** The flag carries information not FD-derivable
  from the other columns (that is its purpose) — its own attribute id, never folded
  into another column's FD nor made an EC member of a base column.
- **Domain + NOT NULL.** Domain `{true,false}` NOT NULL — a boolean
  `domainConstraint` and a genuinely-NOT-NULL column.
- **Pruning / scope.** An unused flag is a semijoin probe → dead-column-eliminate it
  when not selected (it must not force the non-preserved side to be retained if no
  other column needs it). A live flag is a read concern only in this half.

The **Key Soundness** property harness (`test/property.spec.ts`) must cover a
flag-bearing node: the node's `isSet` / claimed keys are unchanged by adding the
flag column, and the materialized-row check never sees the flag inside a claimed
key.

## Syntax (finalized for this ticket)

Anchored at the join, reusing the already-reserved `exists` keyword — **no new
keyword**, additive grammar:

```sql
from A left join B on B.aid = A.id exists as hasB          -- non-preserved side (B)
from A full outer join B on B.aid = A.id                   -- full: one per side, explicit
       exists left as aEx, exists right as bEx
```

Resolution rules:

- `exists as <name>` — the **non-preserved** side of a `left` / `right` join (the
  unambiguous side). Reject on `full` (ambiguous — side required) and on
  `inner` / `cross` (no null-extension; the flag would be a meaningless constant
  `true`) with a clear parse/plan diagnostic.
- `exists left as <name>` / `exists right as <name>` — explicit side; **required**
  for `full outer`; comma-separated to expose both.
- Disambiguation (confirm against the real grammar, parser.ts ~L1089): the clause
  appears only **after a complete `on` predicate** (there is no infix `exists`, so a
  finished predicate cannot absorb a trailing `exists`), and `exists` here is always
  followed by `as` or a side token — **never `(`** — so one-token lookahead after
  `exists` distinguishes the clause from the `exists (<subquery>)` predicate. The
  comma form disambiguates from a new FROM source by the post-comma token (`exists`
  ⇒ another clause). This occupies currently-unused grammatical space; **document**
  the post-`on` interaction in `docs/sql.md` (the additive-not-breaking check is
  shared governance with `set-operator-membership-columns`).

**Deferred (not in scope here):** the optional projection-position sugar
`exists(<source-alias>) as hasB`. The join-anchored clause is the substance; the
projection sugar can be a thin follow-up that desugars to the same `existence` site.
Recording the decision here: ship only the join-anchored clause; revisit the sugar
after the write half lands.

### AST + stringify

- `JoinClause` (`ast.ts` ~L440): add
  `existence?: ReadonlyArray<{ side: 'left' | 'right'; name: string }>`.
- `ast-stringify.ts` (~L558, `case 'join'`): emit ` exists [<side>] as <name>`
  per entry after the `on` clause, so `parse(stringify(ast)) ≡ ast`.

## Static surfaces (`func/builtins/schema.ts`)

`view-write-outer-join-static` (the prereq) relaxes the outer-join all-`NO` gate to
per-side. Layer the existence column onto that:

- `column_info(view)` — an `existence`-sited output column reports
  `is_updatable = 'NO'` **in this read half** (it is not yet writable) with
  `base_table` / `base_column` = `null` (it has no base column even when the write
  half lands — it is writable through an *effect*, not a base mapping). The write
  half updates `is_updatable` to `'YES'` while keeping `base_*` null.
- `view_info(view)` — the existence column does not change `is_insertable_into` /
  `is_deletable` here; the parent body's per-side facts (from the prereq) stand.

## Tests (TDD seeds — acceptance gate: `test/property.spec.ts`)

Build on the `rj_outer` fixture (`rjchild c left join rjparent p on p.pp = c.pr`,
property.spec ~L3452; `rjchild` preserved/left, `rjparent` non-preserved/right). Add
a view variant exposing the flag, e.g.
`create view rj_ex as select c.cc, c.cv, p.pv, exists right as hasP from rjchild c left join rjparent p on p.pp = c.pr`.

- **Read agreement.** `select cc, hasP from rj_ex` — `hasP` is `true` exactly on
  rows whose parent matched, `false` on null-extended rows; assert against the
  guard truth row-by-row. Cover a predicate that is satisfiable-on-null-extended
  (`... on p.pp = c.pr or c.pr is null`) to prove the flag tracks *actual* match,
  not predicate re-evaluation (the soundness rule above).
- **Clean boolean.** `hasP` is never `NULL` (NOT NULL); `hasP in (true,false)` for
  every row.
- **Key Soundness** (`test/property.spec.ts`): adding `hasP` to the projection
  leaves the view's `isSet` / claimed keys unchanged; `key → hasP` is present in the
  forward FDs (when the join output is keyed); `hasP` never appears inside a claimed
  key (Invariants 1–2). The negative self-test reds if the flag is injected into a
  key.
- **Write still rejects.** `update rj_ex set hasP = true where cc = K` and
  `insert into rj_ex (... hasP) values (...)` reject (the write half is not yet
  wired) — a clear deferral diagnostic, not a silent no-op.
- **AST round-trip.** `parse(stringify(ast)) ≡ ast` for `exists as hasB`,
  `exists left as a, exists right as b` (`emit-roundtrip` + the structural
  comparator). Reject parse on `exists as x` over `full`/`inner`/`cross`.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`
and `yarn workspace @quereus/quereus lint`.

## TODO

- Parser (`parser.ts` ~L1089): after a complete join `on` predicate, parse the
  optional `exists [left|right] as <ident>` clause(s), comma-separated; one-token
  lookahead after `exists` (not `(`) disambiguates from the `exists (<subquery>)`
  predicate. Enforce side resolution (default non-preserved for left/right; require
  side for full; reject inner/cross).
- AST (`ast.ts`): add `existence?` to `JoinClause`.
- Stringify (`ast-stringify.ts` `case 'join'`): emit the clause after `on`.
- `UpdateSite` (`plan-node.ts`): add the `existence` kind + `RelationalComponentRef`
  (join-side variant now; leave room for the set-op branch variant).
- JoinNode (`join-node.ts`): carry the existence specs; thread them through
  `getChildren`/`withChildren`/`getLogicalAttributes`; in `computePhysical` emit
  `key → flag`, the boolean `{true,false}` NOT NULL domain constraint, and register
  the `existence` `UpdateSite` per flag via `deriveJoinUpdateLineage`; keep the flag
  out of every key (`combineJoinKeys`).
- `join-utils.ts` (`buildJoinAttributes`/`buildJoinRelationType`): append the flag
  attribute(s) after both sides, boolean NOT NULL, never keyed.
- Emit (`runtime/emit/join.ts`): produce the matched/null-extended bit per flag
  (native attribute preferred; document the internal-sentinel fallback if used).
- `select.ts` (~L641, `buildJoinClause`): pass the parsed existence specs into
  `JoinNode`; ensure scope/attribute wiring exposes the flag by its `as` name.
- `update-lineage.ts`: `resolveBaseSite` returns read-only for `existence`;
  `identityBaseColumn`/`viewColumnsFromUpdateLineage` treat it as a non-base column;
  `deriveJoinUpdateLineage` registers the site.
- `func/builtins/schema.ts`: report the existence column `is_updatable='NO'` /
  `base_*` null in `column_info` for this read half.
- Dead-column elimination: an unselected flag does not retain the non-preserved side.
- Tests above in `property.spec.ts`; docs (`view-updateability.md` § Outer Joins —
  add the existence-column read projection; `docs/sql.md` — the `exists … as` join
  clause grammar + additive-grammar note).
