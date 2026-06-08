description: Direct-vs-declarative schema equivalence harness — curated corpus (`test/declarative-equivalence.spec.ts`) plus `fast-check` property block in `test/property.spec.ts`, sharing a structural schema comparator (`test/util/schema-equivalence.ts`) that reuses the AST round-trip comparator landed by the prereq.
files:
  packages/quereus/test/declarative-equivalence.spec.ts
  packages/quereus/test/util/schema-equivalence.ts
  packages/quereus/test/property.spec.ts
  packages/quereus/test/emit-roundtrip-comparator.ts
  docs/architecture.md
  docs/schema.md
----

## What landed

- `test/util/schema-equivalence.ts` (460 lines) — three structural comparators (`assertTableSchemaEqual`, `assertViewSchemaEqual`, `assertAssertionSchemaEqual`) plus an `assertProbeEquivalent` runner that enforces a three-oracle invariant (direct DB / applied DB / author expectation). Expression compares delegate to `assertAstEquivalent` from the prereq, keeping the two surfaces locked together.
- `test/declarative-equivalence.spec.ts` (745 lines, 23 cases) — Mocha + chai driver. Each case carries `directDDL`, `declarativeBody`, optional `postSetup` and `expectTables/Views/Assertions`, and a `probes` list. The driver builds two fresh `Database`s in parallel (`create table …` vs `declare schema main { … } apply schema main`), applies symmetric data via `postSetup`, then runs catalog + probe equivalence. Self-tests prove the harness throws on each class of divergence (catalog diff, expectation mismatch, outcome-class mismatch).
- `test/property.spec.ts` § Declarative-schema equivalence (property) — `fast-check`-driven dragnet. Generates a 2–3 column shape (PK first, optional defaults, ≤ 1 CHECK), renders both canonical DDL + declarative body, asserts catalog equivalence + count probe. `numRuns: 50` default, `200` under `PROPERTY_LONG=1`.
- `docs/architecture.md` § Testing Strategy and `docs/schema.md` § Declarative Schema each gain a pointer.

## Validation

- `yarn workspace @quereus/quereus run lint` → exit 0, clean.
- `yarn workspace @quereus/quereus run test` → **3271 passing, 0 failing** (~1 min wall clock). The pre-existing `[property-planner] Rule '<id>' never fired` console warnings are unrelated to this change (they come from `test/property-planner.spec.ts:323` and existed before).

## Review findings

### Architecture / design

Read the implement diff in full before considering the handoff. The three-oracle structure (direct catalog + applied catalog + author expectation enforced by `assertProbeEquivalent`) is the right shape — a regression that lands identically in both pipelines still fails the test author's expectation. The Case-record shape composes cleanly: every field except `name` is optional in a sensible way (`expectTables`/`expectViews`/`expectAssertions` default to skipping that level; `postSetup` defaults to empty; `skipUntil` exists but is currently unused since all 23 rows pass). Decomposition of `assertTableSchemaEqual` into per-aspect sub-helpers (`assertColumnEqual`, `assertPkDefEqual`, `assertConstraintListEqual`, `assertFkListEqual`, `assertUniqueListEqual`, `assertIndexListEqual`, `assertIndexColsEqual`) tracks the schema's own shape — adding a new field touches one obvious place. Sharing `assertAstEquivalent` from the prereq for every expression compare (defaults, generated, check, partial-unique predicate, partial-index predicate, view body, assertion check) is the load-bearing design call — degrades in lock-step rather than diverging.

### DRY / scope

