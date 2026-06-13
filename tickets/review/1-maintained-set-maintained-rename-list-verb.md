description: Review the `alter table … set maintained (cols) as <body>` verb — explicit rename-list grammar plus the attach-core behavior (explicit-target reshape, list/body arity guard, and the reshape-gate relaxation that lets a bare re-attach over a prior-explicit record "go implicit"). Independently exercised by manual SQL; the differ ticket (maintained-reattach-explicit-rename-list-reshape) consumes it.
prereq:
files:
  - packages/quereus/src/parser/parser.ts                            # parseMaintainedColumnList helper (~2643) + SET MAINTAINED (cols) parse (~3169)
  - packages/quereus/src/parser/ast.ts                               # setMaintained action: columns? (~717)
  - packages/quereus/src/emit/ast-stringify.ts                       # alterTable setMaintained renders (cols) when present (~1263)
  - packages/quereus/src/planner/nodes/alter-table-node.ts           # setMaintained action columns? (~115) + toString (~186)
  - packages/quereus/src/planner/building/alter-table.ts             # thread columns into the node (~205)
  - packages/quereus/src/runtime/emit/alter-table.ts                 # dispatch (~126) + runSetMaintained threads columns (~1326)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation gate rewrite + arity guard (~961-1010); docstring (~889)
  - packages/quereus/test/maintained-table-attach-detach.spec.ts     # new "explicit rename-list re-attach" block; rewrote test #607
  - packages/quereus/test/declarative-equivalence.spec.ts            # rewrote the sugar-MV rename-list "known limitation" test (~1407)
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic  # new section 12
  - docs/materialized-views.md                                       # SET MAINTAINED AS (cols), Reshape-on-attach, declarative-integration bullet
----

# Review: `set maintained (cols) as` — explicit rename-list re-attach + backing reshape

## What landed

Grammar `alter table X set maintained [(col, …)] as <body> [insert defaults (…)]`, plus the
attach-core behavior that gives the rename list meaning. The list is recorded as
`derivation.columns` (explicit), the body outputs are renamed positionally to it, and a
same-arity output-**name** drift relabels (renames) the backing in place — converging the
`apply schema` round-trip (the list travels as first-class grammar, recorded separately from
the body, so it round-trips through canonical DDL).

**Plumbing** (mechanical, low-risk): parser (extracted shared `parseMaintainedColumnList`),
AST `columns?`, `ast-stringify` renders `(cols)` only when present (byte-identical bare form
otherwise), plan-node action + `toString`, builder threads `columns`, runtime
`runSetMaintained` maps `columns` → `positionalRename`/`recordedColumns`.

**Attach core** (`attachMaintainedDerivation`, the real substance):
- **Explicit-target reshape** — when `positionalRename && allowReshape` and the derived
  (target-named) shape differs from the live backing only by NAME, classify via
  `classifyBackingReshape` and splice the existing two-phase reshape plan. The shape carries
  the target names, so the classifier emits a pure positional RENAME; a renamed PK output
  column is matched through the rename map (not a key change); a reorder/swap → inexpressible.
- **List/body arity guard** — `recordedColumns.length !== shape.columns.length` throws a sited
  error *before* anything is recorded (`deriveBackingShape` sizes to the body, silently
  dropping/padding extra names, so this would otherwise persist a miscounted record). Create is
  unaffected (it validates arity in `createMaintainedTable` before reaching the core).
- **Gate relaxation (BEHAVIOR CHANGE — scrutinize)** — a bare implicit `set maintained as`
  over a **prior-explicit** record no longer errors with the strict shape mismatch; it
  reshapes the backing to the body's natural names and records implicit ("go implicit").

## Use cases to validate (tests are a FLOOR — push on these)

Memory suite green (`node test-runner.mjs`: 6176 passing, 0 failing), `yarn build` + `yarn lint` clean.

Covered (`maintained-table-attach-detach.spec.ts` → "explicit rename-list re-attach"; `51.7` §12):
- rename-list change `(a,b)→(a,c)`, same body → backing renamed b→c, rows **relabeled not
  rebuilt** (zero dispatched changes), records `(a,c)`, **idempotent** on re-run, maintenance re-bound;
