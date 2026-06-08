description: Review the ALTER "no silent divergence" conformance matrix — a (module × ALTER arm) suite asserting every module either honors an arm (with a post-ALTER read-back proving it took effect) or throws a sited `UNSUPPORTED` / `CONSTRAINT` / `MISMATCH`, never silently no-ops. Three legs (memory + no-`alterTable` stub in quereus; store in quereus-store; isolation-wrapped memory in quereus-isolation). The `ModuleCapabilities` flag demotion was already satisfied by the prereq.
prereq: module-capability-negotiation-doc
files: packages/quereus/test/alter-table-conformance.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus-isolation/test/alter-table-conformance.spec.ts, packages/quereus/src/vtab/capabilities.ts, packages/quereus/src/runtime/emit/alter-table.ts, packages/quereus/src/runtime/emit/add-constraint.ts, packages/quereus-store/src/common/store-module.ts, tickets/fix/isolation-runtime-constraint-propagation.md
----

## What landed

A "no silent divergence" conformance matrix that drives every `alterTable` arm
through real `ALTER TABLE` SQL on a populated table and asserts the outcome is
exactly one of:
- **honored** — the ALTER applies AND a post-ALTER read-back (`table_info` probe or
  a behavioral probe — forward-enforcement insert) proves the change is in force, OR
- **clean reject** — a `QuereusError` whose `code` is the arm's declared code
  (`UNSUPPORTED`, or data-dependent `CONSTRAINT` / `MISMATCH`) with a non-empty,
  sited message.

The forbidden third outcome — "succeeded but nothing changed" — is caught by running
the honored arm's read-back AFTER a non-throwing ALTER. A test that only asserted
"did not throw" would mask divergence; these don't.

**Split across three packages, by necessity.** `@quereus/quereus` cannot depend on
`@quereus/store` / `@quereus/isolation` (they depend on it), and the quereus leg
imports the engine from **source** (`../src/`) while the store/isolation legs import
the **built** `@quereus/quereus` package — so a single shared harness module cannot
serve all three (it would force an `instanceof`/identity split between source and
dist copies). Each leg therefore carries its own compact copy of the harness shape.
This is the honest architecture for the dependency graph, not laziness; the original
ticket's "memory + isolation in quereus" assumption is not reachable.

| Leg | File | Coverage |
| --- | --- | --- |
| memory + no-`alterTable` stub | `packages/quereus/test/alter-table-conformance.spec.ts` | full 17-arm matrix over memory; routed arms over a stub module asserting sited `UNSUPPORTED`; RENAME COLUMN schema-only fallback |
| store (in-memory KV provider) | `packages/quereus-store/test/alter-table-conformance.spec.ts` | full 17-arm matrix over store; PK-collation cell skipped (`store-pk-collate-module-capability`) |
| isolation-wrapped memory | `packages/quereus-isolation/test/alter-table-conformance.spec.ts` | 12-arm forwarding-parity matrix; 3 constraint/collation arms skipped (`isolation-runtime-constraint-propagation`); 3 staged-overlay-transaction cases |

## Validation (all green)

```
# memory leg (32 passing)
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/alter-table-conformance.spec.ts" --reporter spec
# store leg (17 passing, 1 pending = PK-collation xfail)
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/alter-table-conformance.spec.ts" --reporter spec
# isolation leg (15 passing, 3 pending = isolation gap arms)
node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-isolation/test/alter-table-conformance.spec.ts" --reporter spec
```

- `yarn test` (all workspaces, memory-backed): **EXIT 0** — quereus 5367 passing, store
  364 passing/1 pending, isolation 123 passing/3 pending, no failures introduced.
- `yarn workspace @quereus/quereus run lint`: **EXIT 0**.
- `tsc --noEmit -p packages/quereus-store/tsconfig.test.json` and the isolation
  equivalent: **EXIT 0** (the store/isolation packages have no lint script and run
  tests transpile-only, so these were run explicitly to catch type errors).

