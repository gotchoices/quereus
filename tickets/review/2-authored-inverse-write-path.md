description: Review the authored-inverse (`with inverse`) write path — build-time validation, lineage upgrade to a writable `authored` UpdateSite (authored wins), single-source UPDATE/INSERT + multi-source UPDATE lowering, view_info/column_info parity, ALTER RENAME propagation, lens-merger carry-through.
prereq: authored-inverse-parser-ast
files:
  - packages/quereus/src/planner/analysis/authored-inverse.ts        # NEW — build-time validation + shared new.* index reader
  - packages/quereus/src/planner/nodes/plan-node.ts                  # 'authored' UpdateSite kind, AuthoredPut, AuthoredInverseMeta
  - packages/quereus/src/planner/analysis/update-lineage.ts          # deriveAuthoredSite, authored-wins in deriveProjectUpdateLineage, ResolvedBaseSite.authored
  - packages/quereus/src/planner/building/select-projections.ts      # validation hook + metadata attach (analyzeSelectColumns gains `source`)
  - packages/quereus/src/planner/building/select-modifiers.ts        # isIdentityProjection gate (authored clause forces a ProjectNode)
  - packages/quereus/src/planner/nodes/project-node.ts               # Projection.authoredInverse
  - packages/quereus/src/planner/mutation/single-source.ts           # WritableSite union; UPDATE flatMap lowering; rewriteAuthoredViewInsert
  - packages/quereus/src/planner/mutation/scope-transform.ts         # substituteNewRefs; inverse-clause clone severing
  - packages/quereus/src/planner/mutation/multi-source.ts            # OutColumn.authored; decomposeUpdate put fan-out; insert-envelope deferral
  - packages/quereus/src/planner/mutation/backward-body.ts           # BackwardColumn.authored threading
  - packages/quereus/src/planner/mutation/decomposition.ts           # rejectAuthoredDecompositionWrite (deferral naming members)
  - packages/quereus/src/func/builtins/schema.ts                     # view_info / column_info authored handling
  - packages/quereus/src/schema/rename-rewriter.ts                   # inverse target/expr/new.-ref rename descent
  - packages/quereus/src/schema/lens-compiler.ts                     # sparse-override merger carries the clause per covered column
  - packages/quereus/test/logic/93.5-authored-inverse.sqllogic       # NEW — behavioral coverage
  - docs/view-updateability.md                                       # § Authored inverses status block, Implementation Map row, Current limitations entry
----

# Authored inverse write path — review handoff

Second step of the `with inverse` feature (parser/AST landed in
`authored-inverse-parser-ast`). This ticket makes the clause *do* something:
build-time validation everywhere it appears, lineage upgrade to a writable
site, and UPDATE/INSERT lowering through the authored expressions. Normative
design: `docs/view-updateability.md` § Authored inverses (now carries a
"Status — what is wired today" block written with this ticket).

## What landed