- body-only change with the list unchanged → plain reconcile, no reshape (the case that errors today);
- PK output-column rename `(id,x)→(keyid,x)` → allowed, PK follows the rename;
- swap `(a,b)→(b,a)` → inexpressible reorder, table untouched, prior bodyHash restored;
- count drift (3-col list+body over 2-col table) → strict shape error;
- list/body arity mismatch (3-name list, 2-col body) → sited arity error, nothing recorded;
- explicit→implicit bare verb (rewritten test #607) → goes implicit, columns clear.

Gaps the reviewer should consider adding / probing:
- **Explicit reshape combined with an attribute change.** A `(a,b)→(a,c)` rename where column
  `c`'s body type/collation/not-null ALSO differs from the live backing: should hit the **strict
  count/type/PK error** (the explicit path only reshapes a pure NAME drift; an attribute delta
  produces a real `describeAttachShapeMismatch`, which `positionalRename` routes to the strict
  throw). Not directly pinned — worth a test.
- **Explicit attach to a PLAIN table whose columns differ from the list.** Manual
  `set maintained (a,b) as` over `t(c,d)` renames c→a, d→b (consistent, but only the re-attach-over-maintained
  cases are pinned). Confirm the rename-to-plain-table path behaves.
- **`insert defaults` referencing a renamed/dropped column.** Latent (flagged for the implicit
  path by the sibling reshape ticket); the explicit rename can rename a referenced column.
  Out of scope here — `runSetMaintained` records `insertDefaults` verbatim and does not crash —
  but the reviewer may want a non-crash pin.
- **Store backing host.** `yarn test:store` was **deferred** (slow; ticket guidance). The
  explicit reshape rides the *same* `module.alterTable` rename ops + eager-commit discipline as
  the implicit reshape (which the store-parity ticket already covered), so risk is low — but the
  store path's committed-vs-pending validation under the explicit RENAME is **not** verified
  in-ticket. Run `yarn test:store` out-of-band (or let CI) before trusting the store backing.

## Risks / things to look hard at

- **The gate relaxation changed two existing tests** (not just additive):
  - `maintained-table-attach-detach.spec.ts` #607 — was "explicit never reshapes / strict error
    stands"; now asserts "bare verb goes implicit". This is the intended ticket semantics, but
    it is a real behavior change for `alter table <explicit-mv> set maintained as <different-shape>`.
  - `declarative-equivalence.spec.ts` (~1407) — was "rename-list change errors at apply (known
    limitation)"; now asserts apply **succeeds** by going implicit but **does not converge** in a
    single diff (the differ still emits implicit re-attaches). The explicit verb is applied
    manually in that test to demonstrate convergence. Verify this honestly reflects the design and
    that "applies-but-diverges until the differ ticket" is acceptable interim behavior (vs the
    prior hard error).
- **Differ NOT updated (by design).** `schema-differ.ts` still emits `setMaintained` *without*
  `columns` — that is the sibling ticket `maintained-reattach-explicit-rename-list-reshape`.
  Consequence: an explicit MV rename-list change applied via `apply schema` currently re-attaches
  IMPLICITLY (backing relabels to the body's natural names) and does not converge until that
  ticket lands. Documented in the updated `declarative-equivalence` test, `51.7`, and
  `docs/materialized-views.md` (SET MAINTAINED AS + declarative-integration bullet). Confirm the
  scoping is right and the docs are not over-promising convergence.
- **Pre-existing, outside the diff:** `runtime/emit/alter-table.ts` `rebuildViaShadowTable` has
  an unused `schema` param (hint-level only; `yarn lint` passes). Not touched.

## How to exercise manually

```sql
create table src (id integer primary key, x text not null, y text not null);
insert into src values (1,'a','A'),(2,'b','B');
create table mv (a integer primary key, b text not null) maintained (a, b) as select id, x from src;
alter table mv set maintained (a, c) as select id, x from src;   -- renames b→c, records (a,c), idempotent
alter table mv set maintained (c, a) as select id, x from src;   -- error: changed incompatibly (reorder)
alter table mv set maintained (a, c, d) as select id, x from src;-- error: rename list declares 3 ... body produces 2
alter table mv set maintained as select id, x from src;          -- "go implicit": backing → (id, x), columns cleared
```