## Findings surfaced by the matrix (read these — they are the point of the suite)

1. **The audit-matrix "store clean-rejects ADD CHECK with `UNSUPPORTED`" cell is wrong
   vs. current code.** `ALTER TABLE … ADD CONSTRAINT … CHECK` is handled entirely
   engine-side (`runtime/emit/add-constraint.ts` `runAddCheck`) and never reaches
   `module.alterTable`, so it is honored in-session for **both** memory and store.
   The store's `addConstraint` `UNSUPPORTED` branch (`store-module.ts:947`) is dead
   for CHECK — it is reachable only by a constraint type that routes to the module
   and that the store does not handle (today: none beyond UNIQUE/FK). The matrix
   asserts honored for both legs; the discrepancy is documented inline in each spec
   header. NOTE (not asserted here, worth a reviewer's eye): the engine-side CHECK add
   bypasses the store's persistence path, so an added CHECK is enforced in-session but
   may not survive reconnect for store tables — a persistence concern, separate from
   the in-session contract this suite covers.

2. **Three real isolation-layer divergences** (filed as `tickets/fix/isolation-runtime-constraint-propagation.md`):
   the isolated table builds its UNIQUE merged-view enforcement from the schema at
   connect and does not refresh it after `alterTable`. Runtime `ADD UNIQUE` enforces
   with `INTERNAL` ("isolation-layer invariant violation") instead of `CONSTRAINT`;
   `DROP UNIQUE` updates the catalog (`unique_constraint_info` empty) but **keeps
   enforcing** (a genuine silent divergence); `SET COLLATE` on a UNIQUE column hits the
   same INTERNAL path. CREATE-declared UNIQUE is unaffected. These three cells are
   `it.skip` with the desired-contract assertions ready; un-skip when the fix lands.

3. **`renameColumn` against a no-`alterTable` stub is honored, not `UNSUPPORTED`** —
   the engine documents a degrade-to-schema-only-rename fallback (`vtab/module.ts`),
   covered by a dedicated test asserting that documented behavior.

## Notes / known gaps (treat the tests as a floor)

- **Flag demotion already done by the prereq.** `module-capability-negotiation-doc`
  already annotated the five advisory flags (`isolation`, `savepoints`, `persistent`,
  `secondaryIndexes`, `rangeScans`) as "not engine-consulted" and documented
  `delegatesNotNullBackfill` / `permitsGrandfatheredCheckViolators` as the live gates
  in `capabilities.ts` (lines 8–77). No source change was needed for this ticket; it
  is **purely additive test code** + two parked tickets — regression risk is minimal.
- **PK-collation store cell** is a single `it.skip` referencing
  `store-pk-collate-module-capability`; when that lands it flips on (honored-re-key OR
  clean `UNSUPPORTED`). It was deliberately NOT asserted here.
- **Cross-connection overlay poison** (`isolation-module.ts` foreign-overlay path) is
  NOT exercised — it needs two concurrent connections; the isolation leg covers only
  the single-connection issuer-own pre-validation path (staged-overlay tests). A
  reviewer wanting full coverage could add a two-connection case.
- **The store leg uses the in-memory KV provider** (fast `yarn test` lane); the
  LevelDB path is exercised only by `yarn test:store`, not here.
- Each leg's harness is duplicated (see "Split" above); a reviewer who dislikes the
  duplication should weigh it against introducing a quereus→isolation/store circular
  dev-dependency, which is the only way to centralize it.

## Suggested review focus

- Are the read-back probes actually sufficient to detect a silent no-op for each
  honored arm? (e.g. `SET DEFAULT` confirms via a fresh insert; `dropConstraint`
  confirms via a now-permitted duplicate — both behavioral, not schema-only.)
- Are the reject-site regexes (`/req|not null/i`, `/v|convert/i`, etc.) too loose?
- Is parking the three isolation cells as skips (vs. fixing the layer now) the right
  scope call, given the ticket's "small, pattern-establishing, not ocean-boiling"
  framing?
