# Collations and Types

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

How collations interact with logical types: type-specific collations, collation validation, how a comparison resolves its collation, and custom collations for custom types. A satellite of [Type System](types.md).

## Collations and Types

### Type-Specific Collations

Collations are associated with specific types:

```typescript
const TEXT_TYPE: LogicalType = {
  name: 'TEXT',
  supportedCollations: ['BINARY', 'NOCASE', 'RTRIM'],
  compare: (a, b, collation) => collation(a as string, b as string),
};

const INTEGER_TYPE: LogicalType = {
  name: 'INTEGER',
  supportedCollations: undefined,  // No collations for numeric types
  compare: (a, b) => compareNumbers(a, b),
};
```

### Collation Validation

Schema creation validates collation compatibility:

```typescript
if (column.collation && column.logicalType.supportedCollations) {
  if (!column.logicalType.supportedCollations.includes(column.collation)) {
    throw new QuereusError(
      `Collation ${column.collation} not supported for type ${column.logicalType.name}`,
      StatusCode.ERROR
    );
  }
}
```

### Comparison collation resolution

A comparison (`=`, `!=`, `<`, `<=`, `>`, `>=`, plus IN, each BETWEEN bound,
each simple-`CASE` WHEN clause, and the declared argument group of a comparison
builtin — `nullif` pairwise, `greatest`/`least` as one N-ary merge)
resolves ONE effective collation from its operands' types via a
**provenance-ranked lattice** (implemented once in
`planner/analysis/comparison-collation.ts`, shared by every plan-time
analysis and runtime emitter so the two cannot drift):

| rank | source (`ScalarType.collationSource`)                  | does BINARY contribute? |
|------|--------------------------------------------------------|-------------------------|
| 3    | `explicit` — a `COLLATE` expression                    | yes (`collate binary` is a real demand) |
| 2    | `declared` — column declared with an explicit `COLLATE`| yes (`c text collate binary` is a real preference) |
| 1    | `default` — defaulted column collation (session `default_collation`, store-module reconcile, engine BINARY default) | **no** — a defaulted BINARY contributes nothing |
| —    | no `collationName` (literals, most expressions)        | n/a |

Resolution of `left <op> right`:

1. The highest rank present among the two contributions wins.
2. If both operands contribute at that rank with **different** names:
   - rank 3 → plan-time error: `conflicting COLLATE clauses in comparison: X vs Y`
   - rank 2 → plan-time error: `ambiguous collation for comparison: column collations X vs Y differ; apply an explicit COLLATE`
   - rank 1 → **BINARY**, silently (defaults are preferences, not declarations)
3. Otherwise the winning contribution's name; no contributions at all → BINARY.

Resolution is **symmetric**: `a = b` and `b = a` always resolve identically
(and error identically). This deliberately diverges from SQLite's
left-operand precedence, in keeping with the engine's explicit-over-implicit
philosophy: a declared `NOCASE` column compared against a plain column is
NOCASE from either side, and genuinely ambiguous declared/explicit pairs are
errors rather than coin flips. Conflicts error even when the operands are
statically non-textual (consistent strictness; only `COLLATE`-wrapped
expressions can reach this case, since non-text columns reject collation
declarations).

Errors surface at the point the comparison compiles: statement prepare for
queries, DML prepare for write-path scopes (CHECK enforcement, FK
parent-existence checks, upsert SET, RETURNING).

**FOREIGN KEY collations are validated at declaration time.** A FK's enforced
comparison is `parent.k = child.fk`; the same lattice that resolves it at DML
prepare also runs at **declaration time** (CREATE TABLE / ALTER … ADD CONSTRAINT
/ ALTER … ADD COLUMN / declarative apply) over the two columns' `ScalarType`s, so
a same-rank conflicting pair is rejected the moment the `REFERENCES` clause is
declared rather than at the first write against the child
(`schema/constraint-builder.ts` `validateForeignKeyCollations`, mirroring the
FK-builder's comparison exactly — never a re-derived name- or textuality-based
rule). It is **unconditional** (not gated on `pragma foreign_keys`): a
contradictory declaration is malformed regardless of whether enforcement is
enabled. The one residual is a **forward-declared parent** (the parent table
does not exist yet when the child is declared): the parent column types are not
yet knowable, so the conflict stays caught at first DML — unchanged. Reload /
`importTable` deliberately does **not** re-validate, so a legacy persisted
conflicting FK reloads without error and still surfaces at DML.

**Provenance is a function of the current catalog column, not its history.**
A column reaches rank 2 (`declared`) two ways, with identical standing: a
CREATE-time explicit `COLLATE` clause, OR `ALTER COLUMN ... SET COLLATE`
(including `SET COLLATE binary` — a real BINARY demand, not the absence of
one). So the same `SET COLLATE NOCASE` resolves identically whether the column
was originally created with or without a `COLLATE` clause; the rank follows the
live column schema (`ColumnSchema.collationExplicit`), never how the column was
first declared.

