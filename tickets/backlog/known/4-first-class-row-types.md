----
description: Design sketch — first-class row (tuple) type as a foundational structural type (named + ordinal attributes, optional keys/constraints); reframe RelationType as a set/bag *of* a RowType. Enables row-valued parameters, typed field access, row spread into columns, row literals, and row-value comparison.
files: packages/quereus/src/common/datatype.ts, packages/quereus/src/common/types.ts, packages/quereus/src/types/logical-type.ts, packages/quereus/src/types/registry.ts, packages/quereus/src/types/builtin-types.ts, packages/quereus/src/types/json-type.ts, packages/quereus/src/common/type-inference.ts, packages/quereus/src/core/param.ts, packages/quereus/src/planner/scopes/param.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/runtime/emit/parameter.ts, packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/select-projections.ts, packages/quereus/src/util/comparison.ts, docs/types.md, docs/architecture.md
----

> **Status: design sketch, not greenlit.** Captured 2026-06 from a design exploration. The core direction (first-class row type, foundational, `RelationType` as a collection *of* a `RowType`) is agreed; several decisions are recorded below and a few are explicitly left open. Do not promote to `plan/` until the open questions — especially the *pure-vs-hybrid* type model and the scope of the `RelationType` refactor — have a human decision.

## Motivation

SQL forces callers to flatten naturally-structured data into a wide list of scalar bind parameters, hand-destructuring host objects field by field even when the structure is already present. A representative host-side `db.exec` insert:

```sql
insert into InviteResult (SlotCid, IsAccepted, InviteSignature, InvokedId)
values (:slotCid, :isAccepted, :inviteSignature, :invokedId)
```

```ts
db.exec(sql, {
  slotCid,
  isAccepted: invite.isAccepted,
  inviteSignature: invite.inviteSignature,
  invokedId,
});
```

A first-class row type lets a structured value pass as a single parameter, with its fields referenced inline:

```sql
insert into InviteResult (SlotCid, IsAccepted, InviteSignature, InvokedId)
values (:slotCid, :invite.isAccepted, :invite.inviteSignature, :invokedId)
```

```ts
db.exec(sql, { slotCid, invite, invokedId });
```

And where a row's shape matches the target, the whole row spreads into columns — `insert into InviteResult select (:result).*`.

Use cases this unlocks:

- **Row-valued parameters** — pass one structured object instead of N flat keys; reference `:p.field` as a typed field access.
- **Row spread** — `insert into T select (:row).*` where the row is shape-compatible with the target (the PostgreSQL `(composite).*` / Oracle `insert ... values <record>` move).
- **Row literals** — build rows in SQL with `row(expr as name, ...)`; nest them.
- **Row-as-relation** — a row value usable directly as a one-row `from` source / `values` row, closing the row⟷relation loop.
- **Row comparison** — `(a, b) = (c, d)` and multi-column `(a, b) in (select ...)` (the latter is a currently-missing capability).
- **Canonical serialization** — an *ordered* row type yields a deterministic field serialization (e.g. for hashing/digests), which an unordered JSON object does not guarantee — relevant to the determinism/replay invariants.
- **Table composition** — declaring a relation as "a set/bag of RowType `R`" lets a row type's attributes (and, per the open question below, its keys/constraints) be reused across many relations.

## Core idea: row type as the foundational structural type

A **RowType** is a structural type carrying an **ordered list of attributes**, each addressable **both by name and by ordinal**, optionally annotated with **keys** and **constraints**:

- **Named + ordinal.** Field access (`r.field`, `row(expr as name)`) needs names; positional construction (`(a, b, c)`), positional row comparison (`(a, b) = (c, d)`), and INSERT positional mapping need ordinals. The engine already carries this duality out-of-band (`Attribute.name` + `RowDescriptor` ordinal index in `planner/nodes/plan-node.ts`); a RowType makes it intrinsic to the value's type.
- **Keys (open question).** The dev wants a row type to optionally describe "what makes this row comparable to another" — i.e. identity/equality semantics declared on the *type*. This diverges from classic TTM (where keys are a relation-level concept) and from PostgreSQL composite types / Dataphor tuples (which carry no keys). The payoff: declare a key once on the RowType and every relation of that RowType inherits it. Needs design discussion — see Open questions.
- **Constraints (open question).** Likewise, optionally attach constraints to the RowType. Interaction with the existing per-relation `rowConstraints` and the FD/CHECK-derived-premise machinery must be worked out.

**Reframe `RelationType` as a collection of a `RowType`.** Today `RelationType = { columns: ColumnDef[], keys, isSet, rowConstraints, ... }` (`common/datatype.ts`). The target shape is roughly:

```
RowType      = { attributes: Attr[] (ordered, named), keys?, constraints? }   // the tuple
RelationType = { row: RowType, isSet /* set vs bag */, ... }                   // {RowType} or [RowType]
```