**Build-time validation** (`planner/analysis/authored-inverse.ts`,
`validateAuthoredInverses`, called from `analyzeSelectColumns` so it runs for
every planned select — top-level, view body, CTE, subquery-in-FROM; verified
position-independent). Four rules, all with sited diagnostics naming the
result column and offending target/ref:
- target resolves to exactly one FROM-source column (resolution by attribute
  name against the planned FROM relation's attributes; ambiguity is an error);
- `new.<name>` resolves to an output column of this select (case-insensitive,
  star-expansion included; recorded as an **output index** so `v(a, b)`
  column-list renames stay positionally stable);
- a non-`new.`-qualified ref in the assignment's own scope is an error;
  subquery-local refs are exempt (they resolve against the subquery's FROM) —
  the same `insideSubquery` discipline as `collectWriteRowColumns`;
- the same target across two result columns is an error (object-keyed, so
  duplicate output names can't mask a collision). In-clause duplicates remain
  a parse error (parser ticket).

**Lineage upgrade** (`update-lineage.ts`): a projection carrying validated
metadata emits an `authored` `UpdateSite` — `{ puts: AuthoredPut[] (table +
baseColumn + expr), newRefIndex }` — with each target resolved through the
child lineage's ownership routing (`resolveBaseSite`). **Authored wins** over
identity / passthrough / registry-`inverse` alike; an unroutable target
(computed / registry-inverse / null-extended / nested-authored child site)
degrades the column to `computed` — never falls back to the inferred put. An
authored CHILD site re-projected by an outer select also degrades to
`computed` (its `newRefIndex` is indexed by the carrying select's outputs,
which an outer projection can reorder/drop) — nested consumption is out of
scope anyway since both spines reject nested-view bodies. Join lineage merge
passes authored sites through untouched (this is what routes the two-sided
case). `ResolvedBaseSite` gains an `authored` member; `baseColumn` stays
undefined for authored sites so no verbatim-value consumer silently admits
them.

**Single-source lowering** (`single-source.ts`):
- `WritableSite` became a `kind`-discriminated union (`base` | `authored`).
- UPDATE: `set viewCol = v` lowers to one base assignment per put; inside the
  authored expr, `new.<assigned>` → the user's value and `new.<other>` → that
  view column's name, both still in **view terms**, then the existing
  view→base lowering maps everything (forward read image for non-assigned
  columns). Rides the existing spine — identifying predicate, RETURNING, the
  `conflicting-assignment` collision guard (an authored put colliding with
  another assignment's base column is caught there).
- INSERT (`rewriteAuthoredViewInsert`): puts evaluated per VALUES row;
  `new.<x>` binds the supplied cell, else the appended constant-FD /
  `insert defaults` expression for `x`'s base column, else NULL. An authored
  put target counts as **supplied** → takes the inverse value ahead of any
  `insert defaults` entry / base default (pinned in the logic test). The
  insertability gate is lifted for authored sites only; registry-`inverse`
  columns stay non-insertable. Base-column collisions between supplied view
  columns reject (`conflicting-assignment`). The appended-defaults logic was
  factored into `collectAppendedDefaults`, shared with the plain path (which
  is otherwise byte-equivalent to before).

**Multi-source UPDATE** (`multi-source.ts`): `OutColumn.authored` carries puts
with resolved side indexes; `decomposeUpdate` fans each put onto its owning
side through a factored `lowerValueOntoSide` (the exact code path plain
assignments use — cross-source read gating, 1:many cardinality gate, captured
partner reads all apply per put). Two-sided targets yield two child ops,
atomic, FK-parent-first (pinned in the logic test). A `new.<x>` whose forward
image reads the partner side rides the captured-read machinery rather than
being rejected (better than the ticket minimum).

**Deferred, with precise sited diagnostics** (documented in docs § Current
limitations + § Authored inverses status block):
- multi-source (join) **INSERT** through an authored column (`no-inverse`,
  naming the column — the envelope projects supplied columns verbatim;
  per-row put evaluation over it is a follow-up);
- **decomposition** writes targeting an authored column
  (`unsupported-decomposition-member`, naming the member(s) the puts route
  to — `rejectAuthoredDecompositionWrite`, run at the two write-classification
  sites only so reads/WHERE are unaffected);
- single-source INSERT with a **SELECT source** (`unsupported-source`; VALUES
  required — same v1 boundary as the appended-defaults rewrite).

**view_info / column_info** (`func/builtins/schema.ts`): authored columns
report updatable; a single-put inverse carries its base trace, a multi-target
one reports null base (same shape as an existence flag). Put targets count
toward `is_insertable_into` not-null coverage on single-source bodies only
(join-body authored INSERT is deferred, so counting there would over-report).

**ALTER … RENAME** (`schema/rename-rewriter.ts`): the clause lives inside
`selectAst`, so the body walkers were extended rather than the insert-defaults
style external helpers: table rename descends into assignment exprs; column
rename rewrites the assignment **target** via a synthetic unqualified-ref
probe through the same scope-aware walk, descends into exprs, and retargets
`new.<old>` refs when a rename shifts an **unaliased bare projection's**
output name (`renameNewQualifiedRefs`, a uniform depth-blind walk — `new` is
a reserved qualifier). `cloneResultColumns` / `rebuildSelect` in
scope-transform now deep-clone the clause so in-place rewriters over cloned
trees can't leak mutations into source ASTs.

**Lens merger** (`schema/lens-compiler.ts`): `compileOverrideBody`'s coverage
map carries the clause per covered column into the composed body (gap-filled
columns never have one); writes through the logical table consume it via the
ordinary spine (one lens-shaped logic test). Full prover integration (PutGet
enumeration, GetPut advisory) is `authored-inverse-lens-prover`.

## Tests

`test/logic/93.5-authored-inverse.sqllogic` (passing): the 20→3 code-collapse
worked example (update stores representative; insert; RETURNING + re-select
normalization — the PutGet observable), the four build-time error cases plus
the in-clause parse error, plan-shape inertness probe (`query_plan` node-type
comparison with/without the clause), authored-wins on identity AND on a
registry-invertible column (including insertability), self-referential
`x + 0 as x with inverse (x = new.x + 1)`, multi-target single-source split
(UPDATE + INSERT) with null-base column_info, two-sided join write +
join-insert deferral diagnostic, NULL→NOT NULL constraint flow,
insert-defaults precedence, `insert or replace`, all three RENAME propagation
shapes (target, output-name shift retargeting `new.` refs, table rename in an
assignment subquery), and a lens-override write-through.

Full `yarn build` + `yarn lint` + `yarn test` pass (5744 quereus logic/spec
tests; all workspaces green). `yarn test:store` was NOT run (per AGENTS.md
it's for store-specific diagnosis only).

## Known gaps / honest notes for the reviewer

- **Pre-existing planner bug found while testing** (NOT mine — reproduced at
  HEAD with changes stashed): `select <computed-col> from <view-or-subquery>
  where <pruned-col> = …` fails at runtime with "No row context found".
  Filed in `tickets/.pre-existing-error.md`; the new logic test sidesteps the
  shape (selects `id, code` instead of `code` alone under a `where id =`).
- `new.<x>` for an INSERT where `x` is neither supplied nor default-appended
  binds **NULL**. The ticket's "post-view-defaulting" wording is honored for
  constant-FD pins and `insert defaults` entries; a base-table-declared
  `default` for an omitted column is NOT visible to `new.<x>` (it applies
  inside the base op, after the rewrite). Documented behavior; worth a
  reviewer sanity check.
- Upsert (`on conflict do update`) through any view passes `upsertClauses`
  through un-rewritten (pre-existing behavior, not widened here); only
  `insert or replace` is pinned in the test.
- The docs' "redundant-on-passthrough advisory" is not emitted (noted in the
  status block); candidate for the lens-prover follow-up.
- No dedicated unit spec was added: there is no existing update-lineage spec
  neighborhood, and `test/property.spec.ts`'s parity harness intentionally
  excludes authored shapes (authored-on-identity columns *deliberately*
  diverge from the identity-only AST classifier — `identityBaseColumn`
  returns undefined for authored sites, keeping the parity bridge intact for
  non-authored bodies). Behavioral coverage lives in the sqllogic file.
- `composeUpdateSite`'s `authored` case is defensively pass-through
  (unreachable from `deriveProjectUpdateLineage`, which pre-degrades; joins
  merge without composing). Flagged in a comment.
- Optimizer rules that rebuild `Projection` arrays may drop the
  `authoredInverse` metadata — harmless today because every consumer
  (spines, view_info) reads the **freshly built** body plan, not the
  optimized tree; worth keeping in mind if a future consumer reads optimized
  plans.
