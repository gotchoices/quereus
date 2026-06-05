description: Review the write-enabled second half of the outer-join existence column — writing the `existence`-sited boolean drives insert/delete of the non-preserved side (Dataphor `include rowexists`). `set hasB = true` while absent ⇒ insert B; `= false` ⇒ delete the matching B row; both compose with a same-side column write and with insert-through. Built on the per-row conditional materialization substrate from `view-write-optional-member-transitions`; read half is `outer-join-existence-read`.
files: packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md
----

## What shipped

The write half of the outer-join existence column. The `existence`-sited boolean
(`exists … as hasB`) is now **writable through an effect**: writing it drives the
non-preserved side's existence. The runtime substrate is **reused, not extended** — the
existence write is the insert-or-delete specialization of the non-preserved-side UPDATE
machine (`view-write-optional-member-transitions`'s capture + null-extended INSERT +
captured-key partition).

### Routing (`update-lineage.ts` → `backward-body.ts` → `multi-source.ts`)

- **`resolveBaseSite`** (`update-lineage.ts`): an `existence` site now resolves to a
  **writable-through-effect** descriptor — `writable: true`, `baseColumn`/`table`
  undefined, plus `existenceComponent` (the `RelationalComponentRef`) + `existenceGuard`.
  Base-column consumers gate on `baseColumn !== undefined`, so they are unaffected
  (verified: `single-source.ts` guards on `site.baseColumn`; `lens-prover.ts` never sees
  an existence site and guards every deref).
- **`backward-body.ts` / `multi-source.ts`**: the descriptor threads through
  `BackwardColumn` into `OutColumn` (`existenceComponent` + resolved `existenceSide`).
  The flag's component carries the JoinNode *child* id (an `AliasNode` wrapper for an
  aliased source), so `analyzeJoinView` maps it through a new `buildNodeToSoleTableRef`
  (node id → sole `TableReferenceNode` beneath it) → side index, with a fallback to the
  unique non-preserved side (`resolveExistenceSide`).
- **`decomposeUpdate`**: an assignment whose target is an existence column routes off
  `out.existenceComponent` — `true` ⇒ ensure a (possibly empty) `nullExtendedBySide`
  entry so the post-loop emits the null-extended materialization INSERT (matched rows are
  a no-op); `false` ⇒ a base DELETE keyed on the captured non-preserved PK
  (`buildCapturedKeyPredicate` — a null-extended row's captured PK is null, so it is
  naturally excluded). A same-side `set` folds its columns into the INSERT. `set npCol =
  …, hasB = false` is rejected `conflicting-assignment` (delete-the-side + write-its-
  column). Value must be a boolean literal (`asBooleanLiteral`); non-literal defers
  `unsupported-outer-join-update`. RETURNING rejects `returning-through-view`.
- **INSERT** (`analyzeMultiSourceInsert`): `hasB` is consumed as a routing directive,
  never stored. It stays a (passthrough) envelope column for VALUES arity but maps to no
  base side; its uniform boolean literal (`existenceInsertFlag`) forces the non-preserved
  side active (`true`) / inactive (`false`), overriding the columns-supplied inference. A
  `false` directive contradicting a supplied non-preserved column rejects
  `conflicting-assignment`.

### Static surface (`func/builtins/schema.ts`)

`deriveColumnInfo` reports an `existence` flag `is_updatable = 'YES'` with `base_table` /
`base_column` = `null` (writable through an effect, no base mapping), gated on a preserved
anchor (a FULL outer — no anchor — stays deferred). `deriveViewInfo` is unaffected (an
existence site has no base target, so it never alters `is_insertable_into` / `is_updatable`
/ `is_deletable`).

## Validation

- `yarn workspace @quereus/quereus test` — **4694 passing, 0 failing, 9 pending** (exit 0;
  +1 over the read-half 4693 baseline — the new existence-write round-trip test).