so "a relation is a set/bag of rows" becomes literal rather than implied. This is the TTM `RELATION = {TUPLE}` unification and makes row⟷relation conversion and table composition straightforward — but it is a **refactor of a core type touched by most of the planner**, so its scope/risk is itself an open question (see below).

**Distinct from JSON, coercing to/from it.** A RowType is *not* an alias for `JSON_TYPE`. It is a distinct structural type that **coerces to/and from `json`**, so existing JSON columns can carry rows while the type checker tracks the shape (named/ordered fields, types). Keeping rows distinct is what preserves the ordered-field canonical serialization the determinism story relies on.

## What already exists (and the gaps)

The **runtime half is already present**, which makes the initial phases far smaller than they appear:

- `SqlValue` already includes `JsonSqlValue = { [k]: JSONValue } | JSONValue[]`, stored as **native JS objects/arrays** (not strings) — `common/types.ts`.
- `isSqlValue()` already accepts plain objects; `inferLogicalTypeFromValue()` already maps an object → `JSON_TYPE`; the parameter emitter (`runtime/emit/parameter.ts`) returns the bound value verbatim. So `db.exec(sql, { invite: {...} })` already flows `:invite` through as an object **today**.
- `PhysicalType.OBJECT` already exists and is used by `JSON_TYPE` with `deepCompareJson` (`types/json-type.ts`).
- Runtime `Row = SqlValue[]`; naming is carried out-of-band via `Attribute` + `RowDescriptor` (`planner/nodes/plan-node.ts`).

The **gaps** are all on the type/plan side:

1. No structural row *type* — an object param is opaque `JSON_TYPE`, so `:p.field` is not a typed field access.
2. `LogicalType` is today a flyweight **singleton registered by name** (`registry.ts`); a row type is **structural/parameterized** (`row(a int)` ≠ `row(x text)`), so the type system must admit per-shape instances compared structurally.
3. No row constructor, field-access, spread, or row-as-relation builders.
4. No row-value comparison as a scalar (rows are compared element-wise internally via `compareRows` in `util/comparison.ts`, but not exposed as `(a,b)=(c,d)`; multi-column `in` is unsupported).
5. `(a, b, c)` currently parses as a parenthesized scalar expression, **not** a row constructor — there is no `RowConstructorExpr` (`parser/parser.ts`).

## Surface syntax (decisions + opens)

