description: ALTER "no silent divergence" conformance matrix — a (module × ALTER arm) suite asserting every module either honors an arm (with a post-ALTER read-back proving it took effect) or throws a sited `UNSUPPORTED` / `CONSTRAINT` / `MISMATCH`, never silently no-ops. Three legs (memory + no-`alterTable` stub in quereus; store in quereus-store; isolation-wrapped memory in quereus-isolation). Reviewed and completed.
files: packages/quereus/test/alter-table-conformance.spec.ts, packages/quereus-store/test/alter-table-conformance.spec.ts, packages/quereus-isolation/test/alter-table-conformance.spec.ts, packages/quereus/src/runtime/emit/add-constraint.ts, packages/quereus-store/src/common/store-module.ts, docs/module-authoring.md, tickets/fix/isolation-runtime-constraint-propagation.md
----

## What landed

A "no silent divergence" conformance matrix that drives every `alterTable` arm
through real `ALTER TABLE` SQL on a populated table and asserts the outcome is
exactly one of **honored** (ALTER applies AND a post-ALTER read-back — `table_info`
probe or a behavioral forward-enforcement probe — proves the change is in force)
or **clean reject** (a `QuereusError` whose `code` is the arm's declared code with a
non-empty, sited message). The forbidden third outcome — "succeeded but nothing
changed" — is caught by running the honored arm's read-back AFTER a non-throwing ALTER.

Split across three packages by dependency-graph necessity (`@quereus/quereus` cannot
depend on store/isolation; the quereus leg imports the engine from source while the
store/isolation legs import the built package). Each leg carries its own compact copy
of the harness shape.

| Leg | File | Coverage |
| --- | --- | --- |
| memory + no-`alterTable` stub | `packages/quereus/test/alter-table-conformance.spec.ts` | 32 passing — full matrix over memory; routed arms over a stub module asserting sited `UNSUPPORTED`; RENAME COLUMN schema-only fallback |
| store (in-memory KV provider) | `packages/quereus-store/test/alter-table-conformance.spec.ts` | 17 passing, 1 pending (PK-collation, `store-pk-collate-module-capability`) |
| isolation-wrapped memory | `packages/quereus-isolation/test/alter-table-conformance.spec.ts` | 15 passing, 3 pending (`isolation-runtime-constraint-propagation`) + staged-overlay cases |

The `ModuleCapabilities` flag demotion was already satisfied by the prereq
(`module-capability-negotiation-doc`); this ticket is purely additive test code plus
one parked fix ticket. No engine source changed.

## Review findings

Read the implement diff (`git show 656c590f`) with fresh eyes before the handoff, ran
all three legs, traced every cited claim into source. The suite is sound; one minor
weakness fixed inline; the major divergences it surfaces are correctly parked.

### Verified (the suite does what it claims)
- **All three legs pass exactly as stated** (memory 32; store 17 + 1 pending; isolation
  15 + 3 pending). Re-ran after my edits — still green.
- **The teeth are real, not vacuous.** Honored arms confirm via behavioral read-backs
  (`SET DEFAULT` → fresh insert picks up the default; `dropConstraint` → duplicate now
  permitted; `SET COLLATE` → NOCASE collision now rejected; `addConstraint` → forward
  enforcement throws CONSTRAINT). Reject arms assert code + sited message + an
  unchanged-table read-back. The driver explicitly fails a reject arm that "succeeds"
  — the silent-divergence signature.
- **Handoff finding #1 (ADD CHECK is engine-side, honored for both memory and store)**
  confirmed against `runtime/emit/add-constraint.ts` `runAddCheck` (never routes to
  `module.alterTable`) and the store's dead-for-CHECK `UNSUPPORTED` branch
  (`store-module.ts:948`). The matrix correctly asserts honored for both.
- **The three parked isolation cells genuinely fail when un-skipped** (verified by
  direct probe): runtime ADD UNIQUE and SET COLLATE surface `INTERNAL [2]` instead of
  `CONSTRAINT [19]`; DROP UNIQUE still rejects a now-legal duplicate (a true silent
  divergence). The skip disposition is correct and `isolation-runtime-constraint-
  propagation` accurately describes them — not un-skippable already-passing coverage.
- **Docs are current.** `docs/module-authoring.md` §"Schema Changes" / §"No silent
  divergence" (lines 287, 344, 537–545) document the exact contract the tests cite;
  updated by the prereq. No doc drift.
- **The handoff's one unasserted open concern — "engine-side ADD CHECK may not survive
  reconnect for store tables" — is NOT a real bug.** `runAddCheck` fires a
  `table_modified` notification; the store's `onEngineSchemaChange` listener
  (`store-module.ts:1808`) persists that event via `persistCatalogIfChanged` →
  `buildCatalogEntry` → `generateTableDDL`, and `generateTableDDL` (`ddl-generator.ts:328`)
  emits CHECK constraints. So an engine-side ADD CHECK round-trips to the store catalog.
  The handoff author missed the listener. No ticket filed.

### Fixed inline (minor)
- **Loose reject-site regexes.** Three arms used a bare single letter `v` as a regex
  alternative (`/v|convert/i`, `/v|not null/i`), which matches the letter `v` in *any*
  message and so does not actually verify the message is sited to the column — defeating
  the whole point of the "sited message" check. Tightened the single-letter alternatives
  to word boundaries (`/\bv\b|convert/i`, `/\bv\b|not null/i`, and `/\breq\b|not null/i`
  for consistency) across all three spec files. Verified against the actual engine
  messages ("column v contains NULL values", "Cannot convert value in 'v' to integer",
  "NOT NULL constraint failed for column 'req' …") — all still match; all legs still green.

### Observed, left as-is (minor, documented)
- **`alterColumn SET DEFAULT` has no `else` (reject) branch in its `confirm`.** In the
  no-`alterTable` stub leg it runs as a reject, so `confirm('rejected')` is a no-op — the
  reject's code + sited message are still asserted, only the post-state read-back is
  skipped for that one cell. There is no clean schema read-back for "default was not
  set" and the throw precedes any schema mutation, so the residual risk is negligible.
  Not worth tightening.

### Not in scope (correctly deferred by the implementer)
- PK-collation store cell (`store-pk-collate-module-capability`) — 1 pending skip.
- Cross-connection overlay poison (two concurrent connections) — single-connection path
  is covered; a two-connection case could be added later.
- LevelDB store path — exercised only by `yarn test:store`, not this fast lane.
- Harness duplication across the three legs — justified by the dependency graph
  (centralizing would require a quereus→store/isolation circular dev-dependency).

## Validation (all green)

```
# memory leg (32 passing)
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/alter-table-conformance.spec.ts"
# store leg (17 passing, 1 pending)
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/alter-table-conformance.spec.ts"
# isolation leg (15 passing, 3 pending)
node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-isolation/test/alter-table-conformance.spec.ts"
```

- `yarn workspace @quereus/quereus run lint`: **EXIT 0**.
- `tsc --noEmit -p packages/quereus-store/tsconfig.test.json` and the isolation
  equivalent: **EXIT 0**.
- My edits touch only regex literals in the three spec files; all three legs re-run
  green. No other files affected, so the broader suite (green at the implement commit)
  is unchanged.

## Follow-ups (parked, not blocking)

- `tickets/fix/isolation-runtime-constraint-propagation.md` — the three real isolation
  divergences (un-skip the `ISOLATION_GAP_ARMS` cells when it lands).
- `store-pk-collate-module-capability` — flips the one pending store cell.
