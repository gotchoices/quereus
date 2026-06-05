description: Review the read half of set-operation membership columns — the `<setop> exists <branch> as <col>` clause (parser/AST/stringify), the `set-op-branch` `RelationalComponentRef` variant, the combinator-derived membership-flag projection on `SetOperationNode` (per-branch semijoin probe → clean `{true,false}` NOT NULL), the read-only `existence` `UpdateSite` for set-op branches, and the FD ramifications. Reads only; all writes still reject (write half is `set-op-membership-write`).
prereq: outer-join-existence-read
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/select-compound.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/runtime/emit/set-operation.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/emit-roundtrip.spec.ts, docs/view-updateability.md, docs/sql.md
----

## What shipped

The read-only front half of set-operation membership columns — the vertical (row)
sibling of the outer-join existence column. A binary set operation's branch membership
is exposed as a first-class clean `{true,false}` NOT NULL boolean column **derived at
the combinator** (a per-branch semijoin probe, never a stored operand column):

```sql
-- which immediate branch(es) did each result row come from?
select id, x, inA, inB
from a union exists left as inA, exists right as inB select id, x from b;
```

- **Grammar** (`parser.ts` `setOpMembershipClauses`, `ast.ts` `SetOpMembershipColumn`,
  `ast-stringify.ts`): the `exists <branch> as <name>` clause sits **between the set-op
  keyword (and any `all`) and the right leg**. `branch` is mandatory (`left` = the leg
  before the operator, `right` = the operand after), so `exists` here is **always**
  followed by `left`/`right` — never `(` — and one-token lookahead distinguishes it from
  the `exists (<subquery>)` predicate. Comma form continues only before another `exists`.
  Wired into **both** compound parse sites (the `selectStatement` path and the
  VALUES-initial `continueSelectAfterFrom` path). **Rejected on `diff`** (parser + a
  defensive guard in `select-compound.ts`). Stringify emits the branch explicitly, so
  `parse(stringify(ast)) ≡ ast`.
- **Mechanism** (`set-operation-node.ts`): a new `SetOpMembershipSpec[]` ctor field with
  pre-minted stable attr ids threads through ctor / `withChildren` / `buildAttributes` /
  `getType`. Each flag is appended **after** the data columns, boolean NOT NULL, never in
  any key (data-column key ColRefs stay valid). `computePhysical` adds, only when flags
  are present: `key → flag` FDs for the keyed **distinct** case (`superkeyToFd` over the
  data columns; **no claim** for `union all`), a `{true,false}` enum domain per flag, the
  optional `except`/`intersect` constant-fold (`inRight=false`/all-true), and the
  read-only `existence` `UpdateSite` per flag. Plain (flag-less) set ops are byte-identical
  to before (early return preserves the original all-`undefined` physical surface).
- **Component ref** (`plan-node.ts`): `RelationalComponentRef` gains the `set-op-branch`
  variant `{ kind, setOp, branch }` (owning node id + immediate operand).
- **Lineage** (`update-lineage.ts`): `resolveBaseSite` resolves a `set-op-branch`
  `existence` site **read-only** (`writable: false`, no base column, no write effect) —
  discriminated from the now-writable join-side existence. `identityBaseColumn` /
  `viewColumnsFromUpdateLineage` already treat any `existence` site as non-base (no change
  needed; verified).
- **Runtime** (`runtime/emit/set-operation.ts`): a uniform membership runner buffers each
  branch's **data** rows into a `BTree` set (reusing the existing collation row comparator,
  built over data columns only), produces the operator's normal output rows, and appends
  one boolean per flag = `data-tuple ∈ <that branch's set>`. `union all` preserves
  multiplicity; the distinct operators dedup on data columns only. Selected only when the
  node carries flags; the original streaming/dedup runners are untouched otherwise.
- **Static surface** (`func/builtins/schema.ts`): `column_info` reports a `set-op-branch`
  existence column `is_updatable = 'NO'` with null base in this half (gated explicitly on
  `component.kind === 'join-side'` for the writable case).

## How to exercise / validate

Acceptance gate is `test/property.spec.ts` → **`describe('Set-operation membership columns')`**
(10 tests, all green) plus the `emit-roundtrip.spec.ts` compound entries and the new
Key-Soundness over-claim query. Fixture:

```sql
create table A (id integer primary key, x integer);
create table B (id integer primary key, x integer);
-- (1,10) in A only; (2,20)/(3,30) in both; (4,40) in B only
create view U as select id, x from A union exists left as inA, exists right as inB select id, x from B;
```

Covered:

- **Read agreement** — `select id, x, inA, inB from U` reads `inA`/`inB` true exactly on
  rows present in A/B (incl. a row in both → both true), cross-checked row-by-row against
  `id ∈ A` / `id ∈ B`.
