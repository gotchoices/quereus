<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-13T02:02:24.290Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\1-maintained-set-maintained-rename-list-verb.implement.2026-06-13T02-02-24-290Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Extend the `alter table … set maintained` verb with an explicit rename-list syntax (`set maintained (a, c) as <body>`), and teach the attach core to apply that list as a positional rename AND reshape the backing (rename only) when an explicit-recorded table's column names drift. This is the verb foundation the differ ticket (maintained-reattach-explicit-rename-list-reshape) drives; it is independently testable via manual SQL.
prereq:
files:
  - packages/quereus/src/parser/parser.ts                            # SET MAINTAINED action parse (~3169) — add optional (cols) list before AS
  - packages/quereus/src/parser/ast.ts                               # setMaintained AlterTableAction (~723) — add columns?
  - packages/quereus/src/emit/ast-stringify.ts                       # alterTable setMaintained render (~1263) — emit (a, c) when columns present
  - packages/quereus/src/planner/building/alter-table.ts             # setMaintained build (~205) — thread columns into the node
  - packages/quereus/src/planner/nodes/alter-table-node.ts           # setMaintained action type (~123) + toString (~186)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # runSetMaintained (~1326) — pass columns → positionalRename + recordedColumns
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation (~869) — explicit-target reshape mode; reshape-gate relaxation for explicit→implicit
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # new: explicit rename-list verb cases
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic  # new section: set maintained (cols) as
  - docs/materialized-views.md                                       # SET MAINTAINED AS — document the (cols) rename-list form
difficulty: hard
----

# `set maintained (cols) as` — explicit rename-list re-attach + backing reshape

## Why the verb needs a rename list

An EXPLICIT maintained table (sugar `mv (a, b)` or table-form `maintained (a, b)`)
deliberately renames the body's natural output names to an authored list. The
attach verb (`alter table … set maintained as <body>`) today has NO rename-list
syntax, so it can only attach the body's NATURAL names. Two consequences, both
currently broken:

- **Rename-list change** `mv (a, b)` → `mv (a, c)`: the backing column must be
  renamed `b → c` and the derivation re-recorded as `(a, c)`. The verb cannot
  express this.
- **Body-only change on an explicit MV** (rename list unchanged): e.g.
  `mv (a, b) as select id, x` → `… select id, x + 1`. The differ emits a
  re-attach `set maintained as select id, x + 1`, whose natural names `(id, x)`
  ≠ the table's `(a, b)`, so `describeAttachShapeMismatch` errors and the
  reshape-on-attach gate refuses it (prior record is explicit). **This already
  errors today, untested.**

The fix the differ ticket needs is a verb that carries the authored list:
`alter table mv set maintained (a, c) as select id, x from t`. Because
`apply schema` round-trips the migration through SQL strings
(`schema-declarative.ts` → `_execWithinTransaction`), and convergence requires
the rename list to be recorded SEPARATELY from the body (`viewDefinitionToCanonicalString`
prepends `(a, c)` to the body — an aliased body `select id as a, x as c`
canonicalizes differently and never converges), the rename list MUST travel as
first-class grammar. This ticket adds that grammar and the verb behavior; the
differ ticket emits it.

## Grammar + plumbing

`MaintainedClause.columns` already exists for the CREATE form
(`parseMaintainedClause`, parser.ts ~2614). Mirror it on the SET MAINTAINED
action:

```
alter table <t> set maintained [ ( col, col, … ) ] as <query-expr> [ insert defaults (…) ]
```

- **parser.ts ~3169** — between `MAINTAINED` and `AS`, parse an optional
  parenthesized identifier list (reuse the same shape as parser.ts 2622-2633:
  reject an empty `()`, allow CONTEXTUAL_KEYWORDS as column names). Produce
  `action = { type: 'setMaintained', columns, select, insertDefaults }`.
- **ast.ts ~723** — add `columns?: ReadonlyArray<string>` to the setMaintained
  action.
- **ast-stringify.ts ~1263** — render `set maintained (a, c) as <select>` when
  `action.columns?.length`; otherwise the bare `set maintained as` form
  (byte-identical to today). This is what `generateMigrationDDL` round-trips.
