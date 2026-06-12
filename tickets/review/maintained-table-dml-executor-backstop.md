description: Review the engine-level READONLY backstop for maintained tables — emit-time guard in the runtime DML executor that rejects any mutation plan targeting a derivation-bearing table, plus the engine-owned "read-only to user DML" doc rewording and the aggregate-body-reject / direct-DML-after-detach test pins.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts                          # the guard: assertNotMaintainedTableTarget + call site at emitDmlExecutor head (~line 156)
  - packages/quereus/src/schema/derivation.ts                                  # maintainedTableViewLike now sets noun:'materialized view'
  - packages/quereus/src/planner/mutation/single-source.ts                     # MutableViewLike.noun; analyzeView body-shape reject uses it
  - packages/quereus/src/vtab/backing-host.ts                                  # header § Read-only to user DML — reworded to engine-owned
  - docs/materialized-views.md                                                 # backing-host bullet (~line 84) + § Write boundary backstop sentence
  - packages/quereus/test/mv-dml-executor-backstop.spec.ts                     # NEW — direct guard exercise (3 cases)
  - packages/quereus/test/logic/53.1-materialized-view-write-through.sqllogic  # § 11 aggregate-body DML reject pin
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic   # § 4 strengthened direct-DML-after-detach pin
----

# Review: maintained-table READONLY backstop at the DML executor

Successor to the implement ticket of the same slug. The unified maintained-table
model made user DML naming a maintained table **write-through by design** (plan-time
dispatch routes it to the body's base source). This ticket added the
**defense-in-depth second net** the plan ticket asked for: an engine-level READONLY
backstop in the runtime DML executor that rejects any mutation plan whose target
still carries a `derivation`, plus doc and test alignment. All design decisions were
settled in the source ticket (engine-level seam, structural keying on
`isMaintainedTable`, **no** per-module guards) — those are not re-litigated here.

## What landed

1. **The guard** (`runtime/emit/dml-executor.ts`). New exported
   `assertNotMaintainedTableTarget(tableSchema)` throws `QuereusError` /
   `StatusCode.READONLY` with a schema-qualified message naming the table when
   `isMaintainedTable(tableSchema)`. Called once, at the head of `emitDmlExecutor`
   (right after `const tableSchema = plan.table.tableSchema;`). Emit-time, not
   per-row → zero runtime cost; re-checked on every re-plan because attach/detach
   invalidate the `'table'` statement-cache dependency.

2. **Diagnostic wording** (the "minor, in scope" item). A maintained table reaching
   an unsupported-body reject (e.g. an aggregate-bodied MV) was misnamed a "view".
   Added an optional `noun` to `MutableViewLike` (default `'view'`), set to
   `'materialized view'` by `maintainedTableViewLike`, and consumed at the **one**
   `analyzeView` body-shape rejection site. So the aggregate-body reject now reads
   `cannot write through materialized view 'wcount': …`.

3. **Docs** reworded from the stale module-owed "a backing table must reject user
   DML" to the engine-owned story (planner write-through + executor backstop +
   privileged-surface bypass + embedder responsibility) in both
   `vtab/backing-host.ts` header and `docs/materialized-views.md` (backing-host
   bullet + a new § Write boundary sentence naming the backstop).

4. **Tests** — see Validation below.

## Validation performed (all green)

- `yarn lint`, `yarn typecheck`, `yarn build` (full monorepo) — clean.
- `yarn test` (memory): **5925 passing**, 0 failing.
- `yarn test:store` (LevelDB store): **5921 passing**, 0 failing.
- `@quereus/store` pkg (543) and `@quereus/isolation` pkg (126) — clean (the
  packages most likely to exercise privileged backing-host writes; confirms the
  guard does not interfere with them).
- The two touched logic files pass in **both** memory and store suites.

## Test surface the reviewer should weigh (your tests are a FLOOR)

- **`mv-dml-executor-backstop.spec.ts`** — exercises the exported guard directly:
  (a) a real derivation-bearing schema (`create materialized view`) → READONLY
  naming `main.mv`; (b) a plain table → no throw; (c) after
  `alter table … drop maintained` the same name no longer throws (proves
  **structural keying**, not name-based). This is the honest pin because the
  backstop is **deliberately unreachable from SQL on the supported path** — any
  SQL that reached it would itself be the planner bug the backstop guards. The
  reviewer cannot force it end-to-end via SQL without injecting a mis-dispatch.
- **53.1 § 11** — aggregate-bodied MV (`select w, count(*) … group by w`,
  creatable via the residual-recompute arm) rejects INSERT/UPDATE/DELETE at plan
  time; pinned on `cannot write through materialized view` (case-insensitive
  matcher, so it also verifies the noun fix). Source stays writable + maintained;
  the rejected writes change nothing. Sugar form chosen so it runs under both
  suites (no declared-shape collation strictness; `'x'/'y'` group keys carry no
  NOCASE/BINARY collision).
- **51.7 § 4** — direct INSERT/UPDATE/DELETE after `drop maintained` succeed and
  stay local (no write-through, no backstop). The added DML on `id=7` nets to zero
  (insert→update→delete) so the downstream re-attach reconcile expectation is
  preserved — verify that invariant if you touch § 4.

## Known gaps / judgment calls to scrutinize

- **Noun scope is deliberately narrow.** Only the `analyzeView` body-shape reject
  consults `noun`. Other MV mutation diagnostics still use generic "view" framing
  or their own wording: predicate-contradiction (`insert into view 'x' …`),
  no-inverse, and the MV-over-MV `reads a materialized view` reject — all already
  pinned in 53.1. I did **not** broaden the rename to every diagnostic (it would
  churn pinned messages for cosmetic consistency). If the reviewer wants every
  MV-facing diagnostic to say "materialized view", that's a follow-up, not a
  regression — call it out.
- **Other `analyzeView` reject branches left on the default noun.** The
  `view '…' has a <type> body` / `body did not produce a relation` /
  single-base-source branches still say "view". For a maintained table those are
  structurally unreachable (an MV body is always a single-source `select`), so I
  did not thread `noun` through them. Worth a glance to confirm that reasoning.
- **Completeness of the funnel.** The backstop is "complete" only if every
  runtime storage write goes through `emitDmlExecutor`. I verified all
  `vtab.update!()` call sites under `src/runtime/` live in `dml-executor.ts`, and
  the privileged surface (`applyMaintenance`/`replaceContents`/`trustedWrite`)
  writes via *other* methods (bypassing the guard by construction — intended).
  Re-verify this funnel claim if you are skeptical; it is the load-bearing
  assumption behind "one call site is sufficient".
- **No end-to-end forcing test.** By design there is none (see above). If the
  reviewer wants belt-and-suspenders coverage, a white-box test could hand-build a
  `DmlExecutorNode` over a maintained `TableReferenceNode` and assert
  `emitDmlExecutor` throws — but that duplicates what the exported-guard spec
  already pins with far less plumbing.

## Out of scope (unchanged by design — do not expect changes here)

- No per-module guards (rejected in the source ticket: module schemas are
  derivation-less, attach/detach are catalog-only flips). The memory module's
  `isReadOnly` ("fully immutable") flag is untouched and unrelated.
- Nested-MV writes (view-over-MV / MV-over-MV) remain rejected at plan time in
  `single-source.ts` — not duplicated by the backstop.
- Declared-constraint semantics on maintained tables stay
  `maintained-table-declared-constraint-semantics` (backlog).