- **Type spelling:** `row(a int, b text)` (SQL-standard / Trino / PostgreSQL flavored; fits the lowercase-keyword house style). *Decision pending only on the keys/constraints annotation form.*
- **Constructor:** `row(expr [as name], ...)` — **decided.** Reuses the existing select-list alias grammar; field names default from the expression and are overridable with `as` (the BigQuery/Trino `struct(expr as name)` approach, expressed in grammar Quereus already has).
- **Field access:** dot — `r.field` — with scope-based disambiguation against `table.column`. **The disambiguation rule is open** (PostgreSQL's `(r).field` parens were explicitly rejected as ugly; an alternative is wanted).
- **Spread & row-as-relation:** `(:row).*` expands fields as columns; a row value standing alone coerces to a one-row relation (`from :row`).
- **`values` consumes rows:** `values` is a list of row constructors (the SQL-standard model), so bare `(a, b, c)` *is* the positional row constructor and a bare row-valued expression is consumed implicitly — `values :r` spreads `:r`'s fields as columns, `values (:r)` nests `:r` in a single column. Parens-presence is the sole disambiguator (no type-magic), and `values` context means the `row` keyword is never needed there. Payoff spelling: `insert into InviteResult values :result`.
- **Comparison:** `(a, b) = (c, d)` and `(a, b) in (...)`, element-wise with the SQL-standard NULL rule.

## Prior art to draw on

| Source | Type spelling | Construct | Access | Worth stealing |
|---|---|---|---|---|
| **Dataphor D4** | `row { a : Integer }` | `row { 1 ID }` | `r.a` | Peer-of-relation type generator + selector + row-valued operators; the foundational `RELATION = {TUPLE}` framing |
| **SQL standard** | `row(a int)` | `row(1,'x')` / `(1,'x')` | `r.a` | Row-value comparison `(a,b)=(c,d)` + multi-column `in`, element-wise with a defined NULL rule |
| **PostgreSQL** | composite / `row(...)` | `row(1,'x')` | `(r).a`, `(r).*` | `(composite).*` spread — the direct ancestor of the motivating insert |
| **DuckDB** | `struct(a int)` | `{'a':1}` / `struct_pack(a:=1)` | `r.a`, `r['a']` | Proof that the cheap path is "typed JSON," not a new runtime value kind |
| **BigQuery / Trino** | `struct<a int64>` / `row(a int)` | `struct(1 as a)` / `row(1)` | `r.a` / `r[1]` | `struct(expr as name)` ⇒ reuse the select-alias grammar |
| **Oracle PL/SQL** | `emp%rowtype` | record vars | `rec.col` | `insert ... values <record>` — the cleanest "pass a whole row" ergonomic |

References: [TTM implementers' reflections (D4 row types)](https://www.dcs.warwick.ac.uk/~hugh/TTM/Reflections-from-implementers.html), [DuckDB STRUCT](https://duckdb.org/docs/current/sql/data_types/struct), [PostgreSQL composite types](https://www.postgresql.org/docs/current/rowtypes.html), [PostgreSQL row comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html).

## Decisions recorded

1. **First-class type**, not a scalar-with-structural-type convenience. Foundational, with named **and** ordinal attributes. The *hybrid* (row value rides as a scalar while typed structurally) is **not** chosen but **not** fully ruled out — see Open questions.
2. **Shape source: hybrid** — infer the row shape from the bound value at prepare time (as scalar params already infer their type), *and* allow an explicit SQL-level declaration for prepare-once/bind-many.
3. **Constructor syntax:** `row(expr as name, ...)`.
4. **Row vs JSON:** distinct structural type that **coerces to/from `json`**.
5. **Dot disambiguation:** open — the PostgreSQL parens form was rejected.

## Open questions (resolve before planning)

- **Pure first-class vs hybrid type model.** Pure = a new top-level type kind alongside `scalar`/`relation`/`list`/`void`, threaded through every `typeClass` switch (expression typing, emitters, validation, the `ScalarPlanNode`/`RelationalPlanNode` split). Hybrid = the value rides the scalar pipeline (cheapest orthogonality) while the type is structural. Note: there is already a `'list'` type class precedent for "neither scalar nor relation" — **investigate how list *values* flow through the runtime today**, as that is the nearest model for how a row value should ride.
- **Scope of the `RelationType = {RowType}` refactor.** Conceptually clean, but `RelationType` is consumed across most of the planner (FDs, keys, attributes, optimizer rules). Decide whether to refactor the core type or to derive a RowType view from it incrementally.
- **Keys/constraints on a row type.** Semantics of declaring keys ("comparability") and constraints on the *type*; how a relation inherits them; interaction with existing `keys`, `rowConstraints`, FD propagation, and CHECK-derived premises.
- **Dot-access disambiguation** rule (replacement for `(r).field`).
- **Single-element row vs grouping.** In *expression* position, `(x)` reads as grouping and `(x, y, …)` as a row; `row(x)` forces a one-field row (the SQL-standard `ROW(x)` vs `(x)` rule). Inside `values`, `(x)` stays a one-column row as today. Pinning this is also the gate on the larger "bare parens = row constructor in every expression position" step that row comparison `(a, b) = (c, d)` (Phase 4) needs.
- **Coercion rules** between `row(...)` and `json` (assignability both directions; what a round-trip preserves — field order, types).

## Phasing sketch (staging, not a task list)

1. **Typed row params + field access** — infer shape from the bound object; type `:p.field`; validate shape at bind. Highest value, smallest surface (no new runtime value kind). Touches `type-inference.ts`, `core/param.ts`, `planner/scopes/param.ts`, a row field-access node + emitter.
2. **Spread & row-as-relation** — a row value coerces to a one-row relation; `values` is the multi-row form. `(:p).*` (hook `buildStarProjections` in `building/select-projections.ts`); `from :row`; and implicit `values` consumption — extend the per-row item parser in `valuesStatement` (`parser/parser.ts`) to accept a bare row-valued expression alongside the existing `(scalars...)` list, with parens-presence selecting spread (`values :r`) vs nest (`values (:r)`). Builders: `buildValuesStmt` (`building/select.ts`), `nodes/values-node.ts`, `building/insert.ts`. Localized — does **not** require bare-parens-as-row-constructor in every expression position (that pairs with Phase 4). Where `insert into T values :result` lands.
3. **Row literals/constructors** — `row(expr as name, ...)`, nesting, rows in projections, UDFs that accept/return rows.
4. **Row comparison & multi-column `in`** — expose `compareRows` as a scalar `=`/ordering with the SQL-standard NULL rule; this is where bare `(a, b)` becomes a row constructor in *expression* position (see the single-element open question).
5. *(optional, TTM-complete)* rows as **column types** (nested/composite storage, RVA/TVA), row-typed CTEs, full tuple generator; this is where the `RelationType = {RowType}` refactor pays off most.

## Related work

- `4-core-sql-features` (backlog) — adjacent: orthogonal relational expressions, `values` in select locations, expression-based functions.
- `docs/architecture.md` design decisions — **Relational Orthogonality**, **Bags vs Sets**, **JavaScript Types**, **Modern Type System** — a shipped row type would add a new bullet here and lean on all four.
- `docs/view-updateability.md` / lens work — row⟷relation conversion and the "relation is of a row type" framing connect to view updateability and lens get/put.
- `docs/types.md` — type-system home for the new structural type.
