description: The full-rebuild floor's replace-all diff skips collation-equal / byte-different rows, leaving a floor-maintained backing byte-stale against the live body — a confirmed divergence from the byte-exact maintenance-equivalence oracle. Decide and align the wholesale skip discipline with the byte-faithful point-op discipline (`rowsValueIdentical`).
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts          # replace-all arm's collation-aware `rowsEqual` skip
  - packages/quereus-store/src/common/backing-host.ts          # store replace-all uses the same collation-aware `rowsEqual`
  - packages/quereus/src/util/comparison.ts                    # `rowsValueIdentical` — the byte-faithful discipline the point ops use
  - packages/quereus/test/vtab/maintenance-replace-all.spec.ts # pins the CURRENT collation-aware skip ("collation-equal rows skip", stored casing retained)
  - packages/quereus/test/incremental/maintenance-equivalence.spec.ts  # the byte-exact oracle + forceFullRebuild helper
  - docs/materialized-views.md                                 # § Value-identical (no-op) write suppression documents the divergence
----

# Full-rebuild floor: replace-all skip is not byte-faithful

## Confirmed repro

```sql
create table t (id text collate nocase primary key, v integer);
insert into t values ('apple', 1);
create materialized view mv as select id, v from t;
-- force the 'full-rebuild' plan onto mv (forceFullRebuild helper in
-- maintenance-equivalence.spec.ts), then:
update t set id = 'APPLE' where id = 'apple';
select id from mv;   -- returns 'apple'  (live body returns 'APPLE')
```

The floor re-evaluates the body (rows carry the NEW bytes `'APPLE'`) and diffs via
`'replace-all'`, whose identical-row skip is **collation-aware** (`rowsEqual` with each
column's collation): `'apple'` ≡ `'APPLE'` under NOCASE and the payload matches, so the
row is skipped and the backing retains the stale bytes. `select` returns stored bytes,
so `read(MV) != evaluate(body)` byte-wise — the maintenance-equivalence oracle's
definition of divergence. No current suite reaches it (the floor suites use integer
PKs; the NOCASE suites use bounded-delta arms), so it is latent, not a test failure.

## The inconsistency

`mv-noop-upsert-suppression` made the point-op `upsert` skip **byte-faithful**
(`rowsValueIdentical`: BINARY per column, numeric-storage-class tolerant) precisely so a
case-only rewrite re-keys the stored bytes — pinned by the lateral-TVF NOCASE re-key
test and the byte-exact oracle. The wholesale `replace-all` skip kept its deliberately
collation-aware discipline because `maintenance-replace-all.spec.ts` pins it ("NOCASE
PK: collation-equal rows skip", stored casing retained). The two disciplines now
coexist, documented in `vtab/backing-host.ts` and materialized-views.md § no-op
suppression — but the floor side is unfaithful to the oracle.

Note `docs/incremental-maintenance.md` § replace-all *describes* the collation-equal
key case as resolving to an `update` ("rather than a spurious insert + delete") — the
prose author appears to have intended collation-aware **key pairing** with a
byte-faithful **value compare**; the implementation instead skips. The fix direction
that satisfies the oracle: keep key matching collation-aware (the PK comparator — that
part is correct and load-bearing), switch the value-identical row comparison to
`rowsValueIdentical`, and update the two pinning spec cases ("collation-equal rows
skip" becomes "collation-equal key with identical payload is an update that re-keys
the stored bytes"; byte-identical rows still skip). Store host `rowsEqual` aligns
identically. Add a floor NOCASE equivalence suite (forceFullRebuild over a NOCASE-PK
body + case-only rewrites) so the oracle covers the floor's collation behavior.

Requirement either way: ONE documented discipline, the byte-exact oracle green over a
NOCASE floor body, and no spurious insert+delete pairs for collation-equal keys
(secondary-index bookkeeping relies on the update pairing).
