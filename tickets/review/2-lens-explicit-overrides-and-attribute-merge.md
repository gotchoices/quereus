description: Review the lens authoring layer — `declare lens for X over Y { view T as <select> [hiding (...)] }` parser surface, explicit-basis binding, per-attribute sparse-override merger (covered ⊕ gap-fill ⊖ hidden), and the `quereus_effective_lens` TVF. Read-correct only; write-enforcement is the prover ticket's job.
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/lexer.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/block.ts, packages/quereus/src/planner/building/declare-schema.ts, packages/quereus/src/planner/nodes/declarative-schema.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/src/schema/declared-schema-manager.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/func/builtins/index.ts, packages/quereus/test/lens-overrides.spec.ts, packages/quereus/test/lens-foundation.spec.ts, packages/quereus/test/logic/52-lens-overrides.sqllogic, docs/lens.md, docs/schema.md, docs/optimizer.md
----

## What landed

The authoring half of the lens layer, on top of the foundation substrate (`Schema.kind`, lens slots, the name-based default mapper). All four phases of the implement ticket are done; build + full test suite + lint are green.

### Phase A — parser + statement plumbing
- **AST** (`ast.ts`): new `DeclareLensStmt` (`{ type:'declareLens'; logicalSchema; basisSchema; overrides: LensOverride[] }`) and `LensOverride` (`{ table; select: SelectStmt; hiding?: string[] }`); both added to the `Statement` union and the `AstNode.type` literal union.
- **Parser** (`parser.ts`): the `DECLARE` dispatch branches on the `LENS` contextual keyword → new `declareLensStatement` parses `for <X> over <Y> { ( view <T> as <select> [hiding (<cols>)] ;? )* }`. `lens`/`for`/`hiding` are contextual keywords (matched via `peekKeyword`'s IDENTIFIER fallback — **no lexer reservation was added**).
  - **Load-bearing parser fix:** `standardTableSource`'s bare-alias guard gained `!checkNext(1, LPAREN)`. Without it, `from Y.CarCore hiding (col)` swallows `hiding` as a table alias. The guard is independently correct (a base-table source parses no alias column-list, so `ident (` was never a valid alias anyway). **This is a general parser behavior change — worth a reviewer's eye** even though the full 3825-test suite is green.
- **Stringify** (`ast-stringify.ts`): `declareLens` case + `declareLensToString`. Round-trip is parse → `astToString` → reparse → equal AST + equal hash.
- **Plumbing**: `buildDeclareLensStmt` (`declare-schema.ts`), `DeclareLensNode` (`declarative-schema.ts`), `PlanNodeType.DeclareLens`, `block.ts` dispatch, `register.ts` emitter wiring.
- **Emit** (`schema-declarative.ts`): `emitDeclareLens` stores the block in `DeclaredSchemaManager` keyed by **logical schema name**, and enforces the **duplicate-`view T`-per-block** error.
- **Manager** (`declared-schema-manager.ts`): `setLensDeclaration` / `getLensDeclaration`; cleared on `removeDeclaredSchema`.

### Phase B — merger + apply wiring (`lens.ts`, `lens-compiler.ts`)
- `LensSlot` extended: `hiding?: ReadonlySet<string>`, `columnProvenance: LensColumnProvenance[]`, and `override` is now populated.
- `deployLogicalSchema`: looks up the lens block; **explicit `over Y` basis binding** (resolved lazily; `inferDefaultBasis` consulted *only* when no lens block is declared); threads overrides into compilation; validates overrides reference declared tables.
- `compileOverrideBody` implements the **D2 composition**: coverage read **by output-column name** (alias / bare name / `*`-expansion of FROM sources) ⊕ default-mapper **gap-fill** (resolved against the override's FROM) ⊖ **`hiding`**. Produces one effective `select` whose projection is exactly the logical columns (minus hidden), each aliased to its logical name; **all non-projection clauses of the override are preserved** (`{ ...select, columns }`).
- **Fidelity boundary errors** (not guesses): single-source hide-via-gap-fill trap, and partial cross-basis join with an unreachable gap. Full-coverage cross-basis joins are a gap-fill no-op (body used verbatim).

### Phase C — introspection + round-trip
- `quereus_effective_lens(schema, table)` integrated TVF (`explain.ts`, registered in `index.ts`): yields `(logical_column, source, effective_sql)` per logical column, `source ∈ {override, default, hidden}`. Errors on unknown/non-logical schema or missing slot.
- `computeSchemaHash` (`schema-hasher.ts`) widened to accept `DeclareLensStmt` — the lens block is **behavioral**, hashed on its canonical SQL.

### Phase D — docs
- `docs/lens.md`: override+merge flipped to **shipped (read) / pending (write enforcement)**; documents `hiding`, the v1 name-based-coverage + re-read-from-source reconciliation, the gap-fill fidelity boundary, the explicit-basis binding, and the TVF.
- `docs/schema.md`: new "Logical schemas and lenses" subsection with `declare lens` syntax.
- `docs/optimizer.md`: attribute-provenance cross-referenced as the *future* (prover) merge mechanism; v1 is name-based.

## Use cases / validation (test floor — extend, don't trust as ceiling)

Unit spec `test/lens-overrides.spec.ts` (14 cases) + sqllogic `test/logic/52-lens-overrides.sqllogic` (read-path) + the new explicit-basis case in `test/lens-foundation.spec.ts` cover every row of the ticket's shape table:

| Shape | Covered by |
|---|---|
| Rename (`speed as maxSpeed`) | unit + sqllogic §1 |
| Sparse rename + gap-fill (`color` from CarCore) | unit + sqllogic §1 |
| Rename + later-column-add compose (re-apply) | unit |
| Hide via `hiding (...)` (absent from `select *`, ref errors) | unit + sqllogic §2 |
| Hide-via-gap-fill **trap** (errors naming the column) | unit + sqllogic §5 |
| Compute (`first\|\|' '\|\|last`; read works, update rejected) | unit |
| Filter (`where active = 1`; reads filtered) | unit + sqllogic §3 |
| Cross-basis join, full coverage (verbatim) | unit + sqllogic §4 |
| Cross-basis join, partial unreachable gap (**errors**) | unit |
| Duplicate `view T` per block (**errors**) | unit |
| Explicit basis disambiguation (`over y` resolves 2-candidate) | foundation spec |
| `quereus_effective_lens` provenance + SQL | unit |
| DDL round-trip + lens-block-participates-in-hash | unit |

**Commands:**
- `yarn workspace @quereus/quereus build` — clean.
- `yarn workspace @quereus/quereus test` — **3825 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` — clean (exit 0).
- `yarn workspace @quereus/store build` — clean (parser/AST change doesn't break the store DDL generator; lens is a logical-layer construct, not persisted DDL).

## Honest gaps for the reviewer (treat tests as a floor)

1. **Write-enforcement is NOT wired (by design).** The slot's `attachedConstraints` are stored verbatim but not routed to enforcement. An MV/lens under this ticket is **read-correct, write-unsound** for logical-constraint enforcement — `lens-prover-and-constraint-attachment` closes this. Documented in `docs/lens.md`.
2. **Untested clause interactions in override bodies.** `group by` / `distinct` / `order by` / `limit` / `union`/`compound` are carried through via `{ ...select, columns }` but **not tested**. For a `union`/compound override, only the *top* select's projection is replaced — union arms are carried verbatim, which can be inconsistent. A `group by` whose grouping doesn't line up with the composed projection is also untested. Consider these unproven.
3. **`select *` + `hiding`, and multi-source `*`-expansion**, are implemented (star expands to explicit refs; hidden ones omitted; name-collisions across join sources are **first-source-wins**) but **not directly tested**. Single-source `*` (filter case) is tested; the join/collision paths are not.
4. **Gap-fill qualification heuristic** for joins qualifies by alias-or-table-name and picks the **first** source that has the column — no ambiguity detection. Adversarially untested.
5. **Computed override output column without an alias** is silently dropped from the effective body (can't map to a logical column by name).
6. **No cross-check that override FROM sources live in the `over Y` basis.** An override referencing `Z.Foo` (a different schema) resolves against `Z` if it exists; it is not validated against the declared basis. Could merit a warning.
7. **Lens declaration lifecycle**: the stored block lingers in `DeclaredSchemaManager` after a logical schema is emptied/dropped (cleared only by `removeDeclaredSchema`). Re-declaring replaces; the override-references-declared-table validation is skipped on an *empty* re-apply to preserve detach-all semantics — re-check that interaction.
8. **The `standardTableSource` LPAREN-guard** (Phase A) is a global parser change; full suite is green but it deserves a deliberate look.

## Out of scope (already ticketed — do not re-file)
Module mapping advertisements (`lens-module-mapping-advertisement`), n-way decomposition interior (`lens-multi-source-decomposition`), constraint attachment / write-enforcement (`lens-prover-and-constraint-attachment`), backfill DDL (`lens-re-decomposition-backfill-ddl`), `alter lens` (drop + re-declare for now).