- **alter-table-node.ts ~123 / ~186** — carry `columns?` on the action; reflect
  it in `toString`.
- **building/alter-table.ts ~205** — thread `columns: stmt.action.columns` into
  the `AlterTableNode` action. Keep the build-time gates as-is (no build-time
  arity gate — see the existing comment at ~174; the full check is runtime).

## Verb behavior (attachMaintainedDerivation)

`runSetMaintained` (alter-table.ts ~1326) currently hardcodes
`recordedColumns = undefined, positionalRename = false`. Thread the action's
`columns`:

- `columns` present → `recordedColumns = columns`, `positionalRename = true`,
  `allowReshape = true` (the explicit-target path).
- `columns` absent → unchanged (`undefined, false, true`) — the implicit path the
  sibling ticket built.

In `attachMaintainedDerivation` (helpers.ts ~869), two changes:

### 1. Explicit-target reshape (positional re-attach with name drift)

Today the positional path (`positionalRename = true`) derives the shape with the
recorded columns (so `shape.columns` carry the TARGET names `(a, c)`) and runs
`describeAttachShapeMismatch(table, shape, /*skipNames*/ true)` — which skips the
per-column NAME check, so a same-arity rename-list drift `(a, b) → (a, c)`
returns `null` and NO reshape fires. The backing keeps `(a, b)` while the
derivation records `(a, c)` → divergence.

Add an explicit-target reshape: when `positionalRename && allowReshape` and the
re-attach is over a maintained table whose current column NAMES differ from
`shape.columns` (same arity — count drift was already caught by
`describeAttachShapeMismatch`'s count check, which runs BEFORE the skipNames
guard, and throws the strict error via the existing gate), classify the delta
with the existing `classifyBackingReshape(table, shape)` and splice the resulting
plan exactly as the implicit reshape does. Because the shape carries the target
names, the classifier emits a pure positional RENAME (`b → c`); a reorder/swap
(`(a, b) → (b, a)`) classifies as a reorder → `inexpressibleReshapeError`
(table untouched); a PK column whose output name was renamed is NOT a key change
(`describePhysicalPkChange` compares through the rename map). The explicit reshape
is RENAME-ONLY by construction — any type/not-null/PK/interleave delta surfaces as
either the strict mismatch (count/type/PK) or an inexpressible reorder, never a
silent add/drop/retype.

Reuse, do not re-implement: the `reshapePlan` two-phase splice
(pre-reconcile/post-reconcile), `restorePrior` / `restoreReshaped` / the
post-commit mark-stale handlers, and the `table_modified` consumer-staleness
firing are all already present for the implicit path — the explicit path threads
the same `reshapePlan` variable.

### 2. Reshape-gate relaxation for explicit→implicit