**Rank-1 `default` provenance is session-transient.** It is not persisted as a
distinct bit: the catalog and persisted DDL are fully explicit (an explicit
`COLLATE` for every non-`BINARY` collation, `BINARY` elided — see docs/sql.md
§ 9.2.4). So a column that got `NOCASE` from session `default_collation`, or a
store-module reconcile default, carries rank 1 in-session but reloads through
the CREATE path as rank 2 (`declared`), because the re-parsed `COLLATE NOCASE`
sets `collationExplicit`. This reload upgrade is **fail-louder only**: a
comparison that previously resolved silently (to BINARY, or to the declared
side) can only become a prepare-time ambiguous-collation error — never silently
different results — so the upgrade needs no catalog/DDL representation change.
A defaulted *BINARY* (and an explicit `SET COLLATE binary`) reloads as rank 1
because `BINARY` is elided from DDL — consistent with a CREATE-time
`c text collate binary` column, which already round-trips to rank 1. This is the
one direction where reopen relaxes rather than tightens: an in-session rank-2
`collate binary` operand can make a comparison an ambiguous-collation error that,
after reopen, resolves silently (the elided BINARY contributes nothing at rank
1). The "fail-louder only" guarantee above covers the rank-1→rank-2 *upgrade* of
a non-BINARY default; the BINARY-elision *downgrade* of an explicit/declared
BINARY is the documented exception, and matches CREATE-time `collate binary`
either way.

Related forms:

- **IN** — `cond IN (e1, …, en)` / `cond IN (subquery)` merges the RHS
  contributions first (a rank-3/2 name conflict among elements is the same
  plan-time error; rank-1 conflicts merge to no contribution; a subquery
  contributes its output column's contribution), then resolves
  condition-vs-RHS through the lattice. The whole membership test runs under
  that ONE collation. Literal-only lists contribute nothing, so the dominant
  case stays condition-driven.
- **BETWEEN** — desugars to two independent comparisons (`expr >= lo`,
  `expr <= hi`); each bound resolves against the tested expression
  separately. Two differently-collated bounds are NOT a conflict with each
  other.
- **Simple `CASE`** — `case x when v1 … when vn` decides each match exactly as
  `x = v1` … `x = vn` would, resolved **per clause** (like BETWEEN's two
  bounds, not like IN's single merged collation). Two differently-collated WHEN
  operands are therefore not a conflict with each other; an explicit `COLLATE`
  on the base *and* a different explicit `COLLATE` on one WHEN operand is the
  same conflict error `=` raises for that pair. The routing between the declared
  type's own `compare`, storage-class comparison and the runtime duration check
  is shared with BETWEEN and `=` (`runtime/emit/operand-comparator.ts`), so a
  `timespan` column matches `case d when 'PT120M'` on elapsed time and a plain
  `text` column holding duration-shaped text stays text-compared. A *searched*
  `CASE` (`case when <predicate>`) does no comparison of its own — its WHEN is an
  ordinary boolean expression that already resolved through the lattice.
- **USING joins** — `using (k)` desugars to the `l.k = r.k` comparison node, so
  it resolves through the lattice by construction, identically to the spelled-out
  form. The pairwise join-key surfaces (merge / bloom / asof) all resolve their
  key collation through the same lattice — the sibling of set operations below.
- **Set operations** (`UNION` / `INTERSECT` / `EXCEPT` / `DIFF`, and `UNION
  ALL`) — each OUTPUT column resolves its dedup/compare collation **symmetrically
  across BOTH inputs'** corresponding column types through the same lattice
  (`resolveSetOpColumnCollation`), rather than inheriting the left input's
  collation alone. The resolved collation is written into the
  `SetOperationNode`'s output column/attribute types, so it governs the dedup /
  membership comparator **and** the output column's `collationName` — i.e. what an
  enclosing `ORDER BY` over the set operation sorts under — in lockstep (one
  resolution site, both readers). The winning *rank* propagates as
  `collationSource`, so a nested set operation re-resolves against the inner
  node's output column **at the correct rank**, and divergence surfaces at every
  level. Conflict handling splits on whether the operator dedups:
    - **DISTINCT operators** (`UNION` / `INTERSECT` / `EXCEPT`; `DIFF` desugars to
      nested `EXCEPT`/`UNION`) DO compare, so a same-rank explicit/declared name
      conflict in any output column is the same prepare-time error a spelled-out
      comparison throws (surfaced when the compound's output scope is built).
    - **`UNION ALL`** does NO dedup, so a conflict is **not** an error — it
      propagates no collation forward (BINARY-equivalent), exactly as `||` / CASE
      swallow conflicts. Rows pass through unchanged.
  Non-textual columns carry no collation, so resolution is a harmless no-op.
  (No sort-merge set-op strategy exists today; if one is ever added it MUST
  derive its key collation from this same resolved output-column collation.)
- **Propagation through non-comparison combiners** (`||` concat, CASE branch
  merge) — the highest-ranked contribution wins and keeps its provenance;
  equal-rank contributions with different names propagate **no** collation
  (the conflict is not an error there — those nodes don't compare — but it
  must not silently coin-flip; a later comparison over the result falls back
  to BINARY).

### Custom Collations for Custom Types

Plugins can define type-specific collations:

```typescript
const PHONENUMBER_TYPE: LogicalType = {
  name: 'PHONENUMBER',
  physicalType: PhysicalType.TEXT,
  supportedCollations: ['AREA_CODE', 'COUNTRY_CODE'],
  compare: (a, b, collation) => {
    // Custom comparison logic based on collation
  },
};
```

---