- `yarn workspace @quereus/quereus lint` — exit 0.
- New acceptance tests in `test/property.spec.ts`:
  - `Outer-join existence column` describe (read half block, db-fresh per test): the three
    superseded read-half tests were **flipped** — `lineage` now asserts
    `writable === true` + `existenceComponent` present; `write drives insert/delete`
    replaces the old `write still rejects`; `column_info … is_updatable=YES` replaces the
    old `=NO`.
  - `View Round-Trip Laws § multi-source inner join`: a new dedicated test over `rj_ex`
    (`ex_child LEFT JOIN ex_parent … exists right as hasP`) covering false→true (materialize
    via EC key, pv defaulted), no-op-on-matched, true→false (delete matched parent, child
    untouched), no-op-on-null-extended, GetPut (write read-back hasP back ⇒ base unchanged),
    composition `set pv = 5, hasP = true`, composition contradiction (`conflicting-assignment`),
    insert-through (both-side + preserved-only), RETURNING reject, non-literal reject, and
    `null-extended-create-conflict` (undefaulted not-null parent column).

## Review focus / known gaps (treat tests as a floor)

The reviewer should treat the implementation as a starting point. Specific things to probe:

- **`resolveExistenceSide` robustness.** v1 maps the existence component to a side via the
  node→sole-`TableReferenceNode` map, falling back to *the unique non-preserved side*. This
  is correct for a single LEFT join (the only writable existence shape today). For a body
  with **multiple non-preserved sides** (multiple LEFT joins, each with its own existence
  column) the fallback returns `undefined` → the write defers `unsupported-outer-join-update`.
  The direct id map *should* handle the unaliased case; the aliased case relies on the
  fallback. **Not tested with multiple existence columns** — verify the deferral is clean and
  consider whether the n-way mapping should be tightened before `set-operator-membership`.
- **Untested compositions.** `set <preservedCol> = …, hasB = false` (update the preserved
  side AND delete the non-preserved side — different sides, no contradiction) is *expected*
  to work (two base ops over the shared capture) but is **not** pinned by a test. Same for
  `set <npCol> = …, hasB = true` over a *matched* row (matched UPDATE + no-op INSERT). The
  npv non-preserved-update test covers the underlying substrate, but the existence-composed
  forms are only smoke-covered.
- **FK enforcement.** The `hasB = false` delete removes a parent a child still references; the
  `rj_ex` test runs `pragma foreign_keys = false` (the established outer-join-test pattern).
  With FK *on*, the delete would trip RESTRICT (a runtime concern, documented). No
  plan-time FK analysis is done for the existence delete — verify this is the intended
  contract (the parent-side cascade/RESTRICT machinery is not wired here).
- **INSERT directive value model.** `existenceInsertFlag` requires a **uniform boolean
  literal across all VALUES rows** and rejects a SELECT/DML source (`unsupported-source`).
  A per-row mix or a non-literal defers. The both-side / preserved-only acceptance tests use
  single-row VALUES; multi-row uniform and the per-row-mix reject are **not** tested.
- **`hasB = true` insert with no preserved columns** (`insert into v (hasB) values (true)`)
  forces the np side active with no preserved anchor ⇒ `null-extended-create-conflict`
  expected, but **not** directly tested (the existence-read block's `(cc, cv, hasP=true)`
  case is blocked earlier by exc/exp lacking the mint default — that path uses `rj_ex`'s
  defaulted parent instead).
- **`asBooleanLiteral` leniency.** It accepts `1`/`0` (bigint or number) as well as
  `true`/`false`. Confirm this is desirable (the ticket says "boolean literal"); the tests
  only exercise `true`/`false`.

## Out of scope (kept rejecting, by design)

- Non-literal boolean existence writes (per-row branch on the written value) — deferred.
- The projection-position sugar `exists(<alias>) as hasB` — deferred by the read half.
- Everything `view-write-optional-member-transitions` keeps rejecting (composite shared
  keys for the create branch, aggregate/window write, multi-source insert RETURNING) — the
  existence path inherits those boundaries.
- A composite non-preserved join key for the `hasB = true` materialization rejects
  `unsupported-outer-join-update` (inherited from `outerJoinInsertKey`; single-column join
  key only).

## Downstream note (`set-operator-membership-columns`)

The existence write routing keys off the generic `RelationalComponentRef` (`existenceComponent`
on the resolved site / `OutColumn`), **not** a hard-coded join side, so the set-operation
membership-column work extends the same `existence` `UpdateSite` + routing. Confirm this stays
component-generic if the routing is refactored.