`deepEqualIgnoringZeroSign` is duplicated in `schema-equivalence.ts:439` and `property.spec.ts:28`. The implementer chose to promote a private copy into the helper rather than refactor `property.spec.ts` to import it — defensible (the property-spec copy predates this work and its other in-file users aren't part of this ticket), and the file header on `schema-equivalence.ts:434` notes the promotion. Minor — leave alone; a follow-up cleanup could centralize.

### Comparator correctness

- `eq()` (line 383) falls back to `safeJsonStringify(direct) === safeJsonStringify(applied)` for object equality. Key-insertion-order matters for that fallback, which would matter for raw object compares but the comparator routes complex objects through `eqRecord` (sorted keys), `eqArray`, or `eqExpr` (structural). The remaining `eq()` consumers are all primitives or short ID lists. Sound for the surface compared today.
- `assertFkListEqual` compares both `referencedColumns` (resolved indices) and `referencedColumnNames` (raw names) — correct: a regression where one path resolves at parse time and the other defers to enforcement would surface.
- `assertProbeEquivalent` runs the probe on `direct` then `applied` sequentially; each DB gets its own state, so stateful probes (INSERT/UPDATE/DELETE) accumulate symmetrically. Cross-DB outcome-class divergence (rows vs error) is checked before per-side row/error checks, so the failure message is informative.
- `runProbe` wraps non-`QuereusError` exceptions as `{ kind: 'error', error, status: undefined }`. Cross-DB compare on undefined-vs-undefined passes; an expectation `error: { status }` is enforced strictly. Sound.

### Test coverage (corpus quality)

The implementer's "honest gaps" section accurately disclosed every limitation I found in a separate sweep:

- **Decoration coverage:** one table-level `with tags` row only. The comparator walks tags at column / CHECK / FK / unique / index / table level, so adding rows is purely a corpus extension.
- **FK `on update` actions:** absent (only `on delete cascade` + `on delete restrict`).
- **Partial index `where` predicate:** comparator wired (`assertIndexListEqual` calls `eqExpr` on `predicate`) but no corpus row exercises it.
- **`committed.<table>` transition CHECK:** absent; the existing transition-constraint surface is covered separately by `test/logic/43-transition-constraints.sqllogic`.
- **Cross-table `not exists` assertion:** the one assertion row is single-table.
- **Property arbitrary breadth:** intentionally narrow (no FK / index / view branches) to converge fast.
- **Probe row comparator:** JSON-sort-based for unordered rows — fine for integers/short strings, weak for blobs.

None blocks merge — each was an explicit scope choice in the implement ticket, and the curated rows that ARE present cover the three named regression fingerprints (#21 view compound-select, #22 CHECK `not in` subquery, #23 CHECK `on delete` mask). I did not file separate tickets: these are corpus-widening opportunities a future plan-stage agent can pick up by reading this section. The harness is shaped to absorb new rows without further refactoring.

### Style nit observed but not fixed

The `RESERVED` set in `test/property.spec.ts:1523` is defined at file-bottom but referenced from inside a nested `describe` callback at line 1380. Works at runtime because the reference sits inside a `fc.filter` closure that fast-check only invokes when generating values (test-run phase, well after module evaluation). The order is jarring on read but the closure-deferral pattern is idiomatic; moving it would be cosmetic churn.

### Docs

`docs/architecture.md` § Testing Strategy and `docs/schema.md` § Declarative Schema both gained accurate pointers. Other declarative-schema references in `docs/sql.md`, `docs/usage.md`, `docs/plugins.md`, etc. are user-facing reference material and don't need a testing footnote — checked each and confirmed.

### Lint + tests

`yarn workspace @quereus/quereus run lint` exits 0 cleanly. `yarn workspace @quereus/quereus run test` reports **3271 passing, 0 failing, 0 pending** in ~1 minute. No `.skip`-ped rows in the new corpus (the `skipUntil` field on `Case` is unused on landing — all three fingerprint fixes had already landed per `git log` on this branch). `test:store` / `test:full` not run, per AGENTS.md (out of scope for review of test-only changes).

### Disposition

No new tickets filed; no inline changes made. Implementation is sound for the scope it claimed, gaps are honestly disclosed in the next-stage handoff, and the harness is structured to grow.