Today the implicit reshape-on-attach gate (helpers.ts ~903) refuses a prior
EXPLICIT record (`priorImplicit` false) — a conservative stance taken *because
this ticket was pending*. Relax it so an IMPLICIT call (`!positionalRename &&
recordedColumns === undefined`) with `allowReshape` reshapes to follow the body
even over a prior-explicit record. This makes `alter table mv set maintained as
<body>` (the bare verb, or a differ-emitted re-attach of a now-implicit
declaration) abandon the authored list and follow the body's natural names —
the deliberate "go implicit" semantics. The explicit-target path (#1) is
unaffected: it is reached only when `columns` are present.

Distinguish the two cleanly: `columns` present → positional/explicit reshape to
the recorded names; `columns` absent → implicit reshape to the body's natural
names. Both are now permitted over a prior-explicit record.

### Arity guard

Ensure a rename-list whose arity disagrees with the body arity errors (e.g.
`set maintained (a, b, c) as select id, x` — 3 names, 2 body columns). The
CREATE path uses `assertDeclaredColumnArity` (helpers.ts ~359); the attach core
does NOT call it today. Add the equivalent guard on the explicit attach path so
a list/body arity mismatch raises a sited error rather than recording a
3-name derivation over a 2-column backing.

## Edge cases & interactions

- **Body-only change, list unchanged** (`(a, b) as select id, x` → `… id, x+1`):
  positional shape `(a, b)` matches the backing `(a, b)` → no reshape, plain
  verify-by-diff reconcile. Must apply where it errors today.
- **Rename-list change** `(a, b) → (a, c)`: backing renamed `b → c`, rows
  preserved (relabel, not rebuild), `derivation.columns === (a, c)`,
  `bodyHash` re-recorded. Re-running the same verb is a no-op (idempotent).
- **PK output-column rename** (`(id, x) → (key, x)` where `id`/`key` is the PK):
  allowed — `describePhysicalPkChange` matches through the rename map. Cover it.
- **Swap / cycle** `(a, b) → (b, a)`: `classifyBackingReshape` → reorder →
  `inexpressibleReshapeError`, table untouched. Assert the sited message.
- **Count drift** (`(a, b, c) as <3-col body>` on a 2-col table): strict
  count mismatch via `describeAttachShapeMismatch` → existing gate throws (the
  positional branch is `positionalRename → throw strict`). This is the
  arity-change-is-an-error contract.
- **List/body arity mismatch** (`(a, b, c) as <2-col body>`): the new arity
  guard errors.
- **Explicit → implicit** (`set maintained as <body>` over an `(a, b)` table):
  reshape-to-body, `derivation.columns → undefined`, backing relabeled to the
  body's natural names. Gate relaxation. Converges to an implicit record.
- **Failure restore on a mutated explicit reshape**: a pre-reconcile rename
  ran (module mutated) but a later gate/reconcile/constraint throws → the
  existing `restoreReshaped` (prior derivation rides the reshaped backing,
  marked stale) / post-eager-commit mark-stale applies unchanged. Confirm the
  explicit path routes through the same handlers (it shares `reshapePlan`).
- **insert defaults referencing a renamed/dropped column**: latent (the sibling
  ticket flagged it for the implicit path); the explicit rename can rename a
  referenced column. Out of scope to validate here, but note it does not crash —
  `runSetMaintained` records `insertDefaults` verbatim.
- **Store vs memory backing**: the explicit reshape rides the same
  `module.alterTable` rename ops and eager-commit discipline as the implicit
  reshape. Memory suite is authoritative for the ticket; `yarn test:store` is the
  out-of-band check for the store backing-host's committed-vs-pending validation
  (do NOT run it in-ticket — slow). Document the deferral if anything store-specific
  is uncertain.

## TODO

### Grammar + plumbing
- Parser: optional `(cols)` between `MAINTAINED` and `AS` in the SET MAINTAINED
  action; reject empty `()`.
- AST: `columns?` on the setMaintained action.
- ast-stringify: render `set maintained (a, c) as …` when columns present;
  byte-identical bare form otherwise.
- alter-table-node: action `columns?` + toString.
- building/alter-table: thread `columns` into the node action.

### Verb
- `runSetMaintained`: when `columns` present → `positionalRename = true`,
  `recordedColumns = columns`.
- `attachMaintainedDerivation`: explicit-target reshape (classify against the
  recorded-named shape, rename-only, reuse the two-phase splice + restore
  handlers); arity guard for list/body mismatch.
- Relax the implicit reshape gate to allow reshape-to-body over a prior-explicit
  record for an implicit call.

### Tests
- `maintained-table-attach-detach.spec.ts`: manual verb cases — rename-list
  change renames backing + preserves rows + records `(a, c)` + idempotent;
  body-only explicit re-attach applies; PK-column rename; swap → inexpressible
  error; count drift → strict error; list/body arity mismatch → error;
  explicit→implicit bare verb follows the body and records implicit.
- `51.7-maintained-table-attach-detach.sqllogic`: a new section exercising
  `set maintained (cols) as` success + the reorder/arity error pins.

### Docs
- `docs/materialized-views.md` SET MAINTAINED AS section: document the
  `(cols)` rename-list form, the positional rename + backing reshape, and the
  arity-error / reorder-error boundaries.

### Validate
- `yarn build`, `yarn lint`, and the memory suite (`node test-runner.mjs` in
  packages/quereus) green. Stream long output with `tee`. Defer `yarn test:store`.

## End
