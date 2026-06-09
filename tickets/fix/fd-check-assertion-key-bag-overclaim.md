description: A `CHECK (col1 = col2)` (and a hoisted `CREATE ASSERTION` equality) seeds an UNGATED bi-directional determination FD `{a}↔{b}` onto the `TableReferenceNode`'s physical FDs. On a table with a third column, projecting away that column and applying DISTINCT lets `deriveKeysFromFds` read the bag as a set and drop a REQUIRED DISTINCT — producing WRONG RESULTS. This is the identical over-claim class fixed for four producers in ticket `fd-derived-key-bag-overclaim`, but at a fifth (CHECK-derived) and sixth (assertion-hoist-derived) producer that ticket never enumerated.
files: packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/analysis/check-extraction.ts, packages/quereus/src/planner/analysis/assertion-hoist-cache.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/check-derived-fds.spec.ts, packages/quereus/test/fd-derived-key-bag-overclaim.spec.ts
----

## The bug (confirmed wrong results)

```sql
create table tc (a integer, b integer, c integer, check (a = b));
insert into tc values (1,1,10),(1,1,20),(2,2,30);
select distinct a, b from tc;   -- returns 3 rows; CORRECT answer is 2
```

`CHECK (a = b)` makes `getCheckExtraction(tc)` emit the bi-directional determination
FDs `{a}→{b}` and `{b}→{a}` (via `walkConjunction` / `extractCheckConstraints` in
`check-extraction.ts`). `TableReferenceNode.computePhysical` (`reference.ts`
~lines 143-167) folds **every** `checkExt.fds` entry onto the node's physical FDs
unconditionally:

```ts
for (const fd of checkExt.fds) { fds = addFd(fds, fd); }
...
if (hoisted) { for (const fd of hoisted.fds) fds = addFd(fds, fd); }
```

The projection `select a, b` drops `c`, but `{a}↔{b}` survives `projectFds`. On the
2-column output `deriveKeysFromFds` computes `closure({a}) = {a,b} = all_cols`, so
`{a}` is read as a unique key — `keysOf` reports the body as a set,
`rule-distinct-elimination` drops the DISTINCT, and the duplicate `(1,1)` row leaks.

A 2-column base table does **not** exhibit this (the implicit all-columns PK forbids
duplicate full rows), which is why it hides until a column is projected away. The
**assertion-hoist** path (`assertion-hoist-cache.ts` → `getAssertionHoistedConstraints`,
folded at `reference.ts` ~line 161) hoists `create assertion ... not exists (select 1
from T where a <> b)`-shaped predicates into the same `{a}↔{b}` FDs and is the sixth
producer with the identical defect.

This is the same root cause and the same reader (`keysOf` → `deriveKeysFromFds`) as
ticket `fd-derived-key-bag-overclaim`. That ticket deliberately fixed the four
producers it enumerated (ProjectNode injective FD, join equi-pair FD, fanned LEFT/RIGHT
side key FDs, filter `a=b` equality FD) and left the reader untouched. The CHECK /
assertion-hoist producers were simply not in its scope.

## Fix approach (mirror filter site 4)

Gate the **two-column determination FDs** (`determinants.length === 1 &&
dependents.length === 1`) at the `TableReferenceNode` consumption site in
`reference.ts`, exactly as `FilterNode.computePhysical` gates `extractEqualityFds`
output: fold the determination FD only when one endpoint is a genuine superkey of the
table's **real** keys (the FDs seeded from declared PK / UNIQUE — i.e. the FD set
present *before* the check/assertion FDs are added). Use `isSuperkey(new Set([a]),
realKeyFds, colCount) || isSuperkey(new Set([b]), realKeyFds, colCount)`.

- Keep the **EC merge unconditional** — value-equality is always sound, carries
  constant propagation, and ECs are not read by `keysOf` (same rationale as the four
  shipped sites).
- Apply the same gate to BOTH `checkExt.fds` and `hoisted.fds`. The `∅ → col` constant
  FDs (determinants.length === 0) and one-way `other → col` expression FDs
  (`check (b = a + 1)`) must pass through unchanged — only the bidirectional
  single↔single pair is the over-claim.
- Do **not** edit `extractCheckConstraints` / `walkConjunction` themselves — they are
  shared with `assertion-hoist-cache.ts` and unit-tested directly
  (`check-derived-fds.spec.ts` asserts the raw bi-FD output). Gate at consumption, as
  ticket 4 did for `extractEqualityFds`.
- Mind the existing ordering/dedup contract: declared-check facts merge before
  assertion-hoist so structurally-identical entries keep `declared-check` provenance;
  the gate must not disturb that.

`realKeyFds` is the FD set built from the declared keys. The cleanest source is the FDs
already derived before the check lift in `computePhysical` (the declared-key FDs from
`relationTypeFromTableSchema` / the partial-unique path are guarded and excluded by
`isSuperkey`'s guard skip). Confirm the probe set excludes the check FDs themselves so a
check FD can never justify itself (mirrors the "built BEFORE the loop mutates fds"
discipline at the join site).

## TODO

- Add the gate in `reference.ts` `computePhysical` for both `checkExt.fds` and
  `hoisted.fds`; keep EC merge unconditional.
- Add end-to-end repros to `test/fd-derived-key-bag-overclaim.spec.ts` (or a sibling
  spec): a `check (a=b)` 3-column DISTINCT repro (must survive, 2 rows) + a control
  where `a` is the PK (DISTINCT eliminated); plus an assertion-hoist repro/control.
- Check for any plan/FD golden or `fd-propagation`/`check-derived` *propagation* test
  (not the `extractCheckConstraints` unit test) that asserts the TableReference physical
  FDs include the now-gated `{a}↔{b}`; update to the gated expectation with a comment.
- Re-run the distinct-elimination fuzz differential — this is a wrong-results bug, so it
  is exactly the class that differential is meant to catch.
- Verify the `isUnique` closure branch (`fd-utils.ts` ~line 840) does not separately
  over-claim on these check-derived bags for any other consumer (the implementer of
  ticket 4 flagged it as untested but believed unreached by the DISTINCT path).
