description: Let a BINARY-keyed store honor a `→NOCASE` PRIMARY KEY `SET COLLATE` via a write-time logical PK uniqueness scan, closing the one divergence direction the current reject leaves off.
files: packages/quereus-store/src/common/store-module.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/logic/41.7.1-alter-column-collate-unique.sqllogic
----

## Background

`store-pk-collate-module-capability` resolved the store's PK-column `SET COLLATE` to
**accept-when-consistent / reject-when-divergent**: the store enforces PK uniqueness
*physically* under a single fixed table-level key collation K (`config.collation`, one of
`BINARY` / `NOCASE`, default `NOCASE`), so it applies a PK `SET COLLATE` schema-only when the
target equals K and throws `UNSUPPORTED` when it diverges.

Reject closes both divergence directions honestly, but it permanently refuses one direction
that *could* be honored without an on-disk format change:

- **K looser than the target collation** (K = `BINARY`, target = `NOCASE`): the physical key
  keeps rows distinct that the new collation wants merged. The store currently under-enforces
  if it applied the change (the original silent-divergence bug) — so reject is correct today,
  but the change is *logically* honorable by adding a write-time uniqueness check under the
  declared collation.
- (The other direction — K stricter than target, K = `NOCASE`, target = `BINARY` — is
  genuinely irreparable: the physical key already merged rows the target wants distinct, so
  they cannot even coexist. That stays a reject regardless.)

## Goal

For a PK-column `SET COLLATE` where the target collation is *finer* (more rows distinct) than
the fixed physical key K — concretely a `BINARY`-keyed store table receiving `→NOCASE` — honor
the change logically instead of rejecting:

1. Validate existing rows: scan the data store and reject with `CONSTRAINT` if any two rows
   that are distinct under K collide under the new declared collation (the rows physically
   coexist, so a duplicate is detectable).
2. Forward enforcement: add a write-time logical PK uniqueness check under the declared
   per-column PK collation (a scan or a covering structure), since the physical key alone no
   longer guarantees PK uniqueness under the declared collation.

## Cost / why deferred

The forward check adds a full-scan (or a covering-MV requirement) to the hot PK write path,
and only benefits non-default `BINARY`-keyed store tables — the overwhelmingly common default
store table is `NOCASE`-keyed, where the only meaningful change is `→NOCASE` (already the
consistent/honored case) and `→BINARY` is physically impossible. So the value is narrow and the
cost lands on every PK write. Reject is the honest, cheap, complete default; this ticket is the
opt-in enhancement for the `BINARY`-keyed minority.

## Test expectations

- A `BINARY`-keyed store table (`using store` with a table-level `BINARY` key collation) with
  PK values distinct under `NOCASE` honors `SET COLLATE nocase` and then rejects a later
  NOCASE-colliding PK insert with `CONSTRAINT`.
- The same with NOCASE-colliding existing rows rejects the ALTER with `CONSTRAINT`, table
  unchanged.
- The `→BINARY`-on-a-`NOCASE`-keyed-store direction continues to reject with `UNSUPPORTED`
  (unchanged from the module-capability ticket).