- **Operator coverage** — `except` ⇒ `inLeft=true, inRight=false`; `intersect` ⇒ all flags
  true; `union all` ⇒ a tuple duplicated within a branch still reads the flag true (the
  "present ≥ once" boolean; multiplicity preserved).
- **Clean boolean** — every flag NOT NULL and in `{true,false}`.
- **Key Soundness** — flags leave `isSet`/`keysOf` unchanged vs. the flag-less union;
  `key → flag` present (distinct), flag never inside a claimed key, `{true,false}` domain,
  NOT NULL; a `union all` flag-bearing node makes **no** `key → flag` claim; the added
  over-claim property query (Tier 1 + Tier 2 isolated-node materialization) confirms no
  over-claim on materialized rows. The pre-existing injected over-claim self-test is the
  negative self-test (a flag injected into a key reds).
- **Lineage** — each flag carries a read-only `set-op-branch` `existence` site (`resolveBaseSite`
  → not writable, no base column, no write component).
- **`column_info`** — membership columns report `is_updatable='NO'`, null base/table.
- **Write rejects** — `update U set inB = true` and `insert into U (...)` both throw
  (set-op view writes are unimplemented — `unsupported-set-op`), not a silent no-op.
- **AST** — `compound.existence` captured; `parse(stringify)` stable; `diff` rejected.

Commands (both clean):
- `node packages/quereus/test-runner.mjs` → **4708 passing, 0 failing, 9 pending**.
- `yarn workspace @quereus/quereus lint` → exit 0.
- `yarn workspace @quereus/quereus typecheck` → exit 0.

## Known gaps / honest caveats (treat the tests as a floor)

- **Existence-site `guard` is a `true`-literal placeholder.** The `existence` `UpdateSite`
  for a set-op branch requires a `guard: Expression` (the branch's accumulated σ
  predicate). The ticket states the guard is **carried, not consumed** in the read half, so
  `set-operation-node.ts` carries a `{ type: 'literal', value: true }` placeholder rather
  than walking the branch sub-plan to build the real conjunction. `resolveBaseSite` for a
  `set-op-branch` returns read-only and never reads the guard, so nothing consumes it here.
  **The write half (`set-op-membership-write`) must compute the real accumulated predicate**
  for predicate-honest leaf addressing. This is the load-bearing thing for a reviewer to
  scrutinize — it is a deliberate read-half deferral, not an oversight, but it means the
  guard field is presently non-authoritative.
- **No dead-column-elimination of unused flags.** The membership runner is selected whenever
  the node carries flags, even if no downstream column reads them. For `union`/`intersect`/
  `except` this is harmless (those already buffer/probe both branches). For **`union all`**
  it is a real perf change: an *unused* flag forces the buffering membership runner instead
  of the streaming `runUnionAll`. No pruning pass strips an unused membership spec back to a
  plain set op. This mirrors the join's deferred `prune-unused-existence-flag`; consider a
  sibling backlog prune if it matters. Correctness is unaffected.
- **Parenthesized left leg not supported.** The ticket's example uses `(select …) union …
  (select …)`, but the engine's compound grammar rejects a parenthesized **left** leg at the
  outer level (`create view v as (select 1) union (select 2)` fails identically — a
  pre-existing limitation, not introduced here). The membership clause works in the
  supported non-parenthesized form; tests and docs use that form. Re-paren is out of scope.
- **`EXISTENCE_FLAG_TYPE` reused.** The flag's scalar type is imported from `join-utils.ts`
  (a clean `{true,false}` NOT NULL read-only boolean) rather than redefined — DRY, but the
  name reads join-flavored. A rename to a neutral `MEMBERSHIP/FLAG_TYPE` is cosmetic and
  deferred to avoid touching join code.
- **`union all` count-variant membership** is out of scope (the flag is boolean "present ≥
  once"; the multiplicity collapse is documented). Nested/subtree flags, the product
  coordinate system, projection-position `exists(<branch>)` sugar, and flat n-way shorthand
  are all deferred (`set-op-membership-nested` / `set-op-membership-ergonomic-extensions`).
- **Constant-fold is emitted but lightly tested.** The `except`/`intersect` constant
  bindings (`inRight=false` / all-true) are produced in `computePhysical` and agree with the
  runtime probe, but no test asserts the binding directly (the read-agreement + operator
  coverage tests exercise the equivalent observable behavior). A reviewer may want a direct
  `constantBindings` assertion.

## Out of scope (still rejecting / deferring, by design)

All write semantics (membership-flip ⇒ branch insert/delete, data-column fan-out,
insert-through) → `set-op-membership-write`. Nested/subtree flags, product coordinates,
multi-target fan-out → `set-op-membership-nested`. Flat n-way shorthand, `union all`
count-variant, projection-position sugar → `set-op-membership-ergonomic-extensions` / inline.
