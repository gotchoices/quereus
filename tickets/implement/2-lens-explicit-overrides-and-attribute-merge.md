description: Lens layer — `declare lens for X over Y { view T as <select> [hiding (...)] }` parser surface, the explicit-basis binding, and the per-attribute sparse-override merger. Overrides are re-read from source on every deploy (so they survive baseline regeneration); the merger composes override-covered columns ⊕ default-mapper gap-fill into one effective view body. Plus the `quereus_effective_lens` introspection TVF and DDL round-trip. Read-correct only — write-enforcement of attached constraints stays in the prover ticket.
prereq: lens-foundation-and-default-mapper
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/block.ts, packages/quereus/src/planner/building/declare-schema.ts, packages/quereus/src/planner/nodes/declarative-schema.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/func/registration.ts, packages/quereus/test/lens-foundation.spec.ts, docs/lens.md, docs/schema.md, docs/optimizer.md
----

## Scope

Lights up the **authoring** half of the lens layer on top of the foundation substrate (`Schema.kind`, lens slots, the single-source name-based default mapper — all landed by `lens-foundation-and-default-mapper`, now in `complete/`):

- the `declare lens for X over Y { ... }` statement (parse + store + apply + round-trip),
- the explicit-basis binding (`over Y` drives the basis, replacing `inferDefaultBasis`),
- the per-attribute sparse-override merger (override-covered columns ⊕ default-mapper gap-fill → one effective body),
- the `quereus_effective_lens(schema, table)` introspection TVF.

Out of scope (each already has a ticket — do **not** re-file): module-level mapping advertisements (`lens-module-mapping-advertisement`), the generated n-way join interior (`lens-multi-source-decomposition`), constraint attachment / write-enforcement (`lens-prover-and-constraint-attachment`), engine-emitted backfill DDL (`lens-re-decomposition-backfill-ddl`), `alter lens` (drop + re-declare for now).

**Honest gap for the reviewer:** this ticket compiles the effective *read* body and stores the logical spec's constraints verbatim in the slot's `attachedConstraints` (already done by the foundation). It does **not** route them to enforcement — an MV/lens under this ticket is *read-correct, write-unsound* for logical-constraint enforcement. `lens-prover-and-constraint-attachment` closes that gap. Document the limitation in `docs/lens.md` (flip override+merge to "shipped — read; pending — write enforcement").

## Grounding — the actual code surface (verified)

The foundation landed an **AST-only** compiler. `deployLogicalSchema` / `compileDefaultBody` in `src/schema/lens-compiler.ts` operate purely on ASTs and never invoke the planner: `compileDefaultBody` returns an `AST.SelectStmt` that is stored both as the slot's `compiledBody` and as a registered `ViewSchema` (`selectAst` + an explicit `columns` list pinned to logical names). Reads ride the standard view path; writes ride view-updateability. There is **no plan-tree / attribute-provenance machinery in the lens compiler today.**

Confirmed integration points:

- **Parser dispatch** — `declare` currently routes only to `declareSchemaStatement` (`parser.ts`), which handles the optional `logical` contextual keyword then `consumeKeyword('SCHEMA', ...)`. `declare lens …` is a **sibling** statement: after `DECLARE`, peek for the `LENS` keyword and branch to a new `declareLensStatement`. It is *not* a `declare schema` variant.
- **AST** — `DeclareSchemaStmt` and the `DeclareItem` union live in `ast.ts` (`Statement` union ~line 590). A new `DeclareLensStmt` joins the `Statement` union.
- **Stringify** — `astToString` switch in `ast-stringify.ts` dispatches by `node.type` (`declareSchema` → `declareSchemaToString`). Add a `declareLens` case + `declareLensToString`. **Round-trip is parse → `astToString` → reparse → equal AST/hash** (the foundation's pattern; see `test/lens-foundation.spec.ts` "DDL round-trip" and `test/emit/ast-stringify.spec.ts` "DECLARE SCHEMA items"). There is no separate `ddl-generator.ts` for this — `ast-stringify.ts` is the round-trip surface.
- **Build → node → emit** — `block.ts` maps `declareSchema`→`buildDeclareSchemaStmt`→`DeclareSchemaNode`; emit (`runtime/emit/schema-declarative.ts` `emitDeclareSchema`) stores the AST in `db.declaredSchemaManager`. Mirror this: `declareLens`→`buildDeclareLensStmt`→`DeclareLensNode`→an emit that stores the lens block in a manager.
- **Apply path** — `emitApplySchema` (`schema-declarative.ts`) calls `deployLogicalSchema(db, declaredSchema, schemaName)` when `declaredSchema.isLogical`. The lens block must be looked up here (or inside `deployLogicalSchema`) and threaded in.
- **Slot** — `LensSlot.override?: AST.SelectStmt` (`schema/lens.ts`) already exists, "always undefined until the override ticket." This ticket populates it. Add the `hiding` set to the slot.
- **TVF** — `createIntegratedTableValuedFunction` (`func/registration.ts`); `query_plan` (`func/builtins/explain.ts`) and `function_info` (`func/builtins/schema.ts`) are the templates (declare a `returnType` RelationType with `columns`, `isIntegrated: true`, an `async function*` that yields rows, `db` as first arg).

## Key design decisions (resolve these first — they shape everything)

### D1 — Where the lens block is stored and re-applied

A `declare lens for X over Y { ... }` block carries (a) the explicit basis binding and (b) the per-table overrides. It must survive to `apply schema X` and be re-emittable for round-trip. Store it keyed by **logical schema name** — either extend `DeclaredSchemaManager` with a parallel `Map<string, DeclareLensStmt>` (`setLensDeclaration` / `getLensDeclaration`), or add a small `LensDeclarationManager`. Prefer extending `DeclaredSchemaManager` for symmetry with `declaredSchemas`.

Re-declare semantics: a `declare lens for X …` **replaces** any prior block for X (matches `declare schema`'s overwrite-on-redeclare). The resolved-question "re-declaration is an error" is enforced at the **per-table** grain: two `view T as` for the *same* logical table T (within a block) is a build-time error. One lens block per logical schema; the `over Y` of the active block is the basis.

### D2 — Merge fidelity: AST-level composition for v1, not plan-tree provenance

The doc (`docs/lens.md` § Sparse Overrides) describes the merge "on the plan tree … addressed by stable attribute ID." The foundation compiler is **AST-only** and pulling the planner into the lens compiler is a large new dependency that the **prover ticket already needs** (it plans the body to read FD/key surface). For v1, do the composition at the **AST level** and reconcile the "stable attribute ID" property as follows:

- **Coverage** (which logical columns the override covers) is read from the override `select`'s **output column names** — the alias (`speed as maxSpeed`) or bare name. An output name matching a logical column (case-insensitive) *covers* that column.
- **Survival across baseline regeneration** is delivered not by attribute-ID plumbing but by **re-reading the override AST from source on every deploy** (the doc itself: "the compiled effective body is regenerated on every catalog load"). Rename-then-add composes because the stored override is untouched and the new logical column is simply uncovered → gap-filled. State this reconciliation in `docs/lens.md`; flag it for the reviewer as the load-bearing simplification.

**Composition algorithm**, per logical table T (in `lens-compiler.ts`):
1. If no override for T → existing `compileDefaultBody` path, unchanged.
2. If override present → parse already done (stored AST). Read its output column names = the **covered** set.
3. For each logical column of T, in declaration order:
   - covered by override → take the override's output expression for it;
   - else listed in `hiding (...)` → **omit** (not in effective body, not in the view's column list);
   - else → **gap-fill**: generate the column ref via the default single-source mapper (basis table named like T, basis column named like the logical column). If the mapper cannot back it (no such basis column) → **error**, naming the column as uncovered (the "hide-via-gap-fill trap").
4. Compose one effective `AST.SelectStmt`: the override's `from` (and `where`, for the filter shape) carried through, projection = covered ⊕ gap-filled columns in logical order, minus hidden.
5. Store the composed body as `slot.compiledBody` and register the `ViewSchema` (column list = logical columns minus hidden).

**Fidelity boundary (error, don't guess):** when an override is a **cross-basis join that covers only some columns** and an uncovered column is *not reachable from the override's `from`* (it would need a different basis source the v1 single-source mapper can't join in), error and report — do not silently emit an unsound body. Full-coverage cross-basis joins are fine (gap-fill is a no-op; body used verbatim). Document this boundary; the genuinely-structural case is `lens-multi-source-decomposition`'s concern.

### D3 — `hiding` clause semantics

Syntax: `view T as <select> hiding (col1, col2)`. A hidden column is **omitted** from the effective body's projection *and* from the registered view's column list — so `select * from X.T` does not surface it and `X.T.<hidden>` resolves to unknown column. (Rejected alternative: keep it in the column list projecting NULL — messier and the logical spec still lists it for the prover.) Bikeshed-safe rename window: `omit (...)` / `exclude (...)` — pick `hiding`, note alternatives in the doc. The logical spec still declares the column (the prover ticket decides what an attached constraint over a hidden column means).

### D4 — Explicit basis binding resolves `inferDefaultBasis` ambiguity

`over Y` supplies the basis explicitly. When a lens block exists for X, its `over Y` is used and `inferDefaultBasis` is **not** consulted. This makes the foundation's "2 candidates" ambiguity resolvable: `test/lens-foundation.spec.ts` currently asserts `apply schema x` throws `/found 2 candidates.*declare lens for x over/i` when two physical bases exist — with this ticket, declaring `declare lens for x over y` first must make that `apply` succeed against `y`. Update/extend that test accordingly (keep the no-lens ambiguity error for the case where no lens block was declared).

## Override shapes the merger must handle

| Shape | Override | Merge behavior |
|---|---|---|
| Rename | `select id, speed as maxSpeed from Y.T` | `maxSpeed` covers logical `maxSpeed`; other cols gap-filled from same source. |
| Hide (gap-fill) | uncovered col the basis *can* back | gap-filled normally (the common sparse case). |
| Hide (suppress) | `... hiding (maxSpeed)` | omitted from body + view column list. |
| Hide (trap) | `select id from Y.T`, T has `name`, basis lacks `name` | **error** naming `name` uncovered. |
| Compute | `select id, first||' '||last as full_name, first, last from Y.U` | computed expr covers `full_name`; read-only (writes rejected by existing view-updateability). |
| Filter | `select * from Y.U where active = true` | `where` carried into effective body; read-time only (inserts not auto-restricted — existing view-update rules). |
| Cross-basis join (full) | `select c.id, c.name, k.email from Y.Core c join Y.Contact k using (id)` | all columns covered; body used verbatim; gap-fill no-op. |
| Cross-basis join (partial, unreachable gap) | covers some; uncovered col needs another source | **error** (D2 fidelity boundary). |

## `quereus_effective_lens(schema, table)` TVF

Integrated TVF (template: `query_plan` in `func/builtins/explain.ts`). Resolve the lens slot for `(schema, table)`, stringify `slot.compiledBody` via `astToString`, and emit per-attribute provenance. v1 return shape (finalize column set in implement):

| column | type | meaning |
|---|---|---|
| `logical_column` | text | logical column name (in declaration order) |
| `source` | text | `'override'` \| `'default'` \| `'hidden'` |
| `effective_sql` | text | the composed body SQL (same on every row, or a single summary row — pick one; prefer repeating for symmetry with `query_plan`) |

Register alongside the other builtins (wire into the function-registration path used by `explain.ts`). Erroring on an unknown `(schema, table)` or a non-logical schema is fine.

## Key tests (TDD — `test/logic/*.sqllogic` + unit specs)

- **Rename override** — `view Car as select id, speed as maxSpeed from Y.CarCore` over logical `Car(id, maxSpeed)`: effective body binds `maxSpeed`→`CarCore.speed`; `select * from X.Car` surfaces `id, maxSpeed`.
- **Sparse rename + gap-fill** — `Car(id, maxSpeed, color)`, override covers `id, maxSpeed`; `color` gap-filled from `CarCore`. `select color from X.Car` works.
- **Hide trap** — `select id from Y.CarCore`, logical has `name`, basis lacks `name` → compile error names `name`.
- **Hide via `hiding`** — `view Car as select id, name from Y.CarCore hiding (maxSpeed)`: compiles; `maxSpeed` absent from `select *`; referencing it errors.
- **Compute** — `full_name` computed; `select full_name` works; `update X.U set full_name=...` rejected by view-updateability.
- **Filter** — `where active = true`: reads filtered; insert not auto-restricted.
- **Cross-basis join (full)** — multi-table override, all covered; effective body equals authored body; gap-fill no-op.
- **Cross-basis join (partial, unreachable)** — errors with a clear message.
- **Sparse override + later logical column add** — declare with override covering some cols; add a new logical column; re-`apply`; new column gap-filled, override untouched (the "rename + add compose" example from `docs/lens.md`).
- **Explicit basis disambiguation** — two physical bases present; `declare lens for x over y` then `apply schema x` succeeds against `y`; without the lens block the foundation's 2-candidate error still fires.
- **`quereus_effective_lens`** — returns composed SQL + per-attribute `source` for a chosen logical table.
- **DDL round-trip** — `declare lens …` → `astToString` → reparse → equal AST (and equal schema hash if the lens block participates in hashing — decide: lens overrides are behavioral, so likely yes).

## Validation

- `yarn workspace @quereus/quereus build` then `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lens-test.log; tail -n 80 /tmp/lens-test.log` (stream, never silent-redirect).
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).
- Do not run `test:store` / `test:full` (slow; not relevant to compile-time lens work).

## TODO (implement)

Phase A — parser + statement plumbing
- `DeclareLensStmt` AST: `{ type: 'declareLens'; logicalSchema; basisSchema; overrides: LensOverride[] }`, where `LensOverride = { table: string; select: SelectStmt; hiding?: string[] }`. Add to the `Statement` union.
- `declareLensStatement` in `parser.ts`: branch from `DECLARE` on the `LENS` keyword; parse `for <ident> over <ident> { (view <ident> as <select> [hiding (<ident-list>)] ;? )* }`.
- `declareLensToString` + `astToString` `declareLens` case; round-trip test.
- `block.ts` → `buildDeclareLensStmt`; `DeclareLensNode` in `declarative-schema.ts`; `emitDeclareLens` stores the block via the D1 manager.
- Duplicate-`view T as`-per-table build error.

Phase B — merger + apply wiring
- Extend `LensSlot` with the `hiding` set; populate `override`.
- `deployLogicalSchema`: look up the lens block for the schema (D1); use `over Y` as basis (D4, skip `inferDefaultBasis` when bound); thread overrides into compilation.
- Implement the D2 composition algorithm in `lens-compiler.ts` (covered ⊕ gap-fill ⊖ hidden → effective `AST.SelectStmt`); handle each shape table row; error on the fidelity boundary and the hide trap.
- Update `test/lens-foundation.spec.ts` for the explicit-basis case.

Phase C — introspection + round-trip
- `quereus_effective_lens(schema, table)` TVF (template: `query_plan`); register it.
- DDL round-trip of `declare lens …` (Phase A's stringify) verified end-to-end; decide lens-block participation in `schema-hasher.ts` (recommend: yes, behavioral).

Phase D — docs + test corpus
- `docs/lens.md`: flip override+merge to "shipped — read; pending — write enforcement"; document `hiding`, the D2 fidelity boundary + the name-based-coverage / re-read-from-source reconciliation, the explicit-basis binding, and the `quereus_effective_lens` TVF.
- `docs/schema.md`: add `declare lens` syntax. `docs/optimizer.md`: cross-ref attribute-provenance as the *future* (prover) merge mechanism, noting v1 is name-based.
- Full test corpus per "Key tests".
