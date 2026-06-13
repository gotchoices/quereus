# Quereus SQL Reference Guide

## 1. Introduction

Quereus is a lightweight, TypeScript-native SQL engine inspired by SQLite, with a focus on in-memory data processing and extensibility via the virtual table (VTab) interface. It supports a rich subset of SQL for querying, manipulating, and joining data from virtual tables, with async operations and modern JavaScript/TypeScript idioms. Quereus is designed for use in Node.js, browsers, and other JS environments, and does not provide persistent file storage by default.

**🚨 IMPORTANT: Key Departure from SQL Standard**

Quereus sympathises with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf) principles and **defaults columns to NOT NULL** unless explicitly specified otherwise. This is contrary to standard SQL where columns are nullable by default. This behavior can be controlled via the `default_column_nullability` pragma:

- **Default behavior**: `pragma default_column_nullability = 'not_null'`
- **SQL standard behavior**: `pragma default_column_nullability = 'nullable'`

This design choice helps avoid the "billion-dollar mistake" of NULL by default while still allowing NULLs when explicitly needed.

Key features:
- **Virtual Table Centric:** All data access is via virtual tables, which can be backed by memory, JSON, or custom sources.
- **In-Memory Focus:** No built-in file storage; all tables are transient unless a VTab module provides persistence.
- **Rich SQL Subset:** Supports select, insert, update, delete, CTEs, joins, aggregates, subqueries, and more.
- **Extensible:** Register custom functions, collations, and virtual table modules.
- **Asynchronous:** Database operations are async/await compatible, allowing non-blocking I/O.
- **Third Manifesto Aligned:** Embraces principles like default NOT NULL columns and key-based addressing.

## 2. SQL Statement Reference

### Query expressions

A **query expression** is anything that produces a relation. Quereus accepts
the same five forms at every relation-producing site:

| Form                                 | Notes                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `SELECT …`                           | The canonical relational query.                               |
| `VALUES (…), …`                      | A literal row set. Body-supplied / binding-site names apply.  |
| `INSERT … RETURNING …`               | DML re-projected through `RETURNING`.                         |
| `UPDATE … RETURNING …`               | DML re-projected through `RETURNING`.                         |
| `DELETE … RETURNING …`               | DML re-projected through `RETURNING`.                         |

Each of these may appear at any **relation site**:

- Top-level statement
- FROM-clause subquery source (`… FROM (<query-expr>) AS t [(cols)]`)
- Scalar / row subquery (`(<query-expr>)`)
- `IN (<query-expr>)` and `NOT IN (<query-expr>)`
- `EXISTS (<query-expr>)`
- Compound legs (`<query-expr> UNION [ALL] | INTERSECT | EXCEPT | DIFF <query-expr>`), where
  either leg may itself be a parenthesized query expression (see the set-operation section)
- CTE body (`WITH cte(cols) AS (<query-expr>) …`)
- View body (`CREATE VIEW v[(cols)] AS <query-expr>`)

**RETURNING is required for DML at non-top-level positions.** The outer
position consumes a relation, so a `RETURNING`-less DML is rejected at parse
time outside top-level.

**All five forms run at every relation site**, with one exception: DML
(`INSERT/UPDATE/DELETE … RETURNING`) is rejected as a view body. A view
re-evaluates on every reference, and replaying a write per read is incoherent
with view semantics; the mutation belongs in the statement that references
the view, not in the view body. The rejection fires at view-creation time.

**Run-once + full-drain contract for impure subqueries.** When a DML appears
in scalar / `IN` / `EXISTS` position, the runtime applies two contracts that
do not apply to pure inners:

- **Full drain.** The emitter consumes every row of the inner iterator —
  no short-circuit on first row (`scalar`), on match (`IN`), or on
  `EXISTS = true`. The pure-inner optimization survives unchanged.
- **Run once per statement execution.** If the outer expression is
  re-evaluated (correlated subquery, per-row scan), the inner DML executes
  exactly once and subsequent evaluations replay the memoized result.

Both contracts are gated by `physical.readonly === false` on the inner
subtree, so pure inners are unaffected. See `docs/runtime.md` for the
emitter-level mechanics.

**Conflict resolution does not propagate inward.** An outer
`INSERT OR REPLACE … (insert into inner … returning …)` does not flow its
`OR REPLACE` into the inner DML — each DML carries its own
`onConflict` from its own AST.

**Limitation: per-row DML in an outer DML is not supported.** Expressions
of the form `update outer set x = (insert into inner … returning y)` where
the scalar subquery is evaluated *per row of an outer DML* are not yet
supported. The ordering semantics (does the inner see the outer's mid-flight
writes?) are subtle and the engine errs on the side of refusing rather than
guessing. Use a CTE pre-pass or a two-statement form instead.

**Column naming for unnamed bodies.** When a `VALUES` (or any other form
without explicit projection aliases) appears at a site that binds columns,
the precedence is:

1. Binding-site column list — `(VALUES (…)) AS t(a, b)`, `WITH t(a, b) AS …`,
   `CREATE VIEW v(a, b) AS …` — wins absolutely.
2. Body-supplied names — SELECT/RETURNING aliases or column refs. `VALUES`
   has none.
3. Synthesized fallback — `column_0`, `column_1`, … (today's default).

Persistent named relations (top-level CTE bodies, view bodies) with neither
binding-site nor body-supplied names silently fall back to the synthesized
form; they do **not** error.

### 2.0 Declarative Schema (Optional, Order-Independent)

Quereus keeps traditional DDL fully intact. Declarative schema is an optional alternative for describing the desired end‑state in a single, order‑independent block. Modules continue to use DDL‑based interfaces; declarative workflows operate entirely in the engine and produce DDL.

**Concepts:**
- **Schema**: Named logical grouping of objects; may span multiple modules.
- **Catalog**: The set of objects owned by a module; may span multiple schemas.
- **Diff**: JSON representation of changes needed to align actual state with declared schema.
- **Apply**: Automatic execution of migration DDL statements.

**Key Statements:**

1. `declare schema` – Describes desired end‑state and stores declaration with optional seed data.
2. `diff schema` – Compares declared schema with current state and returns JSON diff.
3. `apply schema` – Executes the generated migration DDL, optionally applying seed data.
4. `explain schema` – Returns the schema content hash for versioning.

#### Declaration Syntax

```sql
declare schema schema_name
  [version 'major.minor.patch']
  [using (default_vtab_module = 'memory', default_vtab_args = '{}')]
{
  -- Tables: use {...} or (...) for column definitions
  table users {
    id integer primary key,
    email text not null unique,
    name text not null,
    created_at text not null default (datetime('now'))
  }
  
  -- Or with explicit USING clause
  table sessions (
    id text primary key,
    user_id integer not null,
    expires_at integer
  ) using memory;

  table roles {
    id integer primary key,
    name text not null unique
  }

  table user_roles (
    user_id integer not null,
    role_id integer not null,
    constraint pk_user_roles primary key (user_id, role_id),
    constraint fk_user foreign key (user_id) references users(id),
    constraint fk_role foreign key (role_id) references roles(id)
  );

  -- Indexes (optional `unique`, optional partial `where`, optional `with tags`)
  index users_email on users(email);
  unique index users_active_email on users(email) where created_at is not null;

  -- Views
  view v_user_roles as
    select u.id as user_id, u.email, r.name as role
    from users u join user_roles ur on u.id = ur.user_id
                 join roles r on ur.role_id = r.id;

  -- Seed data: ( (row1_values), (row2_values), ... )
  seed roles (
    (1, 'admin'),
    (2, 'viewer')
  )
  
  -- Or with explicit column names
  seed users values (id, email, name) values
    (1, 'admin@example.com', 'Admin'),
    (2, 'viewer@example.com', 'Viewer');

  -- Assertions: enforced at commit time
  assertion positive_balance check (not exists (select 1 from users where balance < 0))

  -- Future: domains, collations, and imports
  -- domain email_address as text check (like(value, '%@%'));
  -- collation nocase = nocase();
  -- import schema auth from 'https://example.com/auth-schema.sql' cache 'auth@1' version '^2';
}
```

#### Diffing and Applying

```sql
-- Get migration DDL as result rows (one DDL statement per row)
diff schema main;
-- Returns rows like:
--   {"ddl": "create table users (...)"}
--   {"ddl": "drop table old_table"}
-- Returns no rows if schema is already aligned

-- Execute DDL yourself with custom migration logic
-- TypeScript example:
--   for await (const {ddl} of db.eval('diff schema main')) {
--     console.log('Executing:', ddl);
--     await db.exec(ddl);
--     // Insert custom backfill/transform logic here
--   }

-- Or use apply to execute automatically (no result rows)
apply schema main;

-- Apply with seed data (clears and repopulates)
apply schema main with seed;

-- Get schema hash for versioning
explain schema main;
-- Returns: {"info": "hash:a1b2c3d4e5f6"}

-- Future: versioned apply with options
apply schema main to version '1.0.0' options (
  dry_run = false,
  validate_only = false,
  allow_destructive = false,
  rename_policy = 'require-hint'
);
```

#### Semantics and Features

**Order Independence:**
- Tables, indexes, and views can be declared in any order within the `{...}` block.
- Forward references are allowed (e.g., foreign keys to tables declared later).

**Flexible Syntax:**
- Column definitions accept brace syntax `{...}` or traditional parentheses `(...)`.
- Identifiers are only quoted when they are reserved keywords or contain special characters.

**Schema Diffing:**
- Compares the declared schema against the current database catalog.
- Generates a JSON diff showing tables/views/indexes to create, drop, or alter.
- Produces canonical DDL statements for all required changes.

**Migration Application:**
- `apply schema` executes the migration DDL automatically.
- Migrations are applied in safe order: drops first, then creates, then alters.
- Seed data application: `with seed` clears existing data and inserts declared seed rows.

**Versioning and Hashing:**
- Schema declarations can include semantic versions.
- `explain schema` computes a SHA-256 hash of the canonical schema representation.
- Enables tracking schema changes and ensuring consistency across environments.

**Safety:**
- Seed data application is destructive (clears table before inserting).
- `allow_destructive` is **enforced for one case today**: a backing-module change on a maintained table (`materialized view … using <module>` or `create table … maintained as … using <module>`). Such a move physically relocates the table to a different store with no in-place primitive, so it is realized as a `DROP TABLE` + `create materialized view … using <newmodule>` that **mints a new incarnation** (changing row identity for a replicated/synced table). `apply schema` aborts — before any DDL runs — unless re-run with `options (allow_destructive = true)`:

  ```sql
  -- Re-declared with a moved backing module; refused without the ack:
  apply schema main;
  -- Error: backing-module change on maintained table(s) 'mv' is destructive
  --        (drop + recreate, new incarnation). Re-run with options
  --        (allow_destructive = true) to migrate the backing.

  -- Acknowledged — drops + recreates, re-materializing the body into the new module:
  apply schema main options (allow_destructive = true);
  ```

  `diff schema` surfaces the `DROP TABLE` / `create materialized view` DDL unconditionally (it is a read-only preview, never gated). Other drops are **not yet** gated — a general `allow_destructive` gate over all destructive schema changes remains future work.
- Rename hints prevent accidental drops during renames — see "Rename detection" below.

**Rename detection (`rename_policy`):**

`apply schema` understands rename hints carried via the reserved `quereus.id` and `quereus.previous_name` tags (see §2.6.3). The `rename_policy` option in `OPTIONS (...)` controls how strictly the differ behaves when names change:

| Value | Behavior |
|-------|----------|
| `'allow'` (default) | Use hints when present; without hints, fall through to drop+create. |
| `'require-hint'` | Reject any name change that lacks a hint — if drops *and* creates of the same kind both remain after rename matching, error rather than executing destructive DDL. |
| `'deny'` | Ignore hints entirely. Any name mismatch becomes drop+create. Escape hatch for opting back into the legacy behavior. |

A rename detected via `quereus.id` is authoritative: when both `id` and `previous_name` would resolve, `id` wins. A *conflict* — declared name and the hint resolving to two distinct existing actuals — is always an error regardless of policy.

Renames apply to tables, views, indexes, named constraints (CHECK / UNIQUE / FOREIGN KEY, either table-level `CONSTRAINT <name> ...` or a column-level constraint carrying a name), and columns. Tables and columns rename via the `ALTER TABLE ... RENAME` / `RENAME COLUMN` primitives, which propagate references through dependent CHECK expressions, FK targets, partial-index predicates, view bodies, and materialized-view bodies. Named constraints rename via the `ALTER TABLE ... RENAME CONSTRAINT` primitive. The differ also detects constraint **drops** (a named constraint present in the catalog but absent from the declaration → `DROP CONSTRAINT`) and **adds** (a declared named constraint absent from the catalog → `ADD CONSTRAINT`; CHECK applies in place, UNIQUE / FK adds depend on module support — see §2.7). Only **user-named** constraints participate — engine-synthesized names (the `_check_*` / `_fk_*` / `_uc_*` auto-names for unnamed constraints) and UNIQUE constraints derived from a `CREATE UNIQUE INDEX` are excluded (the latter are managed through their index). View and index renames still fall back to drop+recreate when no rename primitive exists.

**Notes:**
- Keywords `schema`, `version`, and `seed` are contextual and don't conflict with column names or function calls like `schema()`.
- DDL remains the primary interface; declarative schema is a convenience layer that generates DDL.
- Modules are unaware of declarative schemas; they receive standard DDL commands.


### 2.1 SELECT Statement

The select statement retrieves data from one or more tables or views.

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
select [distinct | all] select_expr [, select_expr ...]
[ from table_reference [, table_reference...] ]
[ where condition ]
[ group by expr [, expr...] ]
[ having condition ]
[ order by expr [asc | desc] [, expr [asc | desc]...] ]
[ limit count [offset skip] | limit skip, count ]
[ union [all] select_statement ]
+| [ intersect select_statement ]
+| [ except select_statement ]
+| [ diff select_statement ]
[ with schema schema_name [, schema_name...] ]
```

**Options:**
- `with clause`: Common Table Expressions (CTEs) for temporary named result sets
- `distinct`: Removes duplicate rows from the result set
- `all`: Includes all rows (default behavior)
- `select_expr`: Column expressions to be returned; `*` for all columns. A result column may carry an optional trailing `with inverse (column = expr, ...)` clause supplying authored write-back expressions for updatable-view write-through (see [§2.9](#29-updatable-views))
- `from`: Tables, views, or subqueries to retrieve data from
- `where`: Filters rows based on a condition
- `group by`: Groups rows that have the same values
- `having`: Filters groups based on a condition
- `order by`: Sorts the result set
- `limit/offset`: Restricts the number of rows returned
- `union`/`intersect`/`except`/`diff`: Set operations combining two result sets
- `with schema`: Specifies an ordered search path for resolving unqualified table names (see section 2.1.1)

**Set operations:**
- `union all`: Concatenation (bag semantics)
- `union`: Union with deduplication (set semantics)
- `intersect`: Common rows (set semantics)
- `except`: Rows in left not in right (set semantics)
- `diff`: Symmetric difference = (A except B) union (B except A) (set semantics)

**Parenthesized operands.** A parenthesized query expression `( <query-expr> )` is a
valid operand on **either side** of a set operation, and equally as a view body, CTE body,
or top-level query — so `(select 1) union (select 2)`, `(A union B) union (C union D)`, and
`create view v as (select 1) union (select 2)` all parse. The inner expression is a full
query expression: it may carry its own `WITH`, a nested compound, and its own trailing
`ORDER BY` / `LIMIT` (which bind **inside** the parentheses). Redundant grouping collapses:
`(select 1)` ≡ `select 1`, and a simple `(select 1) union (select 2)` carries the same AST
as the unparenthesized `select 1 union select 2`.

> **Note (associativity):** Parenthesized operands group **as written** (left-associative):
> `(A) union (B) union (C)` evaluates as `(A union B) union C`. Unparenthesized chains keep
> their existing **right-leaning** grouping: `A except B union C` evaluates as
> `A except (B union C)`, not `(A except B) union C`. Parentheses are the escape hatch — use
> them (or CTEs/subqueries) to force a specific left-to-right evaluation order.

#### Set-operation membership columns

Between a set-operation keyword (`union [all]` / `intersect` / `except`) and its right
leg, a compound may expose **membership columns** — a clean `{true,false}` NOT NULL flag
per branch telling you whether the result tuple is a member of that immediate operand of
the binary combinator (the row analogue of the join [existence column](#existence-columns-on-outer-joins)):

```sql
-- which branch(es) did each result row come from?
select id, x, inA, inB
from a union exists left as inA, exists right as inB select id, x from b;
```

- The clause sits **after the operator keyword (and any `all`) and before the right leg**.
  `exists left as <name>` names the leg already parsed before the operator; `exists right
  as <name>` names the operand that follows. Comma-separated; either or both may be
  exposed. `exists` here is **always** followed by `left` / `right` — never `(` — so one-token
  lookahead distinguishes it from the `exists (<subquery>)` predicate (which never legally
  begins a compound leg). This is additive grammar — it occupies previously-unused space and
  breaks nothing.
- Applies to `union` / `union all` / `intersect` / `except`. **Rejected on `diff`** (symmetric
  difference desugars to `(A except B) union (B except A)`, so branch membership is ambiguous
  over the two `except`s).
- The flag is derived **at the combinator** by a per-branch semijoin probe over the operand
  *data* relations (`inA ≡ tuple ∈ A`), never stored in a branch (a stored flag would re-enter
  the union schema and dedup, perturbing set identity). For `union all` the probe is against a
  set, so the flag is the boolean "present ≥ once". `except` reads `inLeft = true, inRight =
  false`; `intersect` reads all flags `true`.
- The binary combinator always names its **own** two operands; the n-way case is covered by
  **nesting** (no global positional "middle branch" naming).
- **Writable (binary, non-nested).** A membership column **is** the branch presence, so
  *writing* it drives the branch's existence — `set inB = true` over a row absent from B
  inserts it into B; `set inB = false` over a row in B deletes the matching B row; **both
  false** removes the row from the view. For `except` (`A except B`), `set inRight = true`
  inserts into B (pushing the row out of the view) and `set inLeft = false` deletes from A;
  for `intersect`, `set inB = false` deletes from B (dropping the row). A membership value
  must be a boolean literal. Data-column writes and `delete from`s **fan out** to every
  branch the row is a member of (via the runtime membership probe); `insert into` routes by
  the supplied flags (a true flag inserts into that branch). `column_info` reports each
  column `is_updatable = 'YES'` with null base (writable through an *effect*, not a base
  mapping). Nested / n-way set-op writes and non-literal membership values are deferred.

**Examples:**
```sql
-- Basic select with where clause
select id, name, age from users where age > 21;

-- Select with join
select u.name, o.product 
  from users as u
  inner join orders as o on u.id = o.userId
  where o.status = 'shipped';

-- Group by with aggregates
select department, count(*) as employeeCount, avg(salary) as avgSalary
  from employees
  group by department
  having count(*) > 5
  order by avgSalary desc;

-- With CTE and union
with active_users as (
  select * from users where status = 'active'
)
  select name, email from active_users where age < 30
  union all
  select name, email from premium_users where subscriptionStatus = 'paid';

-- Symmetric difference (DIFF)
select value from set_a
diff
select value from set_b
order by value;

-- Table equality check using DIFF
select not exists(
  select * from (
    select * from a
    diff
    select * from b
  )
) as tables_equal;

-- Query with explicit schema search path
select * from users, orders
with schema sales, main;
```

#### 2.1.1 Schema Search Path (WITH SCHEMA)

Quereus supports flexible schema resolution through search paths. Unqualified table names are resolved by searching schemas in a specified order.

**Resolution Hierarchy:**
1. **Qualified names** (`schema.table`) - Always used exactly as specified
2. **WITH SCHEMA clause** - Per-query explicit search path
3. **PRAGMA schema_path** - Session-level default search path
4. **Default search order** - `main`, then `temp`

**DDL landing vs. read resolution (deliberate asymmetry):** unqualified DDL (`create table` / `create view` / `create index` / `drop …` / `alter … tags`) lands objects in the **current schema** (`SchemaManager.setCurrentSchema`, an embedder API — there is no SQL surface for it), while unqualified *reads* resolve only via the search path above, which does **not** consult the current schema. An embedder that sets a non-`main` current schema must also set `schema_path` (or qualify references); otherwise objects it creates are invisible to unqualified reads. Pure-SQL users are unaffected — the current schema is always `main` unless an embedder changes it.

**WITH SCHEMA Syntax:**
```sql
SELECT ... FROM table1, table2
WITH SCHEMA schema1, schema2, schema3;
```

The `WITH SCHEMA` clause specifies an ordered list of schemas to search when resolving unqualified table names. The first schema containing a matching table is used.

**Examples:**

```sql
-- Explicitly search sales schema, then main
SELECT * FROM orders, customers
WITH SCHEMA sales, main;
-- If 'orders' exists in 'sales', uses sales.orders
-- If 'customers' only exists in 'main', uses main.customers

-- Works with CTEs
-- Note: WITH SCHEMA applies only to the outer query.
-- The CTE (recent_orders) uses the connection/database default schema path.
WITH recent_orders AS (
  SELECT * FROM orders WHERE date > date('now', '-7 days')
)
SELECT * FROM recent_orders
WITH SCHEMA sales, archive, main;

-- To apply schema path to the CTE query itself, use a nested WITH SCHEMA:
WITH recent_orders AS (
  SELECT * FROM orders WHERE date > date('now', '-7 days')
  WITH SCHEMA sales, archive
)
SELECT * FROM recent_orders;

-- DML operations also support WITH SCHEMA
UPDATE inventory SET quantity = quantity - 1
WHERE sku = 'ABC123'
WITH SCHEMA warehouse, main;

INSERT INTO logs (message) VALUES ('Order processed')
WITH SCHEMA audit, main
RETURNING id;

DELETE FROM temp_data WHERE expired = 1
WITH SCHEMA workspace, main;
```

**Error Messages:**

When a table is not found, Quereus provides helpful diagnostics:

```sql
-- Table not in search path
SELECT * FROM products WITH SCHEMA sales, finance;
-- Error: Table 'products' not found in schema path: sales, finance
--        Did you mean 'main.products'?
--        Or add 'main' to your schema path?

-- Table doesn't exist anywhere
SELECT * FROM nonexistent WITH SCHEMA main, sales;
-- Error: Table 'nonexistent' not found in schema path: main, sales
```

**Best Practices:**

- Use qualified names (`schema.table`) when you need precision
- Use `WITH SCHEMA` for cross-schema queries without qualification
- Set `PRAGMA schema_path` for session-wide defaults
- Default to `main` schema for simple, single-schema applications

**Order Independence:**

The `WITH CONTEXT` and `WITH SCHEMA` clauses can appear in any order:

```sql
-- Both are valid:
INSERT INTO table VALUES (...) WITH CONTEXT (x = 1) WITH SCHEMA sales;
INSERT INTO table VALUES (...) WITH SCHEMA sales WITH CONTEXT (x = 1);

UPDATE table SET col = val WITH SCHEMA main WITH CONTEXT (x = 1);
DELETE FROM table WHERE id = 1 WITH CONTEXT (x = 1) WITH SCHEMA main;
```

### 2.2 INSERT Statement

The insert statement adds new rows to a table. The target may also be an updatable view, non-recursive CTE, or subquery in `from` — see [§2.9 Updatable Views](#29-updatable-views).

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
  insert [or conflict_resolution] into table_name [(column [, column...])]
  { values (expr [, expr...]) [, (expr [, expr...])]... | select_statement }
  [ with context (variable = expr [, ...]) ]
  [ with schema schema_name [, schema_name...] ]
  [ returning [qualifier.]expr [, [qualifier.]expr...] ]

conflict_resolution:
  rollback | abort | fail | ignore | replace

upsert_clause:
  on conflict [ (column [, column ...]) ] do nothing
  | on conflict [ (column [, column ...]) ] do update set assignment [, assignment ...] [ where condition ]

assignment:
  column = expression
```

**Options:**
- `with clause`: Common Table Expressions for use in the insert
- `or conflict_resolution`: Specifies how to handle constraint conflicts (see Conflict Resolution below)
- `table_name`: Target table for the insertion
- `column`: Optional list of columns to insert into
- `values`: A list of value sets to insert
- `select_statement`: A select query whose results are inserted
- `upsert_clause`: Specifies how to handle conflicts with fine-grained control (see UPSERT below)
- `with context`: Provides table-level parameters for defaults and constraints (see section 2.6.2)
- `with schema`: Specifies schema search path for resolving table names (see section 2.1.1)
- `returning`: Returns specified expressions from the inserted rows (supports NEW qualifier)

**Conflict Resolution (OR clause):**

When inserting a row that would violate a `UNIQUE`, `PRIMARY KEY`, `NOT NULL`, `CHECK`, or `FOREIGN KEY` constraint, the `OR` clause specifies how to handle the conflict:

- **`OR ROLLBACK`**: Abort the current statement *and* automatically roll back the enclosing transaction (implicit or explicit). Any prior writes inside the transaction are discarded.
- **`OR ABORT`**: Abort the current statement (default behavior). In autocommit mode the implicit transaction rolls back; inside an explicit transaction the prior writes are preserved (you must `ROLLBACK` manually if you want them undone).
- **`OR FAIL`**: Abort the current statement but commit prior rows of the same statement that succeeded before the violation. Inside an explicit transaction those rows simply remain in the pending transaction.
- **`OR IGNORE`**: Silently skip the row that would cause a conflict and continue with the next row.
- **`OR REPLACE`**: For `UNIQUE`/`PRIMARY KEY` conflicts, delete the existing row and insert the new one (destructive—loses unspecified column values). For `NOT NULL` conflicts, substitute the column's `DEFAULT` value if one is declared (otherwise behaves like `ABORT`). `CHECK` and foreign-key constraints are *not* relaxed by `REPLACE` — those still abort.

**Per-constraint defaults.** A column- or table-level constraint may carry its own `ON CONFLICT <action>` clause:

```sql
create table products (
  sku text primary key on conflict ignore,           -- duplicate INSERTs silently skipped
  name text not null on conflict ignore,             -- NULL name → row skipped
  price real check (price > 0) on conflict ignore,   -- non-positive price → row skipped
  email text unique on conflict replace              -- duplicate email → existing row replaced
);
```

The action precedence is: **statement-level OR clause > per-constraint default > ABORT**. So `INSERT OR ABORT INTO products ...` overrides every column-level directive above.

**Note:** The `OR` clause and `ON CONFLICT DO ...` clause are mutually exclusive. Use `OR REPLACE` for simple full-row replacement, and `ON CONFLICT DO UPDATE` for surgical column-level updates.

**INSERT only.** The `OR <action>` clause is **only accepted on `INSERT`**. Quereus does not support SQLite's `UPDATE OR <action>` (or `DELETE OR <action>`) per-statement override — that syntax has no precedent outside SQLite (Postgres, SQL Server, MySQL, Oracle, and ANSI SQL all lack it). For UPDATE conflict handling, use the schema-level `ON CONFLICT <action>` declared on the constraint, or rewrite the UPDATE with `WHERE NOT EXISTS (...)` / explicit `DELETE` + `UPDATE` inside a transaction.

#### UPSERT (ON CONFLICT clause)

The `ON CONFLICT` clause provides fine-grained control over conflict handling, allowing you to update specific columns rather than replacing the entire row.

**Syntax:**
```sql
insert into table_name (columns) values (...)
  on conflict [ (conflict_columns) ] do nothing | do update set assignments [ where condition ]
```

**Conflict Target:**
- `ON CONFLICT (col1, col2, ...)` — Specifies which unique constraint to match. The columns must correspond to a PRIMARY KEY or UNIQUE constraint.
- `ON CONFLICT` (without columns) — Matches any unique constraint violation.

**Actions:**
- `DO NOTHING` — Silently skip the conflicting row (equivalent to `INSERT OR IGNORE`)
- `DO UPDATE SET col = expr, ...` — Update specific columns on the existing row

**Referencing Values:**
- `NEW.column` or `excluded.column` — References the value that was proposed for insertion (PostgreSQL compatibility via `excluded`)
- `column` or `table.column` — References the current value in the existing row
- The `WHERE` clause can use both to conditionally apply updates

**Key Differences from OR REPLACE:**

| Feature | `INSERT OR REPLACE` | `ON CONFLICT DO UPDATE` |
|---------|---------------------|-------------------------|
| Behavior | Deletes existing row, inserts new | Updates existing row in place |
| Unspecified columns | Lost (reset to defaults) | Preserved |
| Conditional update | Not supported | Supported via `WHERE` |
| Column-level control | No | Yes |
| Triggers | DELETE + INSERT | UPDATE |

**Examples:**
```sql
-- Basic insert with explicit columns
insert into users (name, email, age) values ('John', 'john@example.com', 35);

-- Multiple rows insert
insert into products (name, price, category) 
  values 
    ('Keyboard', 49.99, 'Electronics'),
    ('Mouse', 29.99, 'Electronics'),
    ('Headphones', 99.99, 'Audio');

-- Insert from select
insert into active_users (id, name, email)
  select id, name, email from users where last_login > date('now', '-30 days');

-- INSERT with RETURNING clause
insert into users (name, email) 
  values ('Alice', 'alice@example.com')
  returning id, name, datetime('now') as created_at;

-- INSERT with RETURNING used in a larger query
select 'User created: ' || new_user.name as message
from (
  insert into users (name, email) 
  values ('Bob', 'bob@example.com')
  returning name
) as new_user;

-- With CTE
with recent_orders as (
  select * from orders where order_date > date('now', '-7 days')
)
  insert into order_summary (order_id, customer, total)
    select id, customer_name, sum(price * quantity) 
    from recent_orders
    group by id, customer_name
    returning order_id, total;

-- INSERT OR REPLACE (full row replacement)
insert or replace into users (id, name, email, updated_at)
  values (1, 'Alice', 'alice@example.com', datetime('now'));
-- If a user with id=1 exists, it is DELETED and replaced; otherwise, a new row is inserted
-- WARNING: Any columns not in the insert list are reset to defaults!

-- INSERT OR IGNORE (skip conflicts)
insert or ignore into tags (name)
  values ('javascript'), ('typescript'), ('javascript');
-- Only inserts 'javascript' and 'typescript' once, skipping the duplicate

-- UPSERT: Insert or update specific columns (preserves other columns)
insert into users (id, name, email)
  values (1, 'Alice', 'alice@example.com')
  on conflict (id) do update set
    name = NEW.name,
    email = NEW.email;
-- If id=1 exists, updates only name and email; other columns (like created_at) are preserved

-- UPSERT with increment pattern
insert into vocabulary (word, count)
  values ('hello', 1)
  on conflict (word) do update set
    count = count + 1;
-- Inserts with count=1, or increments existing count

-- UPSERT with conditional update (only update if newer)
insert into documents (id, content, version)
  values (100, 'new content', 5)
  on conflict (id) do update set
    content = NEW.content,
    version = NEW.version
  where NEW.version > version;
-- Only updates if the new version is greater than existing

-- UPSERT with DO NOTHING (same as INSERT OR IGNORE)
insert into tags (name)
  values ('javascript'), ('typescript'), ('javascript')
  on conflict (name) do nothing;

-- UPSERT on composite key
insert into user_roles (user_id, role_id, granted_at)
  values (1, 2, datetime('now'))
  on conflict (user_id, role_id) do update set
    granted_at = NEW.granted_at;

-- Multiple ON CONFLICT clauses (evaluated in order)
insert into products (id, sku, name, price)
  values (1, 'ABC123', 'Widget', 9.99)
  on conflict (id) do update set name = NEW.name, price = NEW.price
  on conflict (sku) do update set price = NEW.price;
-- First matching conflict target wins

-- UPSERT with RETURNING
insert into counters (key, value)
  values ('page_views', 1)
  on conflict (key) do update set value = value + 1
  returning key, value, 
    case when value = NEW.value then 'inserted' else 'updated' end as action;
```

### 2.3 UPDATE Statement

The update statement modifies existing rows in a table. The target may also be an updatable view, non-recursive CTE, or subquery in `from` — see [§2.9 Updatable Views](#29-updatable-views).

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
  update table_name
    set column = expr [, column = expr...]
    [ where condition ]
    [ with context (variable = expr [, ...]) ]
    [ with schema schema_name [, schema_name...] ]
    [ returning [qualifier.]expr [, [qualifier.]expr...] ]
```

**Options:**
- `with clause`: Common Table Expressions for use in the update
- `table_name`: Table to be updated
- `set`: Column assignments with new values
- `where`: Optional condition to specify which rows to update
- `with context`: Provides table-level parameters for defaults and constraints (see section 2.6.2)
- `with schema`: Specifies schema search path for resolving table names (see section 2.1.1)
- `returning`: Returns specified expressions from the updated rows (supports OLD and NEW qualifiers)

**Examples:**
```sql
-- Simple update
update users set status = 'inactive' where last_login < date('now', '-90 days');

-- Multi-column update with RETURNING
update products 
  set price = price * 1.1, 
      updated_at = datetime('now')
  where category = 'Electronics'
  returning id, name, price, updated_at;

-- Update with OLD and NEW qualifiers
update employees 
  set salary = salary * 1.05 
  where performance_rating >= 4
  returning id, OLD.salary as old_salary, NEW.salary as new_salary, 
           (NEW.salary - OLD.salary) as increase;

-- UPDATE with RETURNING clause
update users 
  set last_login = datetime('now')
  where id = 42
  returning id, name, last_login;

-- UPDATE with RETURNING used as table source
select 'Updated: ' || updated.name || ' to ' || updated.new_status as message
from (
  update users 
  set status = 'premium', updated_at = datetime('now')
  where subscription_type = 'paid'
  returning name, status as new_status
) as updated;

-- Update with expression
update orders
  set 
    total = (select sum(price * quantity) from order_items where order_id = orders.id),
    status = case 
      when paid = 1 then 'completed' 
      else 'pending' 
    end
  where order_date > date('now', '-30 days')
  returning id, OLD.status, NEW.status, NEW.total;

-- With CTE
with discounted_items as (
  select product_id, price * 0.8 as sale_price
  from products
  where category = 'Clearance'
)
  update products
    set price = di.sale_price
    from discounted_items as di
    where products.id = di.product_id
    returning id, OLD.price as original_price, NEW.price as sale_price;
```

### 2.4 DELETE Statement

The delete statement removes rows from a table. The target may also be an updatable view, non-recursive CTE, or subquery in `from` — see [§2.9 Updatable Views](#29-updatable-views).

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
delete from table_name
[ where condition ]
[ with context (variable = expr [, ...]) ]
[ with schema schema_name [, schema_name...] ]
[ returning [qualifier.]expr [, [qualifier.]expr...] ]
```

**Options:**
- `with clause`: Common Table Expressions for use in the delete
- `table_name`: Table to delete from
- `where`: Optional condition to specify which rows to delete
- `with context`: Provides table-level parameters for defaults and constraints (see section 2.6.2)
- `with schema`: Specifies schema search path for resolving table names (see section 2.1.1)
- `returning`: Returns specified expressions from the deleted rows (supports OLD qualifier)

**Examples:**
```sql
-- Simple delete
delete from users where status = 'deactivated';

-- DELETE with RETURNING clause
delete from users 
  where last_login < date('now', '-365 days')
  returning id, name, email;

-- DELETE with RETURNING used for audit logging
insert into deleted_users_audit (user_id, name, deleted_at)
select deleted.id, deleted.name, datetime('now')
from (
  delete from users 
  where status = 'spam'
  returning id, name
) as deleted;

-- Delete with subquery
delete from products
  where id in (
    select product_id 
    from inventory 
    where stock = 0 and last_updated < date('now', '-180 days')
  )
  returning id, name, category;

-- With CTE
with old_orders as (
  select id from orders where order_date < date('now', '-365 days')
)
  delete from order_items
  where order_id in (select id from old_orders);
```

### 2.5 RETURNING Clause with NEW/OLD Qualifiers

The RETURNING clause allows you to retrieve values from rows that were inserted, updated, or deleted in a DML operation. Quereus supports NEW and OLD qualifiers to distinguish between original and modified values.

**Syntax:**
```sql
returning result_column [, result_column...]

result_column:
  { * | [qualifier.]column_name | expression } [ [ as ] alias ]

qualifier:
  { NEW | OLD }
```

#### 2.5.1 Operation-Specific Rules

**INSERT Operations:**
- `NEW`: References the inserted values ✅
- `OLD`: Not allowed (will cause error) ❌
- Unqualified columns: Default to NEW values

**UPDATE Operations:**
- `NEW`: References the updated values ✅
- `OLD`: References the original values before update ✅
- Unqualified columns: Default to NEW values

**DELETE Operations:**
- `OLD`: References the deleted values ✅
- `NEW`: Not allowed (will cause error) ❌
- Unqualified columns: Default to OLD values

#### 2.5.3 Advanced RETURNING Examples

**Audit Trail with UPDATE:**
```sql
-- Track all changes for audit purposes
update customer_profiles 
  set email = 'new.email@example.com', phone = '555-0123'
  where customer_id = 42
  returning 
    customer_id,
    OLD.email as old_email,
    NEW.email as new_email,
    OLD.phone as old_phone,
    NEW.phone as new_phone,
    datetime('now') as changed_at;
```

**Calculating Differences:**
```sql
-- Calculate price changes
update inventory 
  set quantity = quantity - 5, last_updated = datetime('now')
  where product_id in (101, 102, 103)
  returning 
    product_id,
    OLD.quantity as stock_before,
    NEW.quantity as stock_after,
    OLD.quantity - NEW.quantity as items_sold,
    NEW.last_updated;
```

**Conditional RETURNING with CASE:**
```sql
-- Conditional logic in RETURNING clause
update user_accounts 
  set login_attempts = login_attempts + 1
  where username = 'user123'
  returning 
    user_id,
    username,
    NEW.login_attempts,
    case 
      when NEW.login_attempts >= 5 then 'LOCKED'
      when NEW.login_attempts >= 3 then 'WARNING'
      else 'NORMAL'
    end as account_status,
    case
      when OLD.login_attempts < 3 and NEW.login_attempts >= 3 then 'Security alert triggered'
      else 'Login attempt recorded'
    end as message;
```

### 2.6 CREATE TABLE Statement

The create table statement defines a new table structure.  Note that all tables are "without rowid" implicitly.

**Syntax:**
```sql
create table [if not exists] table_name (
  column_definition [, column_definition...]
  [, table_constraint...]
)
[using module_name [(module_args...)]]
[with tags (key = value [, ...])]
```

**Column Definition:**
```sql
column_name [data_type] [column_constraint...] [with tags (key = value [, ...])]
```

**Column Constraints:**
```sql
[constraint name]
{ primary key [asc | desc] [conflict_clause] [autoincrement]
| not null [conflict_clause]
| unique [conflict_clause]
| check [on {insert | update | delete}[,...]] (expr)
| default value
| collate collation_name
| references foreign_table [(column[,...])] [ref_actions]
| generated always as (expr) [stored | virtual] }
[with tags (key = value [, ...])]
```

**Table Constraints:**
```sql
[constraint name]
{ primary key ([column [asc | desc][,...]]) [conflict_clause]
| unique (column[,...]) [conflict_clause]
| check [on {insert | update | delete}[,...]] (expr)
| foreign key (column[,...]) references foreign_table [(column[,...])] [ref_actions] }
[with tags (key = value [, ...])]
```

**Conflict Clause:**
```sql
on conflict { rollback | abort | fail | ignore | replace }
```

**Options:**
- If an empty key column list is provided, the table may have 0 or 1 rows.
- `if not exists`: Creates the table only if it doesn't already exist
- `column_definition`: Defines a column with optional constraints
- `table_constraint`: Defines a table-level constraint
- `using module_name`: Specifies a virtual table module

**Examples:**
```sql
-- Basic table with constraints
create table employees (
  id integer primary key,
  name text not null,
  email text unique collate nocase,
  department text default 'General',
  salary real check (salary >= 0),
  hire_date text,
  manager_id integer references employees(id)
);

-- Table with composite key and multiple constraints
create table order_items (
  order_id integer,
  product_id integer,
  quantity integer not null check on insert (quantity > 0),
  price real not null check (price >= 0),
  discount real default 0 check (discount >= 0 and discount <= 1),
  primary key (order_id, product_id),
  foreign key (order_id) references orders(id),
  foreign key (product_id) references products(id)
);

-- Memory-backed virtual table
create table cache (
  key text primary key,
  value blob,
  expires_at integer
) using memory;

-- Table with generated (computed) columns
create table products (
  id integer primary key,
  base_price integer not null,
  tax_rate real not null default 0.1,
  total_price real generated always as (base_price * (1 + tax_rate)) stored,
  label text generated always as ('Product #' || id) virtual
);
```

**Generated Columns:**

Generated columns are computed from an expression over other columns in the same row:

- `STORED`: The value is computed at INSERT/UPDATE time and persisted. Reads return the stored value directly.
- `VIRTUAL`: Semantically computed on read (currently stored identically to STORED; storage optimization is planned).
- If neither `STORED` nor `VIRTUAL` is specified, `VIRTUAL` is the default.
- Generated column expressions must be deterministic. They may reference any column of the same table, including other generated columns; their dependency graph must be acyclic and self-references are rejected at `CREATE TABLE` / `ALTER TABLE ADD COLUMN` time.
- Cannot have both `DEFAULT` and `GENERATED ALWAYS AS` on the same column.
- Cannot INSERT into or UPDATE a generated column directly.
- `ALTER TABLE ... DROP COLUMN` of a column referenced by another generated column's expression is rejected; drop the referencing generated column first.

**CHECK Constraints:**

- `check (expr)` is enforced on INSERT and UPDATE by default; `check on {insert | update | delete}[,...]` restricts the operations. Unqualified columns name the NEW row (the OLD row for DELETE-only checks); `old.<col>` / `new.<col>` reference either row image explicitly.
- Comparisons inside a CHECK resolve **declared column collations** (and explicit `COLLATE` wrappers), exactly like the same expression in a query — `check (c = 'abc')` over a `text collate nocase` column accepts any case-variant. Resolution follows the engine's symmetric provenance lattice (explicit `COLLATE` > declared column collation > defaulted collation > BINARY; see `docs/types.md` § Comparison collation resolution), so `check (b = c)` and `check (c = b)` behave identically.
- A CHECK containing a subquery is automatically deferred to transaction commit; the deferred evaluation runs the same compiled predicate, so collation semantics are identical to the immediate path.

**Default Values:**

A column `DEFAULT` supplies the value when an INSERT omits the column; an explicitly supplied value always wins. The expression must be deterministic and may not reference bind parameters.

- A default may read a sibling **the INSERT supplies** via `new.<column>` — e.g. `slug text default (lower(new.title))` or `total integer default (new.subtotal + tax)`. Only INSERT-supplied columns are visible, so a default never depends on another column's default (which would impose an evaluation-order race); referencing an omitted column raises a resolution error. The same `new.<column>` surface also resolves at the **shared-key view-write envelope** (an anchor key default reading a supplied sibling — see [View Updateability § Mutation context](view-updateability.md#mutation-context)).
- A **bare** (unqualified) column reference is rejected at `CREATE TABLE` — use `new.<column>` to read a supplied value, or `GENERATED ALWAYS AS` to compute from any sibling. (With a `with context (...)` clause an unqualified identifier may instead resolve to a mutation-context variable.)
- `mutation_ordinal()` (the 1-based per-row ordinal) and mutation-context variables are also available in default position. See [View Updateability § Mutation context](view-updateability.md#mutation-context).
- `ALTER TABLE … ALTER COLUMN … SET DEFAULT` routes the new default through the **same** validator `CREATE TABLE` uses: bind parameters / bare columns / non-deterministic expressions are rejected at `ALTER` time, and a `new.<column>` default is accepted (its build is deferred to INSERT time, exactly as on `CREATE TABLE`). `DROP DEFAULT` clears the default.
- `ALTER TABLE … ADD COLUMN … DEFAULT (…)` accepts the same default expressions (the shared validator rejects bind parameters / bare columns / non-determinism). Existing rows are **backfilled per row**: `new.<column>` resolves to the *existing* row's sibling (e.g. `add column doubled integer default (new.base * 2)` sets each existing row's `doubled` from its own `base`), while a literal default is bulk-written. Future inserts derive the column from the INSERT-supplied sibling, so an insert that omits that sibling raises the same resolution error as the single-source path. An `ADD COLUMN NOT NULL` whose per-row backfill yields NULL for any existing row is rejected and the column is not added.

### 2.6.1 CREATE/DROP ASSERTION (Global Integrity Constraints)

Quereus supports database-wide integrity assertions evaluated at COMMIT time.

Syntax:
```sql
create assertion assertion_name check (condition_expression);
drop assertion assertion_name;
```

Behavior:
- Assertions are enforced at COMMIT. Any row produced by the stored violation query indicates a violation and the COMMIT fails with a constraint error (transaction rolled back).
- The `check (expr)` is stored as a violation SQL: `select 1 where not (expr)`.
- Efficiency: The optimizer classifies each table reference instance in the violation query as row-specific (unique key fully covered) or global. If any changed base is global, run the violation SQL once. Otherwise, for row-specific references, the engine executes per changed primary key using prepared parameters (`pk0`, `pk1`, ... for composite keys), early-exiting on the first violation.

Diagnostics:
- Use `explain_assertion(name)` to introspect classification and prepared parameterization.

Examples:
```sql
-- Global-style assertion (aggregate)
create table t2 (id integer primary key) using memory;
create assertion a_global check ((select count(*) from t2) = (select count(*) from t2));
select exists(
  select 1 from explain_assertion('a_global') where classification = 'global'
) as ok;

-- Row-specific assertion: PK equality reduces to row-specific
create table t1 (id integer primary key) using memory;
create assertion a_row check (exists (select 1 from t1 where id = 1));
select prepared_pk_params from explain_assertion('a_row') where classification = 'row' limit 1;
```

### 2.6.2 Mutation Context (Table-Level Parameters)

Quereus supports table-level mutation context variables that provide per-operation parameters for default values and constraints. The primary use case is implementing application-specific security, rights management, and audit mechanisms using signatures, digests, and cryptographic verification.

**Syntax:**
```sql
create table table_name (
  column_definitions...
) using module_name
with context (
  variable_name data_type [null],
  ...
)
```

**DML Syntax:**
```sql
insert into table_name [(columns...)]
with context variable = expression, ...
values (...) | select_statement

update table_name
with context variable = expression, ...
set column = value ...

delete from table_name
with context variable = expression, ...
where condition
```

**Key Features:**
- Context variables are declared in the table definition alongside columns
- Variables default to NOT NULL unless explicitly marked NULL
- Both unqualified (`varName`) and qualified (`context.varName`) references supported
- Context variables can be used in DEFAULT expressions and CHECK constraints
- Context values are evaluated once per statement, not per row
- Context is captured for deferred constraints and evaluated at COMMIT time

**Examples:**

**Multi-Tenant Data Isolation:**
```sql
-- Enforce tenant isolation at database level
create table tenant_records (
  id integer primary key,
  tenant_id text,
  data text,
  constraint tenant_check check (new.tenant_id = context.current_tenant_id)
) using memory
with context (
  current_tenant_id text
);

-- Insert restricted to current tenant
insert into tenant_records (id, tenant_id, data)
with context current_tenant_id = 'tenant_abc'
values (1, 'tenant_abc', 'Private data');  -- Passes

-- Attempt to insert for different tenant fails
insert into tenant_records (id, tenant_id, data)
with context current_tenant_id = 'tenant_abc'
values (2, 'tenant_xyz', 'Data');  -- Fails: tenant mismatch
```

**Audit Trail with Actor Tracking:**
```sql
-- Audit log with actor identity
create table audit_log (
  id integer primary key,
  action text,
  user_id text default actor_id,
  timestamp text default datetime('now')
) using memory
with context (
  actor_id text
);

-- Log action with actor identity
insert into audit_log (id, action)
with context actor_id = 'user123'
values (1, 'DELETE_RECORD');
```

**Permission Verification:**
```sql
-- Prevent unauthorized modifications
create table user_profiles (
  user_id integer primary key,
  email text,
  constraint update_auth check (
    context.requester_id = old.user_id or context.is_admin = 1
  )
) using memory
with context (
  requester_id integer,
  is_admin integer
);

-- User can update their own profile
update user_profiles
with context requester_id = 42, is_admin = 0
set email = 'newemail@example.com'
where user_id = 42;  -- Passes: requester_id matches
```

**Best Practices:**
- Use mutation context for application-specific security and access control
- Implement signature verification, digest validation, and rights checking in constraints
- Store actor identity, timestamps, and cryptographic proofs in defaults
- Use qualified `context.varName` for clarity when variable names might conflict
- Mark optional context variables as NULL
- Combine with user-defined functions for custom verification logic
- Context is required when defaults or constraints reference context variables

### 2.6.3 Metadata Tags

Quereus supports arbitrary key-value metadata tags on schema objects via `WITH TAGS`. Tags are informational only -- the engine does not derive behavior from them. They do not affect schema hashing.

**Syntax:**
```sql
-- Table-level tags
create table Orders (
  id integer primary key,
  name text not null
) with tags (display_name = 'Customer Orders', audit = true);

-- Column-level tags
create table Products (
  id integer primary key with tags (display_name = 'Product ID'),
  name text not null with tags (searchable = true)
);

-- Constraint-level tags
create table Employees (
  id integer primary key,
  email text not null,
  constraint uq_email unique (email) with tags (error_message = 'Email must be unique')
);

-- View and index tags
create view ActiveUsers as select * from Users where active = 1
  with tags (cacheable = true);

create index idx_name on Products (name) with tags (purpose = 'search optimization');
```

Tag values can be strings, numbers, booleans (`true`/`false`), or `null`. Tag keys are identifiers. `TAGS` is a contextual keyword and can still be used as a regular identifier. `WITH TAGS` can appear alongside `WITH CONTEXT` in any order.

Tags are available on the schema interfaces (`TableSchema.tags`, `ColumnSchema.tags`, etc.) and via the programmatic API (`SchemaManager.getTableTags()`, `SchemaManager.setTableTags()`, `SchemaManager.setColumnTags()`, `SchemaManager.setConstraintTags()`). Tags set at `CREATE` time can be changed later from SQL with `ALTER TABLE … SET TAGS` (whole-set replacement; see [§2.7](#27-alter-table-statement)).

**Reserved namespace `quereus.*`:** keys whose name starts with `quereus.` are reserved for the engine and validated against a typed registry (`src/schema/reserved-tags.ts`). The two most common keys, both rename hints, are:

| Key | Used by | Effect |
|-----|---------|--------|
| `"quereus.id"` | `apply schema` / `diff schema` | Stable identifier — when a declared and actual object share the same `quereus.id` but have different names, the differ emits a rename instead of a drop+create. Authoritative; wins over `previous_name`. |
| `"quereus.previous_name"` | `apply schema` / `diff schema` | One or more comma-separated old names. The differ matches a declared object whose name is missing in the catalog against an actual object whose name appears in this list. |

This is only a subset; other reserved keys include `quereus.expose_implicit_index` and the `quereus.lens.*` family (see the registry for the full set). An **unrecognized or mis-sited** `quereus.*` key is a **hard error** — rejected loudly at plan-build on every authoring path (`CREATE TABLE` / `CREATE INDEX … WITH TAGS`, `ALTER … SET TAGS`, statement-level DML `WITH TAGS` (`INSERT`/`UPDATE`/`DELETE`), and `apply schema` / `diff schema`) rather than silently stored — so a typo (`quereus.idd`) or a view-only key on a physical table fails the statement. Note that **no** reserved key is currently legal at the DML-statement site — the namespace there is purely a typo guard (since the `quereus.update.*` retirement, every `quereus.*` key on a DML statement is rejected, whether the statement targets a base table or a view). Tag keys with dots must use the quoted-identifier form (`"quereus.id"`). Non-reserved (free-form) keys outside the `quereus.*` namespace are accepted untouched.

Example — declaring a renamed table and column:

```sql
declare schema main {
  table customer with tags (
    "quereus.id" = 'tbl-customer',
    "quereus.previous_name" = 'client'
  ) {
    customer_id integer primary key with tags ("quereus.previous_name" = 'client_id'),
    full_name text not null with tags ("quereus.previous_name" = 'name')
  }
}
```

Against an existing `client(client_id, name)`, this diffs to `ALTER TABLE client RENAME TO customer` plus two `ALTER TABLE customer RENAME COLUMN ...` rather than dropping and recreating.

### 2.7 ALTER TABLE Statement

Modifies an existing table's structure or name.

**RENAME TABLE**

```sql
ALTER TABLE old_name RENAME TO new_name;
```

Renames a table. The old name becomes invalid immediately. Fails if the new name already exists. References to the old name in dependent objects are rewritten in place: CHECK expressions on every table in the schema, FOREIGN KEY `referencedTable` entries (across all schemas), partial-index `WHERE` predicates (a table-qualified self-reference like `where t.active = 1` follows the rename, including in the derived UNIQUE constraint of a unique partial index, which shares the predicate AST), view bodies (`selectAst` and the cached `sql` text), view/MV `with defaults` clauses (now stored inside the body select, so an expr subquery referencing the renamed table is rewritten by the body walk — a clause-only rewrite still fires the modified event), and materialized-view bodies (which additionally re-key their derived fields and re-register row-time maintenance, staying live — see [materialized-views.md § Rename propagation](materialized-views.md#rename-propagation-mv--faster-view)). The rewrite is best-effort AST replacement — a CTE that intentionally shadowed the old name is not preserved.

**RENAME COLUMN**

```sql
ALTER TABLE table_name RENAME COLUMN old_col TO new_col;
```

Renames a column. Data is preserved. Fails if the new name conflicts with an existing column or the old name doesn't exist. As with `RENAME TABLE`, references in CHECK expressions, FOREIGN KEY `referencedColumnNames`, partial-index `WHERE` predicates (unqualified and table-qualified refs on the renamed table, resolved against the indexed table the same way an implicit CHECK seed is; the derived UNIQUE constraint of a unique partial index shares the rewritten AST), view bodies, view/MV `with defaults` clauses (stored inside the body select; the clause's target names a base column of the view's FROM table — usually projected away — and rewrites via the same scope-aware synthetic-probe path a `with inverse` target uses, so a clause-only rewrite still fires the modified event; expr subqueries rewrite scope-aware — see [view-updateability.md § View defaults](view-updateability.md#view-defaults)), and materialized-view bodies (a bare passthrough projection's exposed output name follows the rename, carried onto the backing table in place — see [materialized-views.md § Rename propagation](materialized-views.md#rename-propagation-mv--faster-view)) are propagated. Inside dependent SELECTs the rewrite follows scope: unqualified column references resolve when the renamed table (or a CTE that re-exposes the renamed column under the same name) is in the unaliased FROM scope; qualified references resolve via the alias map. A CTE re-exposes the renamed column when it has no explicit column list (`with c as ...` not `with c(x) as ...`) and at least one result column is a passthrough of the renamed column (an unaliased `select k`, `t.k`, or `select *` from the renamed table).

**ADD COLUMN**

```sql
ALTER TABLE table_name ADD COLUMN col_name type [constraints];
```

Adds a new column to the table. Existing rows are backfilled with the column's DEFAULT value (or NULL if no default). A literal default is bulk-written to every existing row; a non-foldable expression default (including one that reads `new.<column>`) is evaluated **per existing row** — `new.<column>` resolves to that row's own sibling value (the existing-row backfill semantics described under *Default Values* above). Restrictions:

- Cannot add a PRIMARY KEY column.
- Cannot add a NOT NULL column without a DEFAULT if the table has existing rows — unless the table's module advertises the `delegatesNotNullBackfill` capability, in which case the engine skips this pre-check and the module's `alterTable` owns the decision (intended for structurally-total modules that carry pre-existing rows forward and enforce NOT NULL at write time going forward). Native modules (memory, store) leave the capability off, so this restriction applies to them. A NOT NULL column *with* a per-row default whose backfill yields NULL for some existing row is likewise rejected (after backfill), and the column add is reverted.
- Cannot add a column with **both** a non-foldable (per-row) DEFAULT and a CHECK constraint on the new column — this combination is not yet supported, because the per-row backfill is not validated against the CHECK (the literal-default + CHECK path *is* validated and reverts on violation). Add the column first, then add the CHECK separately, or use a literal DEFAULT.

A column-level **UNIQUE** declared inline on the new column (`ADD COLUMN col … UNIQUE`, named or unnamed) is materialized and enforced via the **same** module path as `ALTER TABLE ADD CONSTRAINT … UNIQUE`: once the column is materialized it routes through the module's `addConstraint`, which builds (or reuses) the covering structure, **re-validates the backfilled values** — failing atomically with `CONSTRAINT` and reverting the column if a literal DEFAULT produces a duplicate across existing rows — and persists for store-backed tables. NULLs are distinct, so existing rows backfilled with NULL never collide, and a named inline UNIQUE round-trips its name through `unique_constraint_info`. (Inline column-level CHECK / FOREIGN KEY on the new column are likewise enforced — CHECK in place, FK via the same existing-row validation as `ADD CONSTRAINT`.)

**DROP COLUMN**

```sql
ALTER TABLE table_name DROP COLUMN col_name;
```

Removes a column from the table and all its data. Restrictions:

- Cannot drop a PRIMARY KEY column.
- Cannot drop the last remaining column.

Any UNIQUE constraint over the dropped column is removed with it — a single-column UNIQUE outright, and a **multi-column** UNIQUE in full (a UNIQUE missing one of its columns is a different, stronger constraint, not a silently-narrowed one). The auto-built covering index backing such a constraint is torn down at the same time, leaving no orphan in `index_info`. A UNIQUE whose columns do **not** include the dropped column survives, with its column indices shifted over the removed slot. (SQLite rejects dropping a column that participates in a UNIQUE; Quereus permits it and drops the constraint.)

**ADD / DROP / RENAME CONSTRAINT**

```sql
ALTER TABLE table_name ADD CONSTRAINT con_name <constraint-body>;  -- CHECK (...) / UNIQUE (...) / FOREIGN KEY (...)
ALTER TABLE table_name DROP CONSTRAINT con_name;
ALTER TABLE table_name RENAME CONSTRAINT old_con TO new_con;
```

Manages a **named** table-level constraint (CHECK / UNIQUE / FOREIGN KEY) over its lifetime. All three resolve a name across the constraint classes in the fixed order CHECK → UNIQUE → FOREIGN KEY; a name present in more than one class is rejected as **ambiguous**, and an unknown name raises `NOTFOUND`. Constraint names are local to their table — there are no cross-object references to rewrite on rename.

- **ADD CONSTRAINT** adds a new named (or, for the unnamed `ADD UNIQUE (...)` / `ADD FOREIGN KEY (...)` form, auto-named) constraint. A CHECK is added in place and begins enforcing on the next INSERT/UPDATE. A UNIQUE / FOREIGN KEY add routes through the table's module, which **re-validates the existing rows** against the new constraint and fails atomically with `CONSTRAINT` (leaving the schema unchanged) when the current data violates it; otherwise it installs forward enforcement. UNIQUE validation honors SQL NULL semantics (multiple NULLs are distinct) and any partial predicate. FOREIGN KEY existing-row validation is **gated by `pragma foreign_keys`** — when off, the add succeeds without a validating scan and enforcement is deferred to subsequent writes — and follows MATCH SIMPLE (a child row with any NULL FK column is exempt). A declarative add of a named UNIQUE / FK to an already-existing table now converges via this path.
- **DROP CONSTRAINT** removes the named constraint. Dropping a UNIQUE also tears down the auto-built secondary index that backs it. A UNIQUE constraint synthesized from a `CREATE UNIQUE INDEX` cannot be dropped this way (the index is the user's object) — use `DROP INDEX`, which removes both.
- **RENAME CONSTRAINT** changes a named constraint's name; the new name must not already address a constraint. For a UNIQUE backed by an implicit covering index named after the constraint, the index is renamed in lock-step. (A UNIQUE derived from a `CREATE UNIQUE INDEX` is likewise managed via its index, not renamed here.)

These are schema-catalog operations that round-trip through the module's `alterTable`, so store-backed tables re-persist their DDL across reconnect.

There is no in-place "redefine constraint" primitive. When a **declarative** schema (`apply schema`) changes the *body* of a named constraint while keeping its name — an edited CHECK expression, a changed FK `ON DELETE`/`ON UPDATE` action or referenced table/columns, a changed UNIQUE column set or `ON CONFLICT` — the differ realizes it as **DROP CONSTRAINT + ADD CONSTRAINT** (drop the old, add the new). For **UNIQUE / FOREIGN KEY**, the re-add re-validates existing rows against the new rule and fails atomically with `CONSTRAINT` (leaving the schema unchanged) if any current row violates the new body. For **CHECK**, the re-add is **forward-enforcing only** — it installs the new predicate but does **not** re-validate rows already in the table (a pre-existing limitation of the CHECK add path), so an existing row that violates the new predicate survives and is checked only on its next write. A change to a constraint's **tags** only is *not* a body change — it takes `ALTER CONSTRAINT … SET TAGS` (no drop+recreate). If a constraint is both renamed (via a `quereus.previous_name`/`quereus.id` hint) and has a changed body, the drop+recreate subsumes the rename (the new body must re-validate regardless). Note that the DROP and ADD are two separate statements and the migration is **not atomic** on the memory backend: if the re-add fails re-validation, the old constraint has already been dropped (see `docs/schema.md` for the atomicity caveat).

**ALTER PRIMARY KEY**

```sql
ALTER TABLE table_name ALTER PRIMARY KEY (col_name [ASC|DESC] [, ...]);
```

Replaces the table's primary key definition. All named columns must have a NOT NULL constraint. The empty-PK case `ALTER PRIMARY KEY ()` is permitted (the table reverts to an implicit rowid-style key). Modules that support re-keying in place handle the change directly; modules that cannot (including the built-in MemoryTable) use an automatic rebuild fallback that copies all rows into a new table with the updated PK and swaps it in place.

**ALTER COLUMN**

```sql
ALTER TABLE table_name ALTER COLUMN col_name SET NOT NULL;
ALTER TABLE table_name ALTER COLUMN col_name DROP NOT NULL;
ALTER TABLE table_name ALTER COLUMN col_name SET DATA TYPE type_name;
ALTER TABLE table_name ALTER COLUMN col_name SET DEFAULT expr;
ALTER TABLE table_name ALTER COLUMN col_name DROP DEFAULT;
ALTER TABLE table_name ALTER COLUMN col_name SET COLLATE collation_name;
```

Changes a single column attribute. Each statement carries exactly one attribute; combine multiple attributes by issuing multiple statements. Restrictions:

- `SET NOT NULL` scans existing rows. If any are NULL and the column has a literal DEFAULT, NULL rows are backfilled with that default; otherwise the statement fails with `CONSTRAINT`.
- `DROP NOT NULL` is rejected on PRIMARY KEY columns.
- `SET DATA TYPE` is a schema-only change when the new type shares the same physical representation; otherwise each row's value is re-validated and converted, failing with `MISMATCH` on any value that cannot be coerced. Rejected on PRIMARY KEY columns.
- `SET/DROP DEFAULT` is schema-only; existing rows are not touched.
- `SET COLLATE` changes the column's collation (its comparison/ordering rule, default `BINARY`). The collation name is validated against the column's logical type up front — an unknown/unsupported collation is rejected with `Unknown collation '…' for type '…'`, the same error shape as `CREATE TABLE`. Because collation is **semantic** (it changes `=` and `ORDER BY`), the module re-keys / re-sorts any PRIMARY KEY, UNIQUE, or index that orders by the column and **re-validates uniqueness under the new collation**: a value set that was unique under `BINARY` but collides under `NOCASE` fails with `CONSTRAINT`, leaving the table unchanged. `SET COLLATE` is permitted on PRIMARY KEY columns (the primary structure is re-keyed). `SET COLLATE BINARY` restores the default. Unlike `SET TAGS`, a collation change **does move the schema hash** (`explain schema` reports a new hash). *Store-module note:* the LevelDB store re-validates existing rows under the new per-column collation for every **non-PK** UNIQUE constraint covering the altered column — inline `UNIQUE` and `CREATE UNIQUE INDEX`-derived alike — and rejects the ALTER with `CONSTRAINT` (schema unchanged) when the new collation introduces a duplicate, reaching parity with memory for those cases (write-time UNIQUE enforcement was already collation-aware). The same per-column-collation-honoring existing-row check now also backs the store's `ADD CONSTRAINT UNIQUE` and `CREATE UNIQUE INDEX` paths. **PRIMARY KEY** columns are honored by a **physical re-key**: the store keys each PK column under its own declared collation (`StoreTable.pkKeyCollations`), so a PK `SET COLLATE` re-encodes every data-store key under the column's new collation and rebuilds each secondary index (whose keys embed the PK suffix), reaching parity with memory. A re-key that would collide under the new collation (e.g. `'a'`/`'A'` distinct under `BINARY` but colliding under `NOCASE`) fails with `CONSTRAINT` in the validation pass **without mutating the store** — all-or-nothing, mirroring `ALTER PRIMARY KEY`; a target equal to the column's current collation is a schema-only no-op. The store's table-level key collation K (`config.collation`, default `NOCASE`) now only supplies the **default** for an undecorated text PK column at CREATE and the collation for secondary-index *column* values. Residual limitation: the existing-row dedup uses a string normalizer that only knows the built-in `BINARY`/`NOCASE`/`RTRIM`, so a **custom comparator-only collation** falls back to BINARY for the ALTER-time scan and can under-reject (write-time enforcement, via the comparator, stays exact). Query-layer `=` / `ORDER BY` / `table_info().collation` pick up the new collation regardless.

The declarative schema differ (`diff schema`) detects column-attribute drift and emits the matching `ALTER COLUMN` statements in the order `SET DATA TYPE` → `SET COLLATE` → `SET/DROP DEFAULT` → `SET/DROP NOT NULL` (the two comparison-domain changes first, so a newly-declared DEFAULT is in place before any NOT NULL tightening relies on it for backfill). A declared `COLLATE BINARY` and an absent `COLLATE` are treated as equal — no spurious diff.

**SET TAGS / ADD TAGS / DROP TAGS**

```sql
ALTER TABLE table_name SET TAGS (key = value [, ...]);                       -- replace the whole table tag set
ALTER TABLE table_name SET TAGS ();                                          -- clear all table tags
ALTER TABLE table_name ADD TAGS (key = value [, ...]);                       -- merge: set/overwrite the listed keys, keep the rest
ALTER TABLE table_name DROP TAGS (key [, ...]);                              -- delete the listed keys
ALTER TABLE table_name ALTER COLUMN col_name SET TAGS (key = value [, ...]);     -- column: replace
ALTER TABLE table_name ALTER COLUMN col_name ADD TAGS (key = value [, ...]);     -- column: merge
ALTER TABLE table_name ALTER COLUMN col_name DROP TAGS (key [, ...]);            -- column: delete keys
ALTER TABLE table_name ALTER CONSTRAINT con_name SET TAGS (key = value [, ...]); -- named constraint: replace
ALTER TABLE table_name ALTER CONSTRAINT con_name ADD TAGS (key = value [, ...]); -- named constraint: merge
ALTER TABLE table_name ALTER CONSTRAINT con_name DROP TAGS (key [, ...]);        -- named constraint: delete keys
```

Mutates the metadata tags on the table itself, one of its columns, or one of its **named** table-level constraints (CHECK / UNIQUE / FOREIGN KEY). The three verbs differ only in how they combine with the existing tags; all are catalog-only, schema-hash-neutral, and read the *live* tag set at execution time. Semantics and restrictions:

- **Whole-set replacement vs. per-key merge / delete.** `SET TAGS` replaces the *entire* tag set at the target with the listed tags — an empty list `SET TAGS ()` clears all tags. `ADD TAGS (k = v[, …])` **merges**: it sets/overwrites the listed keys and keeps every other existing key (the ergonomic "touch one tag" form — no need to restate the whole set). `DROP TAGS (k[, …])` **deletes** the listed keys. After any of these the introspection TVFs (`schema()`, `table_info()`, `check_constraint_info()`, …) report the resulting set, and `tags IS NULL` once the set is empty.
- **DROP of an absent key fails atomically.** `DROP TAGS` validates that **every** listed key is currently present *before* mutating anything; if any is absent it raises `NOTFOUND` naming the missing key(s) and drops **nothing** (so a typo like `DROP TAGS (audt)` fails loudly rather than silently no-op'ing). Dropping the last remaining key(s) leaves `tags IS NULL`, exactly like `SET TAGS ()`. There is no `IF EXISTS` form.
- **Empty list is a no-op for ADD / DROP.** `ADD TAGS ()` and `DROP TAGS ()` change nothing — deliberately distinct from `SET TAGS ()`, which clears.
- **Case-sensitive / verbatim keys.** Tag keys are stored exactly as authored (`display_name`, `audit`, `quereus.id`) with no case-folding; `ADD`/`DROP` match keys verbatim.
- **`null` is a stored value, not a delete.** `ADD TAGS (k = null)` stores `k` present with value null (a legal stored value) — distinct from `DROP TAGS (k)`, which removes the key. (This is why there is a dedicated `DROP TAGS` rather than overloading `SET k = null`.)
- **Catalog-only.** Tags are pure informational metadata: they touch no stored row and no physical layout, so none of these round-trips through the module's `alterTable`, and they succeed even on modules that don't implement it. (Caveat: store-backed modules re-persist DDL only through `alterTable`; the generic store recovers tag changes by subscribing to the `table_modified` event these fire, so table / column / named-constraint tag mutations — SET, ADD, and DROP alike — survive reconnect for store tables.)
- **Reserved-tag validation.** `SET TAGS` and `ADD TAGS` validate any `quereus.*` key against the reserved-tag registry at the matching site (table / column / constraint) exactly as on `CREATE TABLE` / `declare schema`, so a misspelled or mis-sited reserved key (e.g. `"quereus.previuos_name"`) fails loudly at plan-build rather than being stored. `DROP TAGS` does **no** value validation — it removes by key — so dropping a reserved key (e.g. removing a stale `quereus.previous_name` hint) is legitimate and succeeds.
- **Schema hash unaffected.** Tags are excluded from the schema hash, so `explain schema` reports the same hash after any tag-only `ALTER` (SET / ADD / DROP).
- **Only named constraints are addressable.** `ALTER CONSTRAINT` targets a constraint by name; an unnamed constraint (e.g. an inline `CHECK` whose trailing `WITH TAGS` attaches to its column) has no addressable name and its tags are immutable post-create. A name that does not match any named constraint raises `NOTFOUND`; a name present in more than one constraint class (lookup order CHECK → UNIQUE → FOREIGN KEY) is rejected as ambiguous.
- **Attribute-preserving.** A tag mutation on a column changes only its `tags`; nullability, type, default, generated-ness, and PK membership are untouched.

The declarative schema differ detects tag drift at all three sites and emits the matching **whole-set** `SET TAGS` statements (it computes the full desired set) **after** the structural ALTER phases (rename/add/alter/pk/drop), so a tag set lands on the post-rename column / constraint name. `ADD TAGS` / `DROP TAGS` are an imperative-only convenience and are **not** emitted by the differ. The rename-hint keys `"quereus.id"` and `"quereus.previous_name"` are excluded from the tag-drift comparison (they drive rename detection, not data state, so a declaration carrying only a hint does not churn out a `SET TAGS` after the rename completes); all other reserved tags (`quereus.lens.*`, `quereus.expose_implicit_index`, …) *are* compared.

#### SET MAINTAINED / DROP MAINTAINED — derivation lifecycle

```sql
ALTER TABLE table_name SET MAINTAINED AS query_expr [WITH DEFAULTS (column = expr [, ...])];
ALTER TABLE table_name DROP MAINTAINED;
```

`SET MAINTAINED AS` attaches a derivation to a plain table — making it a [maintained table](materialized-views.md) — or atomically replaces an already-maintained table's derivation. The body must derive the table's exact declared shape (names included; alias body outputs to match), and the table's current contents are reconciled against the derived contents by keyed diff (identical content writes nothing; divergence resolves derived-wins, reporting only genuine changes). There is no `using` clause — the module is the table's identity. A body closing a derivation cycle (including self-reference) and duplicate derived keys are rejected with the table untouched. `DROP MAINTAINED` detaches the derivation: catalog-only — the table keeps its rows and becomes an ordinary, user-writable table; maintenance stops. The declared-shape create form (`create table … maintained as <body>`) and the full attach/detach semantics are specified in [materialized-views.md § DDL statements](materialized-views.md#ddl-statements).

#### SET / ADD / DROP TAGS on views, materialized views, and indexes

The other tagged catalog objects — views, materialized views, and indexes — also carry their tags from `CREATE` time, and can be re-tagged in place with the same three verbs as `ALTER TABLE`:

```sql
ALTER VIEW view_name               SET TAGS (key = value [, ...]);  -- view: replace whole set
ALTER VIEW view_name               ADD TAGS (key = value [, ...]);  -- view: merge (set/overwrite listed keys, keep rest)
ALTER VIEW view_name               DROP TAGS (key [, ...]);         -- view: delete listed keys
ALTER MATERIALIZED VIEW mv_name    SET TAGS (key = value [, ...]);  -- materialized-view: replace / add / drop
ALTER MATERIALIZED VIEW mv_name    ADD TAGS (key = value [, ...]);
ALTER MATERIALIZED VIEW mv_name    DROP TAGS (key [, ...]);
ALTER INDEX index_name             SET TAGS (key = value [, ...]);  -- index: replace / add / drop
ALTER INDEX index_name             ADD TAGS (key = value [, ...]);
ALTER INDEX index_name             DROP TAGS (key [, ...]);
ALTER VIEW view_name               SET TAGS ();                     -- clear all tags (any kind)
```

The three verbs carry **exactly the `ALTER TABLE … {SET|ADD|DROP} TAGS` semantics** documented above — `SET` is whole-set replacement (empty list clears, after which `schema()` / `index_info()` report `tags IS NULL`); `ADD` merges (empty list is a no-op, *not* a clear); `DROP` deletes the listed keys atomically (every key must be present, else `NOTFOUND` names the missing key(s) and drops nothing; dropping the last key leaves `tags IS NULL`; empty list is a no-op). Keys are matched verbatim (case-sensitive), all forms are catalog-only (no module / data round-trip; the tag change re-registers the in-memory schema object only) and schema-hash-neutral, and the live tag set is read at execution time. Notes specific to these objects:

- **Reserved-tag validation site (SET / ADD only; DROP does not validate).** A `quereus.*` key on `ALTER VIEW` / `ALTER MATERIALIZED VIEW … SET TAGS` / `ADD TAGS` is validated at the `view-ddl` site, and on `ALTER INDEX … SET TAGS` / `ADD TAGS` at the `physical-index` site — the same registry and sites `CREATE` / `declare schema` use, so a typo (e.g. `"quereus.bogus"`) fails loudly at plan-build. `DROP TAGS` removes by key with no value validation, so dropping a reserved key (e.g. `DROP TAGS ("quereus.id")`) is legitimate and succeeds.
- **Materialized views never re-materialize.** Any MV tag change — `SET`, `ADD`, or `DROP` — is a pure metadata write; it does **not** touch the backing table or re-run the body. The declarative differ enforces this: a tag-only MV change takes the in-place `SET TAGS` path, while a **body** change still drops+recreates (carrying the declared tags through the recreate) — the two are mutually exclusive per MV in one migration.
- **View tag changes reach prepared statements.** No reserved tag drives write-through behavior (routing is per-row presence/membership columns; omitted-insert defaults are the body select's `with defaults (…)` clause — see [§2.9](#29-updatable-views)), but reserved-tag *validation* re-runs whenever a write-through plan is built — and the change applies to both newly planned statements *and* already-prepared ones: an `ALTER VIEW … {SET|ADD|DROP} TAGS` fires `view_modified` (and the `ALTER MATERIALIZED VIEW` forms fire `materialized_view_modified`), and every view-/MV-mediated write records a `view` plan dependency, so a cached prepared statement that writes through the view is invalidated and re-planned on its next execution — exactly as a table tag change invalidates via `table_modified` — surfacing, e.g., a newly-added invalid reserved key. (Read-only `select … from v` is intentionally *not* invalidated: view tags do not affect read results.)
- **Index resolution and implicit covering structures.** `ALTER INDEX` resolves the owning table from the index name (index names are unique per schema). The auto-built covering structure backing a UNIQUE constraint is **not** a user-addressable index — `ALTER INDEX … {SET|ADD|DROP} TAGS` on its name raises `NOTFOUND`; its tags live on the originating constraint (`ALTER TABLE … ALTER CONSTRAINT … {SET|ADD|DROP} TAGS`), unless the constraint opted the structure into visibility via `quereus.expose_implicit_index`.
- **Tags are the only `ALTER` verb for these objects.** There is no structural `ALTER VIEW` / `ALTER MATERIALIZED VIEW` / `ALTER INDEX` (rename, recolumn, …) yet; structural changes still go through drop+recreate (which the declarative pipeline drives automatically).

The declarative schema differ detects tag drift on a name-matched view / materialized view / index and emits the corresponding **whole-set** `SET TAGS` in the migration's alter phase (`ADD` / `DROP TAGS` are an imperative-only convenience and are not emitted by the differ).

### 2.8 CREATE VIEW Statement

A view is a named query. Selecting from it re-evaluates the body on every reference (a view is not cached — see [Materialized Views](#210-create-materialized-view-statement) for the stored, kept-consistent variant).

**Syntax:**
```sql
create view [if not exists] view_name [(column[, ...])]
  as query_expr [with defaults (column = expr [, ...])]
[with tags (key = value [, ...])]

drop view [if exists] view_name;
```

- `query_expr` is any relation-producing expression — a `select`, a `values (...)`, or a `with … select`. A **DML body** (`insert`/`update`/`delete … returning`) is **rejected at create time**: a view re-evaluates per reference, so a write-per-read body is incoherent.
- An optional column list renames the body's output columns (arity must match).
- `with defaults (col = expr, ...)` is a trailing clause of the **core select** (it binds to the whole query expression after `limit`/`offset`, before `with tags`): it declares per-column **omitted-insert defaults** for write-through — typically for a base column the view projects away (see [§2.9](#29-updatable-views)). Column names must be distinct; each `expr` must be self-contained (it cannot reference the inserted row's columns); the target is resolved (and a typo rejected) at write time, not at create — the base-column lineage it resolves against is only assembled when the view is an actual write target.
- `with tags (...)` attaches metadata (informational only — reserved `quereus.*` keys are validated, but none carries view behavior; see [§2.9](#29-updatable-views)).

**Examples:**
```sql
create view ActiveUsers as select * from Users where active = 1;
create view UserNames(uid, label) as select id, name from Users;
create view NewUsers(uid, label) as select id, name from Users
  with defaults (created = epoch_ms('now'));
drop view if exists ActiveUsers;
```

### 2.9 Updatable Views

Views, non-recursive CTEs, and subqueries in `from` are **uniformly mutable**: `insert` / `update` / `delete` against them is rewritten to operate on the underlying base table(s), reusing all constraint / conflict / foreign-key machinery. A relation is updatable iff a deterministic decomposition exists at plan time; otherwise the mutation surfaces a structured diagnostic naming the operator or column that obstructed it. There is **no** `with check option` and **no** `instead of` trigger surface — write-through is predicate-driven, not declared per view.

Reads and writes through a view report the *base* table(s) to `getChangeScope()` and `Database.watch` (see [Usage Guide](usage.md)).

**What is writable (single-source projection-and-filter view):**

- A **passthrough or renamed** column (`c`, `c as alias`) routes the value straight to its base column — writable on both `insert` and `update`.
- An **invertible-expression** column (`v + 1 as w`) is writable on `update` (the assignment is lowered through the inverse: `set w = 9` ⇒ `set v = 8`). It is **not** insertable.
- A **computed / non-invertible** column (`lower(name)`, a window or aggregate output) is **read-only**; writing it raises the `no-inverse` diagnostic — *unless* the result column carries an **authored inverse**: `expr as col with inverse (base_col = expr-over-NEW, ...)` upgrades the column to writable on both `update` and `insert` (each assignment computes a base column from the written view row, referenced via the mandatory `new.` qualifier). Targets must be base columns of the FROM sources; `new.*` references must be output columns of the select — both validated at build time wherever the clause appears. See [View Updateability § Authored inverses](view-updateability.md#authored-inverses-with-inverse).
- A column **omitted** from an `insert` but pinned by an equality predicate is supplied automatically: `create view GreenMen as select * from Men where color = 'green'` lets `insert into GreenMen (name) values ('Bob')` default `color` to `'green'`. A view-declared `with defaults (col = expr, ...)` entry fills a still-omitted column next (ahead of the base column's declared `default` — the dominant use is a base column the view projects away); base-column `default`s fill the rest; a `not null` column with no available value is rejected.
- A top-level reference in `where` / `set` / `returning` must name a **view** column — a base column the view projects away does not silently resolve (`unknown-view-column`).

```sql
create view GreenMen as select id, name, color from Men where color = 'green';
insert into GreenMen (id, name) values (7, 'Bob');   -- color defaults to 'green'
update GreenMen set name = 'Bobby' where id = 7;      -- routes to Men
delete from GreenMen where id = 7;                    -- routes to Men
```

**Multi-source (key-preserving inner-join) views** support `update` / `delete` and two-table `insert` write-through: each output column routes to its owning base table, FK-parent before FK-child. Outer joins, set-operations, aggregates, self-joins, `> 2`-table and composite-key joins are rejected with a diagnostic.

**`returning`** through a view projects rows through the *view's* column list, evaluated against post-mutation state (single-source all ops; multi-source `update` / `delete`).

**Insert defaults — and no override tags.** A view declares omitted-insert defaults first-class via the body select's trailing `with defaults (col = expr, ...)` clause ([§2.8](#28-create-view-statement)); the expression is evaluated per omitted-insert row, ahead of the base column's declared `default`. Write *routing* is not a tag — it is expressed by predicates and per-row writable **presence/membership columns** (the outer-join existence column, the set-op membership columns). To realize a non-default deletion side (e.g. delete the FK-parent), expose the side as an outer-join existence column and write it: `update v set hasP = false where ...`.

The entire `quereus.update.*` tag namespace is retired: the routing keys (`target` / `exclude` / `delete_via` / `policy`) and the `default_for.<col>` insert-default override (both its view-DDL and statement-level sites; superseded by the `with defaults` clause — a per-statement default is expressed as an explicit insert value) are now an `unknown-reserved-tag` error at any site. See [View Updateability](view-updateability.md) for the full per-operator semantics and the complete diagnostic catalog.

### 2.10 CREATE MATERIALIZED VIEW Statement

A materialized view stores its body in a keyed backing relation kept consistent with its sources **synchronously, inside the writing transaction** (row-time maintenance). It is observably indistinguishable from the plain view it derives from — reads-own-writes hold, a rollback reverts source and backing together — only served from stored rows. There is one maintenance model and **no refresh-policy knob**.

**Syntax:**
```sql
create materialized view [if not exists] view_name [(column[, ...])]
  [using module_name [(module_args...)]]
  as query_expr [with defaults (column = expr [, ...])]
[with tags (key = value [, ...])]

refresh materialized view view_name;
drop materialized view [if exists] view_name;
```

The `create materialized view` form is normalization sugar for the declared-shape **table form** — `create table name (columns...) [using module(...)] maintained [(columns)] as query_expr [with defaults (...)] [with tags (...)]` — where the table layout is authored and the body must derive exactly that shape (the optional `maintained (columns)` rename list is the lossless persistence encoding of a sugar MV's explicit renames; its absence marks an implicit body that reshapes to follow its source). The `with defaults (...)` clause rides the body `query_expr` (the core select), not the DDL statement. The table form is also the canonical persistence/export rendering for every maintained table; `refresh materialized view` and `drop materialized view` work on any maintained table regardless of authoring form. See [materialized-views.md § DDL statements](materialized-views.md#ddl-statements) and the `SET MAINTAINED` / `DROP MAINTAINED` lifecycle verbs in [§2.7](#27-alter-table-statement).

- The body is evaluated and stored at create; create is all-or-nothing.
- `refresh` is **not required for currency** (row-time maintenance keeps it live); it is an explicit resync verb, useful after a source *schema* change marks the view `stale`.
- `using module(...)` places the maintained table in the named [backing-host](materialized-views.md#backing-host-capability) module; omitted ⇒ the in-memory default. An unknown module or one without the capability is rejected at build time.
- the body select's trailing `with defaults (col = expr, ...)` clause carries the same omitted-insert-default semantics as on a plain view ([§2.8](#28-create-view-statement)) — the default is supplied on the rewritten *source* insert and is transparent to row-time backing maintenance.
- `drop table` / `drop view` reject a materialized-view name and redirect to `drop materialized view` (and vice-versa).

**Eligibility (enforced at create).** Row-time maintenance is only affordable for bodies whose per-write delta is bounded, so the accepted shape is narrow. Eligible bodies:

- a **single source** with a projection (+ optional `where` / `order by`) that includes every PK column as a passthrough — the covering-index shape;
- a **single-source aggregate** (`group by` over bare source columns);
- a **single-source lateral table-valued-function** fan-out;
- a **1:1 row-preserving inner/cross join**.

Any other body (general joins, set-operations, recursion, `distinct`, `limit`/`offset`, non-deterministic projections) is **rejected at create** with a diagnostic that steers you to a plain `view` (live re-evaluation) or `create table … as <body>` (one-off snapshot).

**Write-through.** `insert` / `update` / `delete` against a materialized-view name is rewritten to its source table (via the same [updatable-view](#29-updatable-views) machinery) and the row-time hook syncs the backing within the statement. Per-column writeability is inherited verbatim (passthrough writable, computed read-only).

**Covering structures.** A materialized view that projects a UNIQUE constraint's columns (plus the source PK), ordered by those columns, can *cover* that constraint — its backing table then answers `insert or replace` / `or ignore` / conflict detection at O(log n), row-time. This is the substrate the [lens](#211-logical-schemas-and-lenses) layer's set-level enforcement builds on.

**Declarative schema.** A `materialized view` item is accepted inside `declare schema { … }`; a definition change — body, explicit column list, or `with defaults` clause (the body string carries it, so `bodyHash` over the canonical definition detects it) — schedules a drop-and-recreate.

```sql
create materialized view mv as select id, x from t order by x;
refresh materialized view mv;
drop materialized view if exists mv;
```

See [Materialized Views](materialized-views.md) for the maintenance arms, the eligibility detail, and the covering-structure / enforcement model.

### 2.11 Logical Schemas and Lenses

A **logical schema** is an embodiment-free design — tables, types, and logical constraints with no module, indexes, or storage hints. A **lens** maps each logical table onto a **basis** (module-backed) schema as a bidirectional view, built on the updatable-view machinery: `get` is an ordinary `select`, `put` is the predicate-driven propagation. At deploy the lens compiles to an inline view, so the query processor sees an ordinary view over basis.

**Syntax:**
```sql
declare logical schema schema_name { table_item* assertion_item* ... }

declare lens for logical_schema over basis_schema {
  view logical_table as select_expr;
  ...
}

apply schema logical_schema;   -- compiles + deploys the lens-backed views
```

- A `logical` schema rejects `using module(...)`, indexes, and physical storage constructs at build time; tags are allowed (engine-facing metadata).
- A `declare lens` block supplies **sparse overrides** — only the deviations (rename, compute, filter). Columns an override does not cover are gap-filled by the default name-based mapper; every logical column must end up mapped to basis (an uncovered column the basis cannot back is a compile error).
- A lens override body must be a single `select` whose `from` sources live in the declared basis (compound set-operations and cross-basis re-anchoring are rejected).
- The logical spec's constraints are **attached** at the lens boundary and enforced per class — row-local (`not null`, `check`) and foreign keys (child- and parent-side, incl. cascade actions) are live; `unique` / primary keys enforce row-time when a basis covering materialized view answers the key, else commit-time detection.

**Inspect the effective mapping:**
```sql
select * from quereus_effective_lens('LogicalSchema', 'TableName');
```

The lens layer is the most recently landed of these features and is evolving (n-way decomposition, module mapping advertisements, and access-shape routing are partially shipped). See [Lenses and Layered Schemas](lens.md) for the full model, the prover, and the constraint-attachment classes.

## 3. Clauses and Subclauses

### 3.1 FROM Clause

The from clause specifies the data sources for a query.

**Syntax:**
```sql
from table_reference [, table_reference...]

table_reference:
  table_name [as alias]
| function_name ([arg[,...]]) [as alias]
| (select_statement) as alias
| (mutating_statement) as alias
| table_reference join_type join table_reference [join_specification]
```

**Mutating Statements:**
Quereus supports **relational orthogonality** - any statement that results in a relation can be used anywhere that expects a relation value. This includes:
- `(INSERT ... RETURNING ...) AS alias`
- `(UPDATE ... RETURNING ...) AS alias` 
- `(DELETE ... RETURNING ...) AS alias`

This allows for powerful compositions where the results of data modifications can be immediately used in queries.

**Join Types:**
- `[inner] join`: Matches rows when join condition is true
- `left [outer] join`: Includes all rows from left table, plus matching rows from right table
- `right [outer] join`: Includes all rows from right table, plus matching rows from left table
- `full [outer] join`: Includes all rows from both tables
- `cross join`: Cartesian product of both tables

**Join Specifications:**
- `on condition`: Join condition
- `using (column[,...])`: Join on equal named columns

#### Existence columns on outer joins

After a complete `on` / `using` predicate, an outer join may expose **existence
columns** — a clean `{true,false}` NOT NULL flag per non-preserved side telling you
whether that side matched the current row (Dataphor's `include rowexists`):

```sql
-- non-preserved (right) side of a LEFT join; `exists as` resolves the side
select c.id, hasOrder
from customers c left join orders o on o.cust = c.id exists as hasOrder;

-- explicit side; required for FULL (both sides null-extendable), comma-separated
select a.id, aOnly, bOnly
from a full join b on b.k = a.k exists left as aOnly, exists right as bOnly;
```

- The clause appears **only after a finished `on` / `using` predicate**, and
  `exists` here is always followed by `as` or a side token — never `(` — so it never
  collides with the `exists (<subquery>)` predicate (one-token lookahead
  distinguishes them). The comma form is recognised only when the next token is
  another `exists`, so a genuine new FROM-source comma is unaffected. This is
  additive grammar — it occupies previously-unused space and breaks nothing.
- `exists as <name>` resolves to the unique non-preserved side of a `left` / `right`
  join. A side is **required** for `full outer` (both sides null-extend); `inner` /
  `cross` and the preserved side of a `left` / `right` join are **rejected** (no
  null-extension ⇒ the flag would be a meaningless constant `true`).
- The flag is derived **at the join** from the actual match, never stored in the
  operand and never a re-evaluation of the predicate (which would be unsound on a
  null-extended row). **Writing it drives the non-preserved side's existence** through
  an updatable view: `set hasOrder = true` over a null-extended row inserts the matching
  side (join key via the equi-join equivalence class, other columns defaulted), `= false`
  over a matched row deletes it, and it is consumed as a routing directive on insert
  (`insert into v (…, hasOrder) values (…, false)` ⇒ preserved-only) — never stored to a
  base column. Only a **boolean literal** (`true`/`false`) is supported; a per-row branch
  on a non-literal value is deferred. See [view-updateability.md § Existence columns](view-updateability.md#existence-columns-on-outer-joins).

**Examples:**
```sql
-- Multiple tables
select u.name, p.title 
from users as u, posts as p
where u.id = p.user_id;

-- Inner join
select e.name, d.name as department
from employees as e
inner join departments as d on e.dept_id = d.id;

-- Left join
select c.name, o.order_date
from customers as c
left join orders as o on c.id = o.customer_id;

-- Using clause
select p.title, c.content
from posts as p
join comments as c using (post_id);

-- Multiple joins
select o.id, c.name, p.name as product
from orders as o
join customers as c on o.customer_id = c.id
join order_items as oi on o.id = oi.order_id
join products as p on oi.product_id = p.id;

-- Subquery in from
select avg_dept.department, avg_dept.avg_salary
from (
  select department, avg(salary) as avg_salary
  from employees
  group by department
) as avg_dept
where avg_dept.avg_salary > 50000;

-- Mutating subquery: INSERT with RETURNING as table source
select new_user.id, new_user.name, 'created' as status
from (
  insert into users (name, email) 
  values ('Alice', 'alice@example.com')
  returning id, name
) as new_user;

-- Mutating subquery: UPDATE with RETURNING in JOIN
select u.name, updated.old_email, updated.new_email
from users u
join (
  update user_profiles 
  set email = lower(email)
  where email != lower(email)
  returning user_id, email as old_email, lower(email) as new_email
) as updated on u.id = updated.user_id;

-- Mutating subquery: DELETE with RETURNING for audit trail
insert into audit_log (action, deleted_user_id, deleted_name)
select 'user_deleted', deleted.id, deleted.name
from (
  delete from users 
  where last_login < date('now', '-365 days')
  returning id, name
) as deleted;

-- Table-valued function
select key, value 
from json_each('{"name":"John","age":30}');
```

### 3.2 WHERE Clause

The where clause filters rows returned by a query.

**Syntax:**
```sql
where condition
```

The condition is an expression that evaluates to a boolean result. If true, the row is included in the result set.

**Examples:**
```sql
-- Simple comparison
select * from products where price < 50;

-- Multiple conditions with AND/OR
select * from employees 
  where (department = 'Sales' or department = 'Marketing')
  and hire_date >= date('2020-01-01');

-- Pattern matching with LIKE
select * from customers where email like '%@gmail.com';

-- Range check with BETWEEN
select * from orders where order_date between date('now', '-30 days') and date('now');

-- NULL checking
select * from users where last_login is null;

-- Subquery in WHERE
select * from products
  where category_id in (select id from categories where parent_id = 5);

-- EXISTS subquery
select * from customers as c
  where exists (
    select 1 from orders as o
      where o.customer_id = c.id and o.status = 'shipped'
  );
```

### 3.3 GROUP BY Clause

The group by clause groups rows that have the same values into summary rows.

**Syntax:**
```sql
group by expression [, expression...]
```

**Behavior:**
- Each expression in the group by must be a column name, an expression, or a positive integer representing a position in the select list.
- Aggregate functions (`count()`, `sum()`, etc.) can be used with group by to calculate summary statistics for each group.
- Columns in the select list that are not aggregated must appear in the group by clause.

**Examples:**
```sql
-- Simple grouping
select department, count(*) as employee_count
from employees
group by department;

-- Multiple grouping expressions
select department, job_title, avg(salary) as avg_salary
from employees
group by department, job_title;

-- Grouping with expression
select 
  substr(email, instr(email, '@') + 1) as domain,
  count(*) as user_count
from users
group by domain;

-- Grouping with DATE function
select 
  strftime('%Y-%m', order_date) as month,
  sum(total) as monthly_sales
from orders
group by month
order by month;
```

### 3.4 HAVING Clause

The having clause filters groups based on a condition.

**Syntax:**
```sql
having condition
```

The condition is applied after grouping, allowing filtering on aggregate values. References to columns are restricted: only columns that appear in `group by` and aggregate expressions are valid; bare references to ungrouped columns raise an error. The same restriction applies to the implicit single group when the query has aggregates but no `group by`.

**Examples:**
```sql
-- Filter groups with HAVING
select department, count(*) as employee_count
from employees
group by department
having employee_count > 10;

-- HAVING with aggregate function
select product_id, sum(quantity) as total_sold
from order_items
group by product_id
having total_sold > 100
order by total_sold desc;

-- HAVING with multiple conditions
select category, avg(price) as avg_price
from products
group by category
having avg_price > 50 and count(*) >= 5;
```

### 3.5 ORDER BY Clause

The order by clause sorts the result set.

**Syntax:**
```sql
order by expression [asc | desc] [nulls first | nulls last]
       [, expression [asc | desc] [nulls first | nulls last] ...]
```

**Options:**
- `asc`: Ascending order (default)
- `desc`: Descending order
- `nulls first`: NULL values sort before non-NULL values
- `nulls last`: NULL values sort after non-NULL values
- Expression can be a column name, alias, expression, or a positive integer representing a position in the select list (1-based; out-of-range raises an error)
- Aggregate functions are permitted when the query is itself an aggregate query (has aggregates in `select`/`having`, or has `group by`)

**Examples:**
```sql
-- Simple ordering
select * from products order by price;

-- Multiple sort keys
select * from employees
order by department asc, salary desc;

-- Ordering by expression
select name, price, quantity, price * quantity as total
from order_items
order by total desc;

-- Ordering with NULLS FIRST/LAST
select * from users
order by last_login desc nulls last;

-- Aggregate function in ORDER BY (legal with GROUP BY or other aggregates)
select grp, count(*) as cnt from t group by grp order by count(*) desc;

-- Aggregate referenced only in ORDER BY (not in SELECT)
select grp from t group by grp order by max(val) desc;
```

### 3.6 LIMIT and OFFSET Clauses

The limit and offset clauses restrict the number of rows returned.

**Syntax:**
```sql
limit count [offset skip]
-- or
limit skip, count
```

**Options:**
- `count`: Maximum number of rows to return
- `skip`: Number of rows to skip before returning rows

**Examples:**
```sql
-- Simple LIMIT
select * from products order by price limit 10;

-- LIMIT with OFFSET
select * from products order by price limit 10 offset 20;

-- Alternative syntax
select * from products order by price limit 20, 10;

-- Pagination example
select id, title, created_at
from posts
order by created_at desc
limit 20 offset (3 - 1) * 20; -- Page 3, 20 items per page
```

### 3.7 WITH Clause (Common Table Expressions)

The `WITH` clause allows you to define temporary named result sets called Common Table Expressions (CTEs) that can be referenced within the main query. CTEs are particularly useful for creating readable, modular queries and implementing recursive operations.

**Syntax:**
```sql
with [recursive] cte_name [(column1, column2, ...)] as (
    select_statement
) [, cte_name2 as (...)]
select ... from cte_name ...
```

**Options:**
- `recursive`: Enables recursive processing for the CTE
- `column_name_list`: Optional explicit column names for the CTE  
- `materialized` / `not materialized`: Hints for optimization - by default, results are cached if accessed more than once

#### 3.7.1 Basic (Non-Recursive) CTEs

Basic CTEs create temporary named views that exist only for the duration of the query:

**Examples:**
```sql
-- Simple CTE for code organization
with active_users as (
  select id, name, email 
  from users 
  where status = 'active' and last_login > date('now', '-30 days')
)
select name, email 
from active_users 
where email like '%@company.com'
order by name;

-- Multiple CTEs
with 
  high_value_customers as (
    select customer_id, sum(total) as lifetime_value
    from orders
    group by customer_id
    having lifetime_value > 1000
  ),
  recent_orders as (
    select customer_id, order_id, total, order_date
    from orders
    where order_date > date('now', '-90 days')
  )
select c.name, hvc.lifetime_value, ro.total, ro.order_date
from high_value_customers hvc
join customers c on hvc.customer_id = c.id
join recent_orders ro on hvc.customer_id = ro.customer_id
order by hvc.lifetime_value desc;

-- CTE with explicit column names
with sales_summary(dept, total_sales, avg_sale) as (
  select department, sum(amount), avg(amount)
  from sales
  group by department
)
select * from sales_summary where avg_sale > 500;
```

#### 3.7.2 Recursive CTEs

Recursive CTEs enable hierarchical and iterative processing by allowing a CTE to reference itself. They follow the SQL:1999 standard semantics as defined in ISO/IEC 9075-2:2016, Section 7.14.

**Structure:**
A recursive CTE must have the form:
```sql
with recursive cte_name as (
  base_case_query          -- Initial/seed query (non-recursive)
  union [all]
  recursive_case_query     -- Query that references cte_name (recursive part)
)
```

#### 7.4.1 Auto-Deferred Row-Level CHECKs

Quereus automatically defers certain row-level CHECK constraints to COMMIT time to spare users from managing `DEFERRABLE`/`SET CONSTRAINTS`.

- Immediate: Constraints that only reference the current row (including `OLD`/`NEW` references) are validated during the DML statement.
- Auto-deferred: Constraints that reference other relations (e.g., contain subqueries) are validated at COMMIT using the same delta engine as global assertions. If any violation is found, COMMIT fails and the transaction is rolled back.
- Row references: an unqualified column names the row being written (`NEW` for INSERT/UPDATE, `OLD` for DELETE); `new.<col>` / `old.<col>` name a row image explicitly. A self-reference qualified by the owning table — `check (t.qty > 0)` on table `t` — resolves like the unqualified form, except where a subquery inside the CHECK rebinds the table name (there it resolves to the subquery's relation, per normal scoping).

Example:

```sql
create table inventory (
  loc text,
  sku text,
  qty integer check (qty >= 0),
  constraint enough_stock check (
    new.qty <= (select sum(s.qty) from inventory s where s.sku = new.sku)
  )
);
```

`qty >= 0` is checked immediately; `enough_stock` is auto-deferred and validated at COMMIT.

**Standard Semantics (ISO SQL-2016 §7.14):**
According to the SQL standard, recursive CTE evaluation follows this algorithm:

1. **W₀** := result of base_case_query
2. **R** := ∅ (empty result)
3. **repeat**:
    - **R** := **R** ∪ **W₀** (accumulate final result)
    - **W₁** := result of recursive_case_query applied to **W₀**
    - **W₀** := **W₁** ∖ **R** (working table = new rows only, for union)
    - **W₀** := **W₁** (working table = all new rows, for union all)
4. **until** **W₀** = ∅
5. **return** **R**

**Key Points:**
- The recursive term sees only the **working table** (rows from the previous iteration)
- It does **not** see the entire accumulated result
- This enables efficient **semi-naïve evaluation** with O(N) complexity instead of O(N²)

**Implementation in Quereus:**
Quereus implements the semi-naïve (delta) evaluation algorithm:
- Maintains separate `allRows` (accumulated result) and `delta` (previous iteration result) 
- Each iteration feeds only `delta` to the recursive term
- For `union`: deduplicates new rows against `allRows`
- For `union all`: appends all new rows directly
- Complexity is O(N) rather than the naive O(N²) approach

**Examples:**

```sql
-- Simple counter (classic recursive CTE example)
with recursive counter(n) as (
  select 1              -- Base case: start with 1
  union all
  select n + 1          -- Recursive case: increment by 1
  from counter 
  where n < 5           -- Termination condition
)
select n from counter order by n;
-- Result: 1, 2, 3, 4, 5

-- Hierarchical organization chart
with recursive org_chart(employee_id, name, manager_id, level, path) as (
  -- Base case: top-level managers (no manager)
  select id, name, manager_id, 0, name
  from employees 
  where manager_id is null
  
  union all
  
  -- Recursive case: find direct reports
  select e.id, e.name, e.manager_id, oc.level + 1, oc.path || ' -> ' || e.name
  from employees e
  join org_chart oc on e.manager_id = oc.employee_id
  where oc.level < 10  -- Prevent infinite recursion
)
select * from org_chart order by level, name;

-- Tree traversal with path tracking
with recursive tree_path(node_id, parent_id, path, depth) as (
  -- Base case: root nodes
  select id, parent_id, name, 0
  from nodes 
  where parent_id is null
  
  union all
  
  -- Recursive case: children
  select n.id, n.parent_id, tp.path || '/' || n.name, tp.depth + 1
  from nodes n
  join tree_path tp on n.parent_id = tp.node_id
  where tp.depth < 20  -- Maximum depth limit
)
select node_id, path, depth from tree_path order by path;

-- Graph traversal (finding all paths)
with recursive paths(start_node, end_node, path, visited) as (
  -- Base case: all edges as single-step paths
  select from_node, to_node, from_node || '->' || to_node, from_node || ',' || to_node
  from edges
  
  union
  
  -- Recursive case: extend paths
  select p.start_node, e.to_node, p.path || '->' || e.to_node, p.visited || ',' || e.to_node
  from paths p
  join edges e on p.end_node = e.from_node
  where p.visited not like '%,' || e.to_node || ',%'  -- Avoid cycles
    and length(p.path) < 100  -- Prevent runaway recursion
)
select distinct start_node, end_node, path 
from paths 
order by start_node, end_node, length(path);
```

#### 3.7.3 Optimization and Performance

**Materialization Hints:**
While parsed, materialization hints are not currently enforced but may influence future optimizations:
```sql
with recursive 
  large_cte as materialized (select ...),
  small_cte as not materialized (select ...)
select ...
```

**Recursion Limits:**
Use the `option` clause to control maximum recursion depth:
```sql
with recursive counter(n) as (
  select 1
  union all
  select n + 1 from counter where n < 1000000
)
option (maxrecursion 10000)  -- Limit to 10,000 iterations
select count(*) from counter;
```

A `limit`/`offset` written on the outer compound is also honored as an early-termination bound on the entire recursive output, applied after deduplication for `union`. Iteration stops as soon as the consumer has been served `limit` rows, so it can be used to cap an otherwise unbounded recursion:
```sql
with recursive counter(n) as (
  select 1
  union all
  select n + 1 from counter
  limit 5
)
select n from counter;  -- 1, 2, 3, 4, 5
```

**Performance Characteristics:**
- **Non-recursive CTEs**: Executed once, results may be cached
- **Recursive CTEs**: Semi-naïve evaluation with O(N) complexity
- **Memory usage**: Working table and result set kept in memory
- **Deduplication**: For `union`, uses B-Tree with proper SQL value comparison

#### 3.7.4 Common Patterns and Best Practices

**Hierarchical Data:**
```sql
-- Employee reporting hierarchy
with recursive reporting_chain as (
  select employee_id, manager_id, 1 as level
  from employees where employee_id = ?  -- Specific employee
  
  union all
  
  select e.employee_id, e.manager_id, rc.level + 1
  from employees e
  join reporting_chain rc on e.employee_id = rc.manager_id
)
select * from reporting_chain;
```

**Series Generation:**
```sql
-- Generate date series
with recursive date_series(dt) as (
  select date('2024-01-01')  -- Start date
  
  union all
  
  select date(dt, '+1 day')
  from date_series
  where dt < '2024-12-31'    -- End date
)
select dt, strftime('%w', dt) as day_of_week from date_series;
```

**Tree Operations:**
```sql
-- Calculate subtree sizes
with recursive subtree_sizes(node_id, size) as (
  -- Leaf nodes
  select id, 1 from nodes where id not in (select distinct parent_id from nodes where parent_id is not null)
  
  union all
  
  -- Internal nodes
  select n.id, 1 + sum(ss.size)
  from nodes n
  join subtree_sizes ss on n.id = ss.parent_id
  group by n.id
)
select node_id, size from subtree_sizes;
```

**Safety Considerations:**
- Always include termination conditions to prevent infinite recursion
- Use depth/iteration limits as safeguards
- Consider cycle detection for graph traversal
- Monitor memory usage for large result sets

## 4. Expressions and Operators

### 4.1 Literals

**Numeric Literals:**
- Integers: `123`, `-456`
- Floating-point: `123.45`, `-67.89`, `1.23e4`
- Boolean: Represented as integers: `0` (false), `1` (true)

**String Literals:**
- Single-quoted: `'Text value'`
- Double-quoted identifiers: `"Column name with spaces"`

**Blob Literals:**
- Hex format: `x'53514C697465'` (SQLite)

**NULL:**
- Represents missing or unknown value: `null`

**Examples:**
```sql
select 42 as answer;
select 'Hello, world!' as greeting;
select x'DEADBEEF' as binary_data;
select null as no_value;
```

### 4.2 Operators

**Arithmetic Operators:**
- Addition: `+`
- Subtraction: `-`
- Multiplication: `*`
- Division: `/`
- Modulo (remainder): `%`

**Comparison Operators:**
- Equal: `=` or `==`
- Not equal: `!=` or `<>`
- Less than: `<`
- Greater than: `>`
- Less than or equal: `<=`
- Greater than or equal: `>=`

**Logical Operators:**
- AND: `and`
- OR: `or`
- XOR: `xor`
- NOT: `not`

**Bitwise Operators:**
- AND: `&`
- OR: `|`
- NOT: `~`
- Left shift: `<<`
- Right shift: `>>`

**String Operators:**
- Concatenation: `||`

**JSON Path Operators:**
- `->`: Extract JSON value at path, returns JSON (syntactic sugar for `json_extract()`)
- `->>`: Extract JSON value at path, returns scalar TEXT (syntactic sugar for `cast(json_extract() as text)`)

Path shorthand: `expr -> 'name'` is equivalent to `expr -> '$.name'`; `expr -> 0` is equivalent to `expr -> '$[0]'`.

**IS Predicates (postfix boolean tests):**

These are postfix unary predicates on the left operand. They are **total** — they
never return NULL, even when the operand is NULL — so they route truthiness
through the engine's `isTruthy` (numeric-string coercion: `'abc'`, `'0'`, blobs ⇒
false), matching the `where` / `NOT` / logical-operator path.

- `expr is null` / `expr is not null`: NULL test
- `expr is true` / `expr is not true`: boolean test against truthiness
- `expr is false` / `expr is not false`: boolean test against falsiness

| operator       | operand NULL | operand non-NULL |
|----------------|--------------|------------------|
| `is true`      | `false`      | `isTruthy(v)`    |
| `is not true`  | `true`       | `not isTruthy(v)`|
| `is false`     | `false`      | `not isTruthy(v)`|
| `is not false` | `true`       | `isTruthy(v)`    |

The general binary form `a is b` (identity comparison of two expressions) is **not
supported** — only the postfix predicates above are recognized.

**Other Operators:**
- `in`: Tests if a value is in a set
- `not in`: Tests if a value is not in a set
- `like`: Pattern matching with wildcards
- `glob`: Pattern matching with Unix wildcards
- `between`: Tests if a value is within a range
- `exists`: Tests if a subquery returns any rows
- `case`: Conditional expression

**Examples:**
```sql
-- Arithmetic
select price, quantity, price * quantity as total from order_items;

-- String concatenation
select first_name || ' ' || last_name as full_name from users;

-- Comparison
select * from products where price > 100;

-- Logical operators
select * from employees
where (department = 'Sales' or department = 'Marketing')
and salary > 50000;

-- JSON path operators
select data -> 'name' from users;                -- extract as JSON
select data ->> 'age' from users;                -- extract as TEXT
select data -> 'address' -> 'city' from users;   -- chained access
select data -> 0 from json_array_col;            -- array index shorthand

-- IS NULL / IS NOT NULL
select * from users where profile_picture is null;

-- IN operator
select * from products
where category in ('Electronics', 'Computers', 'Accessories');

-- IN with subquery
select * from employees
where department_id in (
  select id from departments where location = 'Headquarters'
);

-- IN with value list (optimized with BTree for fast lookups)
select * from orders 
where status in ('pending', 'processing', 'shipped', 'delivered');

-- BETWEEN
select * from orders
where order_date between date('2023-01-01') and date('2023-12-31');

-- NOT BETWEEN  
select * from products
where price not between 10.00 and 100.00;

-- LIKE pattern matching
select * from users where email like '%@gmail.com';

-- CASE expression
select
  id,
  name,
  price,
  case
    when price < 10 then 'Budget'
    when price < 50 then 'Regular'
    when price < 100 then 'Premium'
    else 'Luxury'
  end as price_category
from products;

-- EXISTS
select * from customers as c
where exists (
  select 1 from orders as o
  where o.customer_id = c.id and o.total > 1000
);

-- NOT EXISTS  
select * from customers as c
where not exists (
  select 1 from orders as o
  where o.customer_id = c.id
);

-- NOT IN with value list
select * from products
where category not in ('Discontinued', 'Seasonal', 'Clearance');

-- NOT IN with subquery
select * from employees
where department_id not in (
  select id from departments where location = 'Remote'
);
```

### 4.3 Functions and Subexpressions

**Function Calls:**
```sql
function_name(argument1, argument2, ...)
```

**Subexpressions:**
```sql
(expression)
```

**Subqueries:**
- Scalar subquery: Returns a single value
- Row subquery: Returns a single row
- Table subquery: Returns a table result
- EXISTS subquery: Returns a boolean

**Examples:**
```sql
-- Scalar functions
select abs(-42), round(3.14159, 2), upper('hello');

-- Subexpressions for grouping
select (price + tax) * quantity as total from order_items;

-- Scalar subquery
select name, (select count(*) from orders where customer_id = c.id) as order_count
from customers as c;

-- Subquery with comparison
select * from products
where price > (select avg(price) from products);

-- Correlated subquery
select * from orders as o
where total > (
  select avg(total) from orders
  where customer_id = o.customer_id
);
```

### 4.4 Special Value Expressions

**COLLATE Expression:**
```sql
expr collate collation_name
```

In a comparison, the effective collation is resolved **symmetrically** from both operands by
provenance rank: an explicit `COLLATE` wrapper outranks a column's declared `COLLATE` clause,
which outranks a defaulted collation; with no contribution from either side the comparison is
`BINARY`. Two operands contributing *different* collations at the same explicit/declared rank
are a prepare-time error (apply an explicit `COLLATE` to disambiguate); conflicting defaults
resolve to `BINARY` silently. See `docs/types.md` § Comparison collation resolution.
`BETWEEN` is evaluated as two independent comparisons (`expr >= lower AND expr <= upper`), so a
`COLLATE` on a **bound** governs only *that bound's* comparison — it does not propagate to the
whole expression. For example `x BETWEEN 'a' COLLATE NOCASE AND 'z'` compares `x >= 'a'` under
`NOCASE` but `x <= 'z'` under the default collation; to collate both sides, put the `COLLATE` on
the tested expression (`x COLLATE NOCASE BETWEEN 'a' AND 'z'`).

**CAST Expression:**
```sql
cast(expr as type)
```

**Parameter References:**
- Positional: `?`, `?1`, `?2`, ...
- Named: `:name`, `@name`, `$name`

**Examples:**
```sql
-- COLLATE
select * from customers
order by name collate nocase;

-- CAST
select cast(price as integer) as rounded_price
from products;

-- Parameters
-- (usually used in prepared statements)
select * from users where id = ? and status = ?;
select * from products where category = :category and price <= :max_price;
```

## 5. Functions

Quereus provides a rich set of built-in functions for data manipulation, calculation, and transformation. These functions follow SQL standards with some Quereus-specific extensions.

### 5.1 Scalar Functions

Scalar functions operate on single values and return a single value per row.

#### String Functions
- `lower(X)`: Returns the lowercase version of string X
- `upper(X)`: Returns the uppercase version of string X
- `length(X)`: Returns the length of string X in characters
- `substr(X, Y[, Z])`: Returns a substring of X starting at position Y (1-based) and Z characters long
- `substring(X, Y[, Z])`: Alias for `substr()`
- `trim(X[, Y])`: Removes leading and trailing characters Y from X
- `ltrim(X[, Y])`: Removes leading characters Y from X
- `rtrim(X[, Y])`: Removes trailing characters Y from X
- `replace(X, Y, Z)`: Replaces all occurrences of Y in X with Z
- `instr(X, Y)`: Returns the 1-based position of the first occurrence of Y in X
- `lpad(X, Y[, Z])`: Left-pads string X to length Y with string Z (default space)
- `rpad(X, Y[, Z])`: Right-pads string X to length Y with string Z (default space)
- `reverse(X)`: Returns string X with characters in reverse order
- `like(X, Y)`: Returns 1 if X matches pattern Y, 0 otherwise
- `glob(X, Y)`: Returns 1 if X matches glob pattern Y, 0 otherwise

**Examples:**
```sql
-- String manipulation
select 
  lower('HELLO') as lowercase,
  upper('world') as uppercase,
  length('Quereus') as str_length,
  substr('abcdef', 2, 3) as substring,
  trim('  test  ') as trimmed,
  replace('hello world', 'world', 'Quereus') as replaced;

-- Result:
-- lowercase | uppercase | str_length | substring | trimmed | replaced
-- 'hello'   | 'WORLD'   | 7          | 'bcd'     | 'test'  | 'hello Quereus'
```

#### Numeric Functions
- `abs(X)`: Returns the absolute value of X
- `round(X[, Y])`: Rounds X to Y decimal places
- `ceil(X)`, `ceiling(X)`: Returns the smallest integer not less than X
- `floor(X)`: Returns the largest integer not greater than X
- `pow(X, Y)`, `power(X, Y)`: Returns X raised to the power of Y
- `sqrt(X)`: Returns the square root of X
- `clamp(X, min, max)`: Constrains X to be between min and max
- `greatest(X, Y, ...)`: Returns the largest value from the arguments
- `least(X, Y, ...)`: Returns the smallest value from the arguments
- `random()`: Returns a random integer
- `randomblob(N)`: Returns a blob containing N bytes of pseudo-random data

**Examples:**
```sql
-- Numeric calculations
select 
  abs(-42) as absolute,
  round(3.14159, 2) as rounded,
  ceil(9.1) as ceiling,
  floor(9.9) as floor_val,
  pow(2, 8) as power_val,
  sqrt(144) as square_root,
  random() % 100 as random_num;

-- Result example:
-- absolute | rounded | ceiling | floor_val | power_val | square_root | random_num
-- 42       | 3.14    | 10      | 9         | 256       | 12          | 73
```

#### Conditional Functions
- `coalesce(X, Y, ...)`: Returns the first non-NULL value
- `nullif(X, Y)`: Returns NULL if X equals Y, otherwise returns X
- `iif(X, Y, Z)`: If X is true, returns Y, otherwise returns Z
- `choose(index, val0, val1, ...)`: Returns the value at the given index (0-based)

**Examples:**
```sql
-- Conditional logic
select 
  coalesce(null, null, 'third', 'fourth') as first_non_null,
  nullif(5, 5) as same_values,
  nullif(10, 20) as different_values,
  iif(age >= 18, 'adult', 'minor') as age_category
from users;

-- Result example:
-- first_non_null | same_values | different_values | age_category
-- 'third'        | null        | 10               | 'adult'
```

#### Type Functions
- `typeof(X)`: Returns the datatype of X as a string ('null', 'integer', 'real', 'text', or 'blob')

### 5.2 Aggregate Functions

Aggregate functions perform a calculation on a set of values and return a single value.

- `count(X)`: Returns the number of non-NULL values of X
- `count(*)`: Returns the number of rows
- `sum(X)`: Returns the sum of all non-NULL values of X
- `avg(X)`: Returns the average of all non-NULL values of X
- `min(X)`: Returns the minimum value of all non-NULL values of X
- `max(X)`: Returns the maximum value of all non-NULL values of X
- `group_concat(X[, Y])`: Returns a string concatenating non-NULL values of X, separated by Y (default ',')
- `total(X)`: Returns the sum as a floating-point value (returns 0.0 for empty set)
- `var_pop(X)`: Returns the population variance
- `var_samp(X)`: Returns the sample variance
- `stddev_pop(X)`: Returns the population standard deviation
- `stddev_samp(X)`: Returns the sample standard deviation
- `string_concat(X)`: Concatenates string values with comma separator

**Examples:**
```sql
-- Basic aggregates
select 
  count(*) as total_rows,
  count(email) as users_with_email,
  sum(cost) as total_cost,
  avg(age) as average_age,
  min(created_at) as earliest_record,
  max(score) as highest_score
from users;

-- Grouping with aggregates
select 
  department,
  count(*) as employee_count,
  avg(salary) as avg_salary,
  min(hire_date) as earliest_hire,
  group_concat(name, ', ') as employee_names
from employees
group by department;
```

### 5.3 JSON Functions

Quereus provides comprehensive functions for working with JSON data.

**JSON Query Functions:**
- `json_extract(json, path, ...)`: Extracts values from JSON using JSONPath
- `json_type(json[, path])`: Returns the type of JSON value ('object', 'array', 'string', 'number', 'boolean', 'null')
- `json_valid(json)`: Checks if a string is valid JSON (returns 1 or 0)
- `json_schema(json, schema_def)`: Validates JSON against a structural schema (returns 1 or 0)
- `json_array_length(json[, path])`: Returns the length of a JSON array

**JSON Construction Functions:**
- `json_object(key, value, ...)`: Creates a JSON object from key-value pairs
- `json_array(value, ...)`: Creates a JSON array from values
- `json_quote(value)`: Converts a SQL value to a JSON-quoted string

**JSON Modification Functions:**
- `json_insert(json, path, value, ...)`: Inserts values into JSON (does not overwrite existing)
- `json_replace(json, path, value, ...)`: Replaces existing values in JSON
- `json_set(json, path, value, ...)`: Sets values in JSON (inserts or replaces)
- `json_remove(json, path, ...)`: Removes values from JSON
- `json_patch(json, patch)`: Applies a JSON Patch (RFC 6902) to a JSON document

**JSON Aggregate Functions:**
- `json_group_array(X)`: Aggregate function that creates a JSON array from values
- `json_group_object(key, value)`: Aggregate function that creates a JSON object from key-value pairs

**JSON Table-Valued Functions:**
- `json_each(json[, path])`: Returns one row per element in a JSON array or object
- `json_tree(json[, path])`: Returns one row per node in the JSON tree structure

**Examples:**
```sql
-- JSON extraction
select
  json_extract('{"name":"John","age":30}', '$.name') as name,
  json_extract('{"name":"John","age":30}', '$.age') as age;

-- JSON creation
select
  json_object('name', 'Alice', 'age', 25) as person,
  json_array(1, 2, 3, 4, 5) as numbers;

-- JSON schema validation (using TypeScript-like syntax)
select json_schema('[1, 2, 3]', 'number[]');  -- Returns 1 (valid)
select json_schema('{"x": 42}', '{ x: number }');  -- Returns 1 (valid)
select json_schema('[{"x": 1}, {"x": 2}]', '{ x: number }[]');  -- Returns 1 (valid)

-- Enforcing JSON structure with CHECK constraints
create table api_events (
  id integer primary key,
  event_type text not null,
  payload json check (json_schema(payload, '{ timestamp: string, data: any }'))
);

-- Aggregating to JSON
select
  department,
  json_group_array(name) as employees,
  json_group_object(id, salary) as salary_map
from employees
group by department;
```

### 5.4 Date and Time Functions

Quereus includes functions for manipulating dates and times.

**Temporal Type Functions:**
- `date(timestring[, modifier...])`: Returns the date as 'YYYY-MM-DD'
- `time(timestring[, modifier...])`: Returns the time as 'HH:MM:SS'
- `datetime(timestring[, modifier...])`: Returns the date and time as 'YYYY-MM-DD HH:MM:SS'
- `timespan(duration_string)`: Returns a TIMESPAN from ISO 8601 duration or human-readable string
- `julianday(timestring[, modifier...])`: Returns the Julian day number
- `strftime(format, timestring[, modifier...])`: Returns a formatted date string
- `is_iso_date(X)`: Returns 1 if X is a valid ISO 8601 date, 0 otherwise
- `is_iso_datetime(X)`: Returns 1 if X is a valid ISO 8601 datetime, 0 otherwise

**Common modifiers:**
- `+N days`, `+N hours`, `+N minutes`, `+N seconds`, `+N months`, `+N years`
- `start of month`, `start of year`, `start of day`
- `weekday N` (0=Sunday, 1=Monday, etc.)
- `localtime`, `utc`

**Examples:**
```sql
-- Date functions
select
  date('now') as today,
  time('now', 'localtime') as current_time,
  datetime('now', '+1 day') as tomorrow,
  julianday('2023-01-01') - julianday('2022-01-01') as days_difference,
  strftime('%Y-%m-%d %H:%M', 'now') as formatted_now,
  strftime('%W', 'now') as week_of_year;

-- Date calculations
select
  date('now', '+7 days') as one_week_later,
  date('now', 'start of month', '+1 month', '-1 day') as last_day_of_month,
  datetime('now', 'weekday 1') as next_or_current_monday;

-- Timespan creation and arithmetic
select
  timespan('1 hour 30 minutes') as duration1,
  timespan('PT2H30M') as duration2,
  datetime('2024-01-15T09:00:00') + timespan('2 hours') as meeting_end,
  date('2024-01-15') + timespan('7 days') as next_week,
  timespan('3 hours') - timespan('45 minutes') as remaining;

-- Timespan comparisons
select * from events
where duration > timespan('1 hour')
order by duration desc;
```

### 5.5 Window Functions

Window functions perform calculations across a set of table rows related to the current row. Quereus provides comprehensive window function support with an extensible architecture.

**Window Function Syntax:**
```sql
window_function([arguments]) over (
  [partition by partition_expression [, ...]]
  [order by sort_expression [asc | desc] [, ...]]
  [window_frame_clause]
)
```

**Available Window Functions:**

**Ranking Functions:**
- `row_number()`: Returns a sequential row number within the partition
- `rank()`: Returns the rank with gaps (e.g., 1, 1, 3, 4)
- `dense_rank()`: Returns the rank without gaps (e.g., 1, 1, 2, 3)
- `ntile(n)`: Distributes rows into n buckets

**Aggregate Window Functions:**
- `count(*)`, `count(expr)`: Count of rows or non-NULL values
- `sum(expr)`: Sum of values in the window frame
- `avg(expr)`: Average of values in the window frame
- `min(expr)`, `max(expr)`: Minimum/maximum values in the window frame

**Navigation Functions (Planned):**
- `lead(expr[, offset[, default]])`: Accesses data from subsequent rows
- `lag(expr[, offset[, default]])`: Accesses data from previous rows
- `first_value(expr)`: Returns the first value in the window frame
- `last_value(expr)`: Returns the last value in the window frame

**Architecture Features:**
- **Extensible Registration**: Window functions are registered like scalar/aggregate functions
- **Performance Optimized**: Groups functions by window specifications for efficiency
- **Streaming Execution**: Non-partitioned functions use constant memory
- **Partitioned Execution**: PARTITION BY properly collects and processes partitions

**Examples:**
```sql
-- Ranking employees by salary within departments
select 
  name,
  department,
  salary,
  row_number() over (partition by department order by salary desc) as dept_rank,
  rank() over (order by salary desc) as overall_rank,
  dense_rank() over (partition by department order by salary desc) as dense_dept_rank
from employees;

-- Running totals and departmental statistics
select
  name,
  department,
  salary,
  sum(salary) over (partition by department order by hire_date) as running_dept_total,
  avg(salary) over (partition by department) as dept_average,
  count(*) over (partition by department) as dept_size
from employees;

-- Quartile analysis
select
  name,
  salary,
  ntile(4) over (order by salary) as salary_quartile
from employees;

-- Multiple window functions with same specification (optimized)
select
  product_id,
  sales_date,
  amount,
  sum(amount) over w as running_total,
  avg(amount) over w as running_average,
  count(*) over w as running_count
from sales
window w as (partition by product_id order by sales_date);
```

### 5.6 Table-Valued Functions

Table-valued functions return a result set that can be queried like a table.

**Generation Functions:**
- `generate_series(start, stop[, step])`: Generates a series of integer values from start to stop
- `split_string(str, delimiter)`: Splits a string into rows based on a delimiter

**Schema Introspection Functions:**
- `schema()`: Returns information about all tables, views, and functions across all schemas (columns: `schema`, `type`, `name`, `tbl_name`, `sql`)
- `table_info(table_name)`: Returns column information for a specific table
- `function_info([function_name])`: Returns information about all registered functions, or a given registered function

**Debugging and Analysis Functions:**
- `query_plan(sql)`: Returns the query execution plan for a SQL statement
- `scheduler_program(sql)`: Returns the scheduler program for a SQL statement
- `stack_trace(sql)`: Returns the execution stack trace
- `execution_trace(sql)`: Returns detailed execution trace information
- `row_trace(sql)`: Returns row-level trace information
- `explain_assertion(assertion_name)`: Returns information about a specific assertion

**Examples:**
```sql
-- Generate a series of numbers
select value from generate_series(1, 10);

-- Get schema information
select schema, type, name, sql from schema() where type = 'table';

-- Get column information for a table
select cid, name, type, notnull, pk from table_info('users');

-- Get function information
select name, num_args, type, deterministic from function_info();

-- Analyze query plan
select * from query_plan('select * from users where id = 1');
```

## 6. Virtual Tables

Virtual tables are Quereus's primary mechanism for accessing and manipulating data. They provide a table interface to various data sources through specialized modules.

### 6.1 Creating Virtual Tables

**Syntax:**
```sql
create table [if not exists] table_name [(column_def[, ...])]
using module_name [(module_arguments...)]
```

**Examples:**
```sql
-- Memory table with schema definition
create table users (
  id integer primary key,
  name text not null,
  email text unique,
  created_at text default (datetime('now'))
) using memory;

-- JSON table using the json_tree function
create table product_data
using json_tree('{"products":[{"id":1,"name":"Keyboard"},{"id":2,"name":"Mouse"}]}');

-- Create a memory table from a schema string
create table cache
using memory('create table x(key text primary key, value blob, expires integer)');
```

### 6.2 Built-in Virtual Table Modules

Quereus comes with several built-in virtual table modules:

#### 6.2.1 Memory Table Module

The `memory` module provides an in-memory, B+Tree-based storage with support for transactions, indices, and constraints.

**Key features:**
- Efficient in-memory storage
- Primary key and unique constraints
- Secondary index support via `create index`
- Transaction and savepoint support

**Examples:**
```sql
-- Create a memory table
create table products (
  id integer primary key,
  name text not null,
  price real check (price >= 0),
  category text
) using memory;

-- Create a secondary index
create index idx_products_category on products(category);

-- Insert data
insert into products (name, price, category) 
values 
  ('Laptop', 999.99, 'Electronics'),
  ('Desk Chair', 199.99, 'Furniture');

-- Query with index
select * from products where category = 'Electronics';
```

#### 6.2.2 JSON Table Modules

Quereus provides two modules for working with JSON data:

**json_each**: Expands a JSON array into rows
```sql
-- Create table from JSON array
create table users using json_each('[
  {"id":1,"name":"Alice","role":"admin"},
  {"id":2,"name":"Bob","role":"user"}
]');

-- Query expanded JSON
select key, value from users where key = 'name';
-- Result: 'name', 'Alice' and 'name', 'Bob'
```

**json_tree**: Expands a JSON structure recursively
```sql
-- Create and query a json_tree table
with json_data as (
  select '{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}' as json
)
select key, value, fullkey, path
from json_tree(
  (select json from json_data)
)
where path like '$.users[%].name';
-- Results in rows with users' names
```

#### 6.2.3 Schema Table Module

The `_schema` module provides access to schema information:

```sql
-- Query schema information
select * from _schema;
-- Returns information about tables, indexes, and views
```

### 6.3 Indexes on Virtual Tables

Virtual tables that support indexing (like the `memory` module) can have indexes created using standard SQL syntax.

**Syntax:**
```sql
create [unique] index [if not exists] index_name
on table_name (indexed_column[, ...])
```

**Examples:**
```sql
-- Simple index on a single column
create index idx_users_email on users(email);

-- Composite index on multiple columns
create index idx_orders_customer_date on orders(customer_id, order_date);

-- Unique index
create unique index idx_products_sku on products(sku);

-- Per-column COLLATE (and direction): the index orders/compares this column
-- under the given collation, overriding the table column's collation. A bare
-- `col COLLATE x` is a per-column collation, not an expression index; a genuine
-- expression operand (e.g. `lower(name)`) is still rejected.
create index idx_users_email_ci on users(email collate nocase desc);
```

## 7. Constraints and Indexes

### 7.1 Primary Key Constraint

The primary key constraint uniquely identifies each record in a table.

**Syntax - Column Constraint:**
```sql
column_name data_type primary key [asc|desc] [conflict_clause] [autoincrement]
```

**Syntax - Table Constraint:**
```sql
primary key (column[, ...]) [conflict_clause]
```

**Examples:**
```sql
-- Single-column primary key
create table users (
  id integer primary key autoincrement,
  username text not null
);

-- Composite primary key (table constraint)
create table order_items (
  order_id integer,
  product_id integer,
  quantity integer not null,
  primary key (order_id, product_id)
);

-- Primary key with descending order
create table logs (
  timestamp integer primary key desc,
  event text not null
);
```

### 7.2 NOT NULL Constraint

The not null constraint ensures that a column cannot have a NULL value.

**Syntax:**
```sql
column_name data_type not null [conflict_clause]
```

**Example:**
```sql
create table contacts (
  id integer primary key,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text
);
```

### 7.3 UNIQUE Constraint

The unique constraint ensures that all values in a column are different.

**Syntax - Column Constraint:**
```sql
column_name data_type unique [conflict_clause]
```

**Syntax - Table Constraint:**
```sql
unique (column[, ...]) [conflict_clause]
```

**Examples:**
```sql
-- Single-column unique constraint
create table users (
  id integer primary key,
  email text unique,
  username text unique
);

-- Multi-column unique constraint
create table bookings (
  id integer primary key,
  room_id integer,
  date text,
  unique (room_id, date)
);
```

### 7.4 CHECK Constraint

The check constraint ensures that values in a column satisfy a specific condition.

**Syntax - Column Constraint:**
```sql
column_name data_type check [on operation_list] (expression)
```

**Syntax - Table Constraint:**
```sql
check [on operation_list] (expression)
```

The optional `on operation_list` specifies when the constraint should be checked (insert, update, delete).

**Examples:**
```sql
-- Column-level check constraint
create table products (
  id integer primary key,
  name text not null,
  price real check (price > 0),
  discount real check (discount >= 0 and discount <= 1)
);

-- Table-level check constraint
create table transfers (
  id integer primary key,
  source_account_id integer not null,
  dest_account_id integer not null,
  amount real not null check (amount > 0),
  check (source_account_id != dest_account_id)
);

-- Operation-specific check constraint
create table audit_log (
  id integer primary key,
  record_id integer not null,
  action text not null,
  timestamp text not null,
  check on insert (action in ('insert', 'update', 'delete'))
);

-- JSON structure validation with check constraint
create table events (
  id integer primary key,
  event_type text not null,
  data json check (json_schema(data, '[{x:integer,y:number}]'))
);

-- Complex JSON schema validation
create table api_logs (
  id integer primary key,
  endpoint text not null,
  request json check (json_schema(request, '{ method: string, headers: any, body: any }')),
  response json check (json_schema(response, '{ status: number, body: any }'))
);
```

### 7.5 DEFAULT Constraint

The default constraint provides a default value for a column when no value is specified.

**Syntax:**
```sql
column_name data_type default value
```

**Examples:**
```sql
-- Constant default value
create table posts (
  id integer primary key,
  title text not null,
  content text,
  views integer default 0,
  status text default 'draft'
);

-- Function-based default
create table audit_records (
  id integer primary key,
  action text not null,
  timestamp text default (datetime('now'))
);
```

### 7.6 FOREIGN KEY Constraint

The foreign key constraint links tables together and ensures referential integrity.

Foreign key enforcement is controlled by the `foreign_keys` pragma (default: on):

```sql
pragma foreign_keys = on;   -- enable FK enforcement (default)
pragma foreign_keys = off;  -- parse but don't enforce
```

When no `ON DELETE` or `ON UPDATE` clause is specified, the default action is `RESTRICT`. `NO ACTION` is currently treated as a synonym for `RESTRICT`.

**Syntax - Column Constraint:**
```sql
column_name data_type references [schema.]foreign_table [(column)] [ref_actions]
```

**Syntax - Table Constraint:**
```sql
foreign key (column[, ...]) references [schema.]foreign_table [(column[, ...])] [ref_actions]
```

The parent table may be **schema-qualified** (`references other_schema.parent(id)`),
so a child in one schema can reference a parent in another. An unqualified parent
defaults to the child's own schema and persists with no qualifier (byte-identical
to a same-schema FK). All reference actions (RESTRICT / CASCADE / SET NULL /
SET DEFAULT) and `foreign_key_info()`'s `referenced_schema` column work the same
across schemas.

**Reference Actions:**
```sql
[on delete action] [on update action]
```

Where `action` can be:
- `set null` — set child FK columns to NULL when parent row is deleted/updated
- `set default` — set child FK columns to their default values
- `cascade` — delete/update child rows when parent row is deleted/updated
- `restrict` (default) — immediately reject delete/update if child rows exist
- `no action` — currently treated as a synonym for `restrict`

**Enforcement Semantics:**

When `pragma foreign_keys = on` (the default):

- **Child-side (INSERT/UPDATE):** Validates that referenced parent rows exist. These checks are deferred to commit time (they use cross-table subqueries). Uses MATCH SIMPLE semantics (SQL default): if any FK column is NULL, the constraint is satisfied without checking the parent table. If the referenced parent table does not exist, non-NULL FK rows are rejected.
- **Parent-side DELETE/UPDATE with RESTRICT:** Immediately rejects the operation if child rows reference the parent row being modified. Two layers of enforcement run: a plan-time `NOT EXISTS` synthesized into the DML's constraint-check node, and a runtime `select 1 from <child> where <fk> = ? limit 1` pre-check fired by the DML executor before the vtab `xUpdate` call. The runtime pass is defense-in-depth so any vtab module — including those whose subquery evaluation diverges from a plain row scan — sees a consistent enforcement path. The check honours MATCH SIMPLE (NULL parent values cannot be referenced) and, on UPDATE, skips when no referenced parent column actually changed.
- **Parent-side DELETE/UPDATE with CASCADE:** Automatically deletes or updates matching child rows.
- **Parent-side DELETE/UPDATE with SET NULL:** Sets child FK columns to NULL.
- **Parent-side DELETE/UPDATE with SET DEFAULT:** Sets child FK columns to their default values.

Cascade cycle detection prevents infinite recursion when cascading actions chain across multiple tables.

**Examples:**
```sql
-- Column-level foreign key (no action clause = RESTRICT default)
create table posts (
  id integer primary key,
  user_id integer references users(id),
  title text not null
);

-- Table-level foreign key with explicit actions
create table comments (
  id integer primary key,
  post_id integer,
  user_id integer,
  content text not null,
  foreign key (post_id) references posts(id) on delete cascade,
  foreign key (user_id) references users(id) on delete set null
);
```

### 7.7 Creating Indexes

Indexes improve query performance for specific columns.

**Syntax:**
```sql
create [unique] index [if not exists] index_name
on table_name (column [asc|desc][, ...]) [where condition]
```

**Examples:**
```sql
-- Simple index
create index idx_users_email on users(email);

-- Multi-column index
create index idx_posts_user_date on posts(user_id, created_at desc);

-- Partial index with WHERE clause
create index idx_active_users on users(last_login) where status = 'active';

-- Unique index
create unique index idx_products_sku on products(sku);
```

### 7.8 Dropping Indexes

**Syntax:**
```sql
drop index [if exists] index_name
```

**Example:**
```sql
drop index idx_users_email;
```

## 8. Transactions and Savepoints

Transactions group multiple operations into a single unit that either succeeds completely or fails completely.

### 8.1 BEGIN Transaction

Starts a new transaction.

**Syntax:**
```sql
begin [transaction]
```

**Examples:**
```sql
-- Start a transaction
begin;

-- Start a transaction with explicit keyword
begin transaction;
```

### 8.2 COMMIT Transaction

Saves all changes made during the current transaction.

**Syntax:**
```sql
commit [transaction]
```

**Example:**
```sql
-- Commit the current transaction
commit;
```

### 8.3 ROLLBACK Transaction

Discards all changes made during the current transaction.

**Syntax:**
```sql
rollback [transaction]
```

**Example:**
```sql
-- Discard all changes in the current transaction
rollback;
```

### 8.4 Savepoints

Savepoints allow partial transaction rollbacks.

**Create a savepoint:**
```sql
savepoint savepoint_name
```

**Rollback to a savepoint:**
```sql
rollback [transaction] to [savepoint] savepoint_name
```

**Release a savepoint:**
```sql
release [savepoint] savepoint_name
```

**Example:**
```sql
-- Transaction with savepoints
begin;

insert into users (name, email) values ('Alice', 'alice@example.com');

savepoint after_alice;

insert into users (name, email) values ('Bob', 'bob@example.com');

-- Oops, we made a mistake with Bob
rollback to savepoint after_alice;

-- Only Alice is inserted, Bob's insert was rolled back
insert into users (name, email) values ('Charlie', 'charlie@example.com');

-- Release a savepoint (optional, mostly for cleanup)
release savepoint after_alice;

commit;
```

### 8.5 Transaction Best Practices

1. **Explicit Transactions**: Always use explicit transactions for multi-statement operations.
2. **Error Handling**: Combine transactions with proper error handling to ensure rollback on failure.
3. **Transaction Size**: Keep transactions as short as possible to reduce lock contention.
4. **Savepoints**: Use savepoints for partial rollback instead of entire transaction rollback.

**JavaScript Example with Quereus:**
```javascript
// Using explicit transactions in JavaScript
try {
  await db.exec("begin");
  
  const orderId = await db.get("insert into orders (customer_id, total) values (?, ?) returning (id)", [42, 129.99]);
  
  await db.exec("insert into order_items (order_id, product_id, quantity) values (?, ?, ?)",
    [orderId, 101, 2]);
  await db.exec("insert into order_items (order_id, product_id, quantity) values (?, ?, ?)",
    [orderId, 205, 1]);
  
  await db.exec("commit");
  console.log("Transaction committed successfully");
} catch (error) {
  await db.exec("rollback");
  console.error("Transaction failed:", error);
}
```

## 9. PRAGMA Statements

PRAGMA statements are special commands that control the behavior of the Quereus database engine.

### 9.1 Basic Syntax

```sql
pragma name = value;
pragma name;  -- query the current value
```

### 9.2 Supported PRAGMA Statements

#### 9.2.1 default_vtab_module

Sets or queries the default virtual table module used when `create table` is called without a specific `using` clause.

```sql
-- Set default module to "memory"
pragma default_vtab_module = 'memory';

-- Query current default module
pragma default_vtab_module;
```

#### 9.2.2 default_vtab_args

Sets or queries the default arguments passed to the default virtual table module. The value should be a JSON array of strings.

```sql
-- Set default args for the default module
pragma default_vtab_args = '["create table x(id integer primary key, data text)"]';

-- Query current default args
pragma default_vtab_args;
```

#### 9.2.3 default_column_nullability

**🚨 IMPORTANT: Departure from SQL Standard**

Sets or queries the default nullability behavior for columns. This is a significant departure from the SQL standard, aligning with [The Third Manifesto](https://www.dcs.warwick.ac.uk/~hugh/TTM/DTATRM.pdf) principles which advocate against NULL by default.

**Values:**
- `'not_null'` (default): Columns are NOT NULL by default unless explicitly declared otherwise
- `'nullable'`: Standard SQL behavior - columns are nullable by default unless explicitly declared NOT NULL

```sql
-- Set to Third Manifesto behavior (default in Quereus)
pragma default_column_nullability = 'not_null';

-- Set to SQL standard behavior  
pragma default_column_nullability = 'nullable';

-- Query current setting
pragma default_column_nullability;
```

**Rationale:**
The Third Manifesto argues that NULL is fundamentally problematic in relational theory and that non-nullable types should be the default. Quereus follows this principle to avoid the "billion-dollar mistake" of NULL by default, while still allowing NULLs when explicitly needed.

**Examples:**

```sql
-- With default_column_nullability = 'not_null' (Quereus default)
create table users (
  id integer primary key, -- Implicitly NOT NULL
  name text,           -- Implicitly NOT NULL
  email text,          -- Implicitly NOT NULL  
  bio text null        -- Explicitly allows NULL
);

-- With default_column_nullability = 'nullable' (SQL standard)
create table users (
  id integer primary key, -- Implicitly NOT NULL
  name text,           -- Allows NULL
  email text not null, -- Explicitly NOT NULL
  bio text             -- Allows NULL
);
```

**Note:** Primary key columns are always NOT NULL regardless of this setting.

#### 9.2.4 default_collation

Sets or queries the default **declared collation** for columns that carry no explicit
`COLLATE` clause. Defaults to `'BINARY'`, so out of the box there is no behavior change —
opt into `'NOCASE'` / `'RTRIM'` / any registered collation per database.

**Values:**
- `'BINARY'` (default): omitted-`COLLATE` columns are byte-compared (case-sensitive).
- `'NOCASE'` / `'RTRIM'` / any registered collation name: omitted-`COLLATE` columns resolve
  to that collation, **but only for types that support it** (text). Non-text columns
  (`INTEGER`/`REAL`/`BLOB`) and empty-collation types (`JSON`, temporal) fall back to
  `BINARY`. An invalid collation name is rejected at set time (the pragma value rolls back).

```sql
-- Make omitted-COLLATE text columns case-insensitive for this database
pragma default_collation = 'nocase';

create table users (
  id integer primary key,     -- INTEGER → BINARY (NOCASE unsupported)
  name text,                  -- TEXT, no COLLATE → resolves to NOCASE
  code text collate binary    -- explicit COLLATE always wins → BINARY
);

-- Query current setting
pragma default_collation;

-- Restore byte-comparison default
pragma default_collation = 'binary';
```

**Semantics (important):** `default_collation` is a **schema-authoring convenience
only**. The catalog always stores the concrete, resolved collation, and persisted DDL always
emits an explicit `COLLATE` for any non-`BINARY` collation. So a table created under
`default_collation = 'nocase'` round-trips its `NOCASE` columns unambiguously even when the
database is later reopened (or its DDL re-executed) under a different — or the default —
`default_collation`. An explicit `COLLATE` clause always overrides the session default.

`ALTER TABLE ... ADD COLUMN` honors the default the same way `CREATE TABLE` does: an added
text column with no explicit `COLLATE` resolves to the session default (non-text falls back to
`BINARY`), so an added column gets the same collation a `CREATE`-d one would. `RENAME COLUMN`
deliberately does **not** consult the default — it preserves the renamed column's existing
collation rather than re-resolving it to the current session setting.

Because "the catalog always stores the concrete, resolved collation" is enforced by emitting an
explicit `COLLATE` for every non-`BINARY` collation, a column whose collation came from the
session default is *defaulted* in-session (rank 1, `default`) but reloads as *declared* (rank 2)
after a reopen or DDL re-execution — the re-parsed `COLLATE` clause is indistinguishable from a
hand-written one. This is intended: the comparison-collation rank may rise from rank 1 to rank 2
across the persistence boundary, and the only observable effect is *stricter* (fail-louder)
conflict detection — a comparison that previously resolved silently can become a prepare-time
ambiguous-collation error, never silently different results (see docs/types.md § Comparison
collation resolution). `ALTER COLUMN ... SET COLLATE` likewise marks the collation explicit
(rank 2) in-session, with the same standing as a CREATE-time `COLLATE`.

#### 9.2.5 nondeterministic_schema

Allows non-deterministic expressions (`random()`, `datetime('now')`, user-defined functions
marked non-deterministic, etc.) inside DEFAULT, CHECK, and `GENERATED ALWAYS AS` clauses.
Defaults to `false` (strict rejection) for backward compatibility.

**Aliases:** `allow_nondeterministic_schema_expressions`

**Values:**
- `false` (default) — strict rejection: a CREATE TABLE / INSERT / UPDATE that compiles a
  non-deterministic expression in a DEFAULT, CHECK, or generated-column clause raises
  `Non-deterministic expression not allowed in …`.
- `true` — permit non-deterministic expressions. Per-row evaluation still produces a
  concrete literal at the `vtab.update()` frontier (captured in `args.values` and in the
  literal SQL produced by `buildInsertStatement` / `buildUpdateStatement` /
  `buildDeleteStatement`), so the replay contract — "apply primitives at the module-layer
  boundary" — is preserved.

```sql
-- Default: strict rejection
create table t (id integer primary key, ts text default datetime('now'));
-- error: Non-deterministic expression not allowed in DEFAULT

-- Relax the gate
pragma nondeterministic_schema = true;

create table audit (
  id integer primary key,
  ts text default datetime('now'),         -- now permitted
  tag integer generated always as (random()) stored
);

insert into audit (id) values (1);
-- The row stored carries a concrete ts string and concrete tag integer.
```

**Scope:** The option is read at validation time. Toggling it affects validation of
*subsequent* DDL / DML only; tables already created retain whatever expressions they
were created with. The option is not baked into any persisted schema.

**See also:** [Determinism Validation](runtime.md#determinism-validation) for the full
replay-contract discussion, and [Mutation Statements](module-authoring.md#mutation-statements)
for how the captured artifact is structured.

#### 9.2.6 schema_path

Sets or queries the default schema search path used when resolving unqualified table names. The value is a comma-separated list of schema names.

**Values:**
- Comma-separated list of schema names (e.g., `'main,extensions,plugins'`)
- Empty string or `'main'` to use only the default schema

```sql
-- Set search path for the connection
pragma schema_path = 'main,extensions,plugins';

-- Query current search path
pragma schema_path;
-- Returns: "main,extensions,plugins"

-- Reset to default
pragma schema_path = 'main';
```

**Resolution Order:**

When resolving unqualified table names:
1. Qualified names (`schema.table`) are used exactly as specified
2. `WITH SCHEMA` clause on the statement (highest priority)
3. `PRAGMA schema_path` setting (session default)
4. Default schema (`main`)

**Examples:**

```sql
-- Set search path for the session
pragma schema_path = 'workspace,main';

-- All subsequent queries use this path
select * from users;  -- Searches workspace.users, then main.users

-- Override per-query with WITH SCHEMA
select * from users with schema main;  -- Only searches main.users
```

### 9.3 Examples

```sql
-- Configure default VTab settings
pragma default_vtab_module = 'memory';
pragma default_vtab_args = '[]';

-- Set Third Manifesto-aligned nullability (default)
pragma default_column_nullability = 'not_null';

-- Set schema search path
pragma schema_path = 'main,extensions';

-- Create a table using the default module and nullability
create table simple_cache (
  key text primary key,
  value text              -- NOT NULL by default with 'not_null' setting
);
-- Equivalent to: create table simple_cache (...) using memory;

-- Tables will be resolved from main first, then extensions
select * from users;  -- Searches main.users, then extensions.users
```

### 9.4 Transactions Control PRAGMAs

These PRAGMAs are parsed but may not affect behavior in the same way as SQLite due to Quereus's virtual table-centric architecture.

```sql
pragma journal_mode = 'memory';
pragma synchronous = 'off';
```

### 9.5 ANALYZE

The `ANALYZE` command collects table statistics for cost-based query optimization. Statistics include row counts, per-column distinct value counts, null counts, min/max values, and equi-height histograms for selectivity estimation.

```sql
-- Analyze all tables in the default schema
analyze;

-- Analyze a specific table
analyze products;

-- Analyze a table in a specific schema
analyze main.products;

-- Analyze every table in a specific schema
analyze main.*;
```

`ANALYZE` returns one row per table with columns `table` (text) and `rows` (integer).

If a virtual table module implements `getStatistics()`, those statistics are used directly. Otherwise, a full table scan collects per-column statistics with reservoir-sampled histograms. Collected statistics are cached on the table schema and used by the optimizer's `CatalogStatsProvider` for improved cost estimates.

## 10. Error Handling

Quereus provides structured error handling through the `QuereusError` class hierarchy. Understanding these errors helps in debugging and creating robust applications.

### 10.1 Error Types

#### 10.1.1 QuereusError

The base error class for all Quereus errors. Contains:
- `message`: Description of the error
- `code`: A `StatusCode` value indicating the error type
- `cause`: Optional underlying error
- `line`, `column`: Position information when available

#### 10.1.2 ParseError

Specialized error for syntax problems during SQL parsing:
- Contains token information
- Includes precise position information

#### 10.1.3 MisuseError

Indicates API misuse, such as:
- Operating on a closed database
- Invalid parameter binding
- Interface contract violations

#### 10.1.4 ConstraintError

Indicates constraint violations, such as:
- Unique constraint violations
- NOT NULL constraint violations
- CHECK constraint failures

### 10.2 Error Status Codes

Important status codes include:

- `ERROR`: Generic error
- `INTERNAL`: Internal logic error
- `CONSTRAINT`: Constraint violation 
- `MISUSE`: Library misuse
- `RANGE`: Parameter out of range
- `NOTFOUND`: Item not found

### 10.3 Handling Errors in Applications

**JavaScript Example:**

```javascript
try {
  await db.exec("insert into users (email, username) values (?, ?)", 
    ['user@example.com', 'newuser']);
  console.log("Insert successful");
} catch (error) {
  if (error.code === StatusCode.CONSTRAINT) {
    console.error("Constraint violation:", error.message);
    // Handle specific constraint error (e.g., duplicate email)
  } else if (error instanceof ParseError) {
    console.error("SQL syntax error at line", error.line, "column", error.column);
  } else {
    console.error("Database error:", error.message);
  }
}
```

### 10.4 Common Error Scenarios

#### Syntax Errors

```sql
-- Missing FROM clause (will cause ParseError)
select id, name where status = 'active';
```

#### Constraint Violations

```sql
-- Assuming unique constraint on email (will cause ConstraintError)
insert into users (email) values ('existing@example.com');
```

#### Schema Errors

```sql
-- Reference to non-existent table (will cause QuereusError)
select * from nonexistent_table;
```

#### Type Errors

```sql
-- Type mismatch in operation (may cause runtime error)
select 'text' + 42 from users;
```

## 11. Quereus vs. SQLite

While Quereus supports similar SQL syntax, it has evolved into a distinct system with significant architectural and design differences from SQLite. Understanding these differences is important when porting applications from SQLite or creating new applications with Quereus.

### 11.1 Key Similarities

- SQL syntax is largely compatible
- Core DML (select, insert, update, delete) support
- Transaction and savepoint support
- Similar built-in function set
- Parameter binding with `?`, `:name`, and `$name`

### 11.2 Key Differences

#### 11.2.1 Type System

**Quereus:**
- Modern logical/physical type separation
- Native temporal types (DATE, TIME, DATETIME) using Temporal API
- Native JSON type with deep equality comparison
- Conversion functions (`integer()`, `date()`, `json()`) preferred over CAST
- Plugin-extensible custom types
- See [Type System Documentation](types.md)

**SQLite:**
- Type affinity model (INTEGER, REAL, TEXT, BLOB, NUMERIC)
- Dates stored as TEXT, REAL, or INTEGER
- JSON support via JSON1 extension (text-based)
- CAST operator for type conversion
- Limited type extensibility

#### 11.2.2 Architecture

**Quereus:**
- All tables are virtual tables
- No built-in file storage
- In-memory default with `memory` module
- Async/await API design for JavaScript

**SQLite:**
- Physical disk-based tables by default with optional virtual tables
- Built around persistent file storage
- Synchronous C API

#### 11.2.3 Feature Support

| Feature | Quereus | SQLite |
|---------|---------|--------|
| **Type System** | Logical/physical separation, temporal types, JSON | Type affinity model |
| **File Storage** | Supported via modules | Built-in |
| **Virtual Tables** | Central to design; all tables are virtual | Additional feature |
| **Triggers** | Not supported | Supported |
| **Views** | Basic support | Full support |
| **Foreign Keys** | Supported (on by default; requires explicit action clauses) | Full support (when enabled) |
| **Window Functions** | Phase 1 Complete (ranking, aggregates, partitioning) | Full support |
| **Recursive CTEs** | Basic support | Full support |
| **JSON Functions** | Extensive support with native JSON type | Available as extension |
| **Indexes** | Depends on VTab module | Full support |
| **BLOB I/O** | Basic support | Advanced support |
| **`OR <action>` modifier** | `INSERT OR <action>` only; UPDATE/DELETE deliberately omitted (use schema-level `ON CONFLICT` or rewrite) | `INSERT/UPDATE/DELETE OR <action>` (SQLite-specific extension) |

#### 11.2.4 Syntax Extensions

Quereus provides some syntax extensions:

```sql
-- Quereus: CREATE TABLE with USING clause for virtual tables
create table users (id integer primary key, name text) using memory;

-- Quereus: Temporal and JSON types
create table events (
  id integer primary key,
  event_date date,
  event_time time,
  created_at datetime,
  metadata json,  -- Extra commas are OK
);

-- Quereus: Conversion functions instead of CAST
select integer('42'), date('2024-01-15'), json('{"x":1}');

-- Quereus: PRIMARY KEY with ASC/DESC qualifier
create table logs (timestamp integer primary key desc, event text);

-- Quereus: CHECK constraints with operation specificity
create table products (
  price real check on insert (price >= 0),
  stock integer check on update (stock >= 0)
);

-- Quereus: Empty keys = singleton table (0-1 rows)
create table settings (
  knob integer,
  primary key ()
);

-- Quereus: Declarative DDL
declare schema Movies {
  table movie (id integer primary key,
    -- ...
  )
}
apply schema Movies;
```

Quereus also has row contraints with old/new context, mutation contexts, `with tags` metadata, and many more features.

#### 11.2.5 Performance Characteristics

- **Quereus**: JavaScript-based with optimization for federated operations (handed off to modules)
- **SQLite**: C-based with focus on disk I/O efficiency

### 11.3 Migration Considerations

When migrating from SQLite to Quereus:

1. **Type System**: Update date/time columns to use DATE, TIME, DATETIME types. Consider using JSON type for structured data. Replace CAST with conversion functions.
2. **Storage Strategy**: Determine how to handle persistence (quereus-plugin-indexeddb, quereus-plugin-leveldb, etc.)
3. **Async Handling**: Convert synchronous SQLite code to async/await with Quereus
4. **Feature Check**: Review use of triggers, advanced views, enforced foreign keys
5. **Transaction Model**: Similar, but understand Quereus's virtual table transaction model
6. **Custom Functions**: Port custom SQL functions to JavaScript

### 11.4 Future Roadmap

Quereus is actively developed with plans to add:
- Advanced window function features (navigation functions, window frames)
- Enhanced recursive CTE capabilities  
- More query planning enhancements

## 12. EBNF Grammar

Below is a formal Extended Backus-Naur Form (EBNF) grammar for Quereus's SQL dialect, based on the parser implementation.

### 12.1 Notation

- `[ a ]`: Optional element a
- `{ a }`: Zero or more repetitions of a
- `a | b`: Either a or b
- `( a )`: Grouping
- `"a"`: Literal terminal symbol
- `a b`: Sequence: a followed by b

### 12.2 Grammar

```ebnf
/* Top-level constructs */
sql_script         = { sql_statement ";" } ;

sql_statement      = [ with_clause ] ( select_stmt
                    | insert_stmt
                    | update_stmt
                    | delete_stmt
                    | values_stmt
                    | create_table_stmt
                    | create_index_stmt
                    | create_view_stmt
                    | create_materialized_view_stmt
                    | refresh_materialized_view_stmt
                    | create_assertion_stmt
                    | drop_stmt
                    | alter_table_stmt
                    | begin_stmt
                    | commit_stmt
                    | rollback_stmt
                    | savepoint_stmt
                    | release_stmt
                    | pragma_stmt
                    | analyze_stmt
                    | declare_schema_stmt
                    | declare_lens_stmt
                    | diff_schema_stmt
                    | apply_schema_stmt
                    | explain_schema_stmt ) ;

/* WITH clause and CTEs */
with_clause        = "with" [ "recursive" ] common_table_expr { "," common_table_expr } [ option_clause ] ;

option_clause      = "option" "(" "maxrecursion" integer ")" ;

common_table_expr  = cte_name [ "(" column_name { "," column_name } ")" ] 
                     "as" [ "materialized" | "not" "materialized" ]
                     "(" ( select_stmt | insert_stmt | update_stmt | delete_stmt ) ")" ;

cte_name           = identifier ;

/* SELECT statement */
select_stmt        = simple_select [ compound_operator simple_select ]* [ order_by_clause ] [ limit_clause ] ;

simple_select      = "select" [ distinct_clause ] result_column { "," result_column }
                     [ from_clause ]
                     [ where_clause ]
                     [ group_by_clause ]
                     [ having_clause ]
                     [ with_schema_clause ] ;

distinct_clause    = "distinct" | "all" ;

result_column      = "*" | table_name "." "*"
                   | expr [ [ "as" ] column_alias ] [ with_inverse_clause ] ;

with_inverse_clause = "with" "inverse" "(" column_name "=" expr { "," column_name "=" expr } ")" ;
                     (* authored write-back expressions for updatable views — see view-updateability.md *)

from_clause        = "from" table_or_subquery { "," table_or_subquery } ;

table_or_subquery  = table_name [ [ "as" ] table_alias ] 
                   | "(" select_stmt ")" [ "as" ] table_alias
                   | "(" ( insert_stmt | update_stmt | delete_stmt ) ")" [ "as" ] table_alias
                   | function_name "(" [ expr { "," expr } ] ")" [ [ "as" ] table_alias ]
                   | join_clause ;

join_clause        = table_or_subquery { join_operator table_or_subquery join_constraint } ;

join_operator      = ","
                   | [ "left" [ "outer" ] | "inner" | "cross" | "right" [ "outer" ] | "full" [ "outer" ] ] "join" [ "lateral" ] ;

join_constraint    = [ "on" expr | "using" "(" column_name { "," column_name } ")" ] ;

where_clause       = "where" expr ;

group_by_clause    = "group" "by" expr { "," expr } ;

having_clause      = "having" expr ;

compound_operator  = "union" [ "all" ] | "intersect" | "except" | "diff" ;

order_by_clause    = "order" "by" ordering_term { "," ordering_term } ;

ordering_term      = expr [ "asc" | "desc" ] [ "nulls" ( "first" | "last" ) ] ;

limit_clause       = "limit" expr [ ( "offset" expr ) | ( "," expr ) ] ;

/* INSERT statement */
insert_stmt        = "insert" [ "or" conflict_resolution ] "into" table_name
                     [ "(" column_name { "," column_name } ")" ]
                     ( values_clause | select_stmt )
                     { upsert_clause }
                     { context_clause | tags_clause }
                     [ with_schema_clause ]
                     [ returning_clause ] ;

conflict_resolution = "rollback" | "abort" | "fail" | "ignore" | "replace" ;

upsert_clause      = "on" "conflict" [ "(" column_name { "," column_name } ")" ]
                     ( "do" "nothing" | "do" "update" "set" column_name "=" expr
                       { "," column_name "=" expr } [ where_clause ] ) ;

values_clause      = "values" "(" expr { "," expr } ")" { "," "(" expr { "," expr } ")" } ;

values_stmt        = values_clause [ order_by_clause ] [ limit_clause ] ;

/* UPDATE statement */
update_stmt        = "update" table_name
                     "set" column_name "=" expr { "," column_name "=" expr }
                     [ where_clause ]
                     { context_clause | tags_clause }
                     [ with_schema_clause ]
                     [ returning_clause ] ;

/* DELETE statement */
delete_stmt        = "delete" "from" table_name [ where_clause ]
                     { context_clause | tags_clause }
                     [ with_schema_clause ]
                     [ returning_clause ] ;

context_clause     = "with" "context" context_assignment { "," context_assignment } ;

context_assignment = identifier "=" expr ;

with_schema_clause = "with" "schema" schema_name { "," schema_name } ;

returning_clause   = "returning" [ qualifier "." ] "*" { "," [ qualifier "." ] "*" }
                   | "returning" [ qualifier "." ] expr [ [ "as" ] column_alias ]
                     { "," [ qualifier "." ] expr [ [ "as" ] column_alias ] } ;

qualifier          = "old" | "new" ;

/* CREATE TABLE statement */
create_table_stmt  = "create" "table" [ "if" "not" "exists" ]
                     table_name "(" column_def { "," ( column_def | table_constraint ) } ")"
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ]
                     { context_def_clause | tags_clause } ;

context_def_clause = "with" "context" "(" context_var_def { "," context_var_def } ")" ;

context_var_def    = identifier type_name [ "null" ] ;

tags_clause        = "with" "tags" "(" tag_entry { "," tag_entry } ")" ;

tag_entry          = identifier "=" tag_value ;

tag_value          = string_literal | signed_number | "true" | "false" | "null" ;

column_def         = column_name [ type_name ] { column_constraint } [ tags_clause ] ;

type_name          = identifier [ "(" signed_number [ "," signed_number ] ")" ] ;

column_constraint  = [ "constraint" name ]
                     ( primary_key_clause
                     | "not" "null" [ conflict_clause ]
                     | "unique" [ conflict_clause ]
                     | "check" [ "on" row_op_list ] "(" expr ")"
                     | "default" ( signed_number | literal_value | "(" expr ")" )
                     | "collate" collation_name
                     | foreign_key_clause
                     | "generated" "always" "as" "(" expr ")" [ "stored" | "virtual" ] )
                     [ tags_clause ] ;

primary_key_clause = "primary" "key" [ ( "asc" | "desc" ) ] [ conflict_clause ] [ "autoincrement" ] ;

table_constraint   = [ "constraint" name ]
                     ( "primary" "key" "(" indexed_column { "," indexed_column } ")" [ conflict_clause ]
                     | "unique" "(" column_name { "," column_name } ")" [ conflict_clause ]
                     | "check" [ "on" row_op_list ] "(" expr ")"
                     | "foreign" "key" "(" column_name { "," column_name } ")" foreign_key_clause )
                     [ tags_clause ] ;

foreign_key_clause = "references" foreign_table [ "(" column_name { "," column_name } ")" ]
                     { [ "on" ( "delete" | "update" ) ( "set" "null" | "set" "default" | "cascade" | "restrict" | "no" "action" ) ]
                     | [ "match" name ] }
                     [ [ "not" ] "deferrable" [ "initially" ( "deferred" | "immediate" ) ] ] ;

conflict_clause    = "on" "conflict" conflict_resolution ;

row_op_list        = row_op { "," row_op } ;

row_op             = "insert" | "update" | "delete" ;

/* CREATE INDEX statement */
create_index_stmt  = "create" [ "unique" ] "index" [ "if" "not" "exists" ]
                     index_name "on" table_name "(" indexed_column { "," indexed_column } ")"
                     [ "where" expr ] [ tags_clause ] ;

indexed_column     = column_name [ "collate" collation_name ] [ "asc" | "desc" ] ;

/* CREATE VIEW statement */
create_view_stmt   = "create" "view" [ "if" "not" "exists" ]
                     view_name [ "(" column_name { "," column_name } ")" ] "as" select_stmt
                     [ insert_defaults_clause ] [ tags_clause ] ;

insert_defaults_clause = "insert" "defaults" "(" column_name "=" expr { "," column_name "=" expr } ")" ;

/* CREATE / REFRESH MATERIALIZED VIEW statements.
   The body is any query expression — a select_stmt, values_stmt, or with_clause select_stmt. */
create_materialized_view_stmt = "create" "materialized" "view"
                     [ "if" "not" "exists" ] view_name [ "(" column_name { "," column_name } ")" ]
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] "as" select_stmt
                     [ insert_defaults_clause ] [ tags_clause ] ;

refresh_materialized_view_stmt = "refresh" "materialized" "view" view_name ;

/* CREATE ASSERTION statement */
create_assertion_stmt = "create" "assertion" assertion_name "check" "(" expr ")" ;

/* DROP statement */
drop_stmt          = "drop" ( "table" | "index" | "view" | "assertion"
                            | "materialized" "view" ) [ "if" "exists" ] name ;

/* ALTER TABLE statement */
alter_table_stmt   = "alter" "table" table_name
                     ( rename_table_stmt
                     | rename_column_stmt
                     | add_column_stmt
                     | drop_column_stmt
                     | add_constraint_stmt
                     | alter_pk_stmt
                     | alter_column_stmt
                     | set_table_tags_stmt
                     | alter_constraint_tags_stmt ) ;

rename_table_stmt  = "rename" "to" new_table_name ;

rename_column_stmt = "rename" [ "column" ] old_column_name "to" new_column_name ;

add_column_stmt    = "add" [ "column" ] column_def ;

drop_column_stmt   = "drop" [ "column" ] column_name ;

add_constraint_stmt = "add" table_constraint ;

alter_pk_stmt      = "alter" "primary" "key" "(" [ pk_col { "," pk_col } ] ")" ;

alter_column_stmt  = "alter" "column" column_name
                     ( "set" "not" "null"
                     | "drop" "not" "null"
                     | "set" "data" "type" type_name
                     | "set" "default" expression
                     | "drop" "default"
                     | "set" "tags" tags_body ) ;

set_table_tags_stmt = "set" "tags" tags_body ;

alter_constraint_tags_stmt = "alter" "constraint" constraint_name "set" "tags" tags_body ;

/* ALTER VIEW / MATERIALIZED VIEW / INDEX — tag mutation only (SET replace / ADD merge / DROP delete) */
object_tags_action = ( "set" "tags" tags_body | "add" "tags" tags_body | "drop" "tags" tag_keys_body ) ;

alter_view_stmt    = "alter" "view" view_name object_tags_action ;

alter_mat_view_stmt = "alter" "materialized" "view" mat_view_name object_tags_action ;

alter_index_stmt   = "alter" "index" index_name object_tags_action ;

/* Like tags_clause's body but without the "with tags" prefix; empty "()" clears all tags. */
tags_body          = "(" [ tag_entry { "," tag_entry } ] ")" ;

/* Bare comma-list of tag keys (no "= value") for the DROP TAGS forms; empty "()" is a no-op. */
tag_keys_body      = "(" [ identifier { "," identifier } ] ")" ;

pk_col             = column_name [ "asc" | "desc" ] ;

/* Transaction statements */
begin_stmt         = "begin" [ "deferred" | "immediate" | "exclusive" ] [ "transaction" ] ;

commit_stmt        = "commit" [ "transaction" ] ;

rollback_stmt      = "rollback" [ "transaction" ] [ "to" [ "savepoint" ] savepoint_name ] ;

savepoint_stmt     = "savepoint" savepoint_name ;

release_stmt       = "release" [ "savepoint" ] savepoint_name ;

/* PRAGMA statement */
pragma_stmt        = "pragma" pragma_name [ "=" pragma_value ] ;

/* ANALYZE statement */
analyze_stmt       = "analyze" [ ( [ schema_name "." ] table_name ) | ( schema_name "." "*" ) ] ;

pragma_value       = signed_number | name | string_literal ;

/* Declarative schema statements */
declare_schema_stmt = "declare" [ "logical" ] "schema" schema_name
                      [ "version" string_literal ]
                      [ "using" "(" schema_option { "," schema_option } ")" ]
                      "{" { schema_item } "}" ;

declare_lens_stmt  = "declare" "lens" "for" schema_name "over" schema_name
                     "{" { "view" table_name "as" select_stmt [ ";" ] } "}" ;

schema_option      = identifier "=" string_literal ;

schema_item        = "table" table_name ( "{" | "(" ) column_def { "," ( column_def | table_constraint ) } ( "}" | ")" )
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] ";"
                   | "index" index_name "on" table_name "(" indexed_column { "," indexed_column } ")" ";"
                   | "view" view_name [ "(" column_name { "," column_name } ")" ] "as" select_stmt ";"
                   | "materialized" "view" view_name [ "(" column_name { "," column_name } ")" ]
                       [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] "as" select_stmt ";"
                   | "assertion" assertion_name "check" "(" expr ")" ";"
                   | seed_item ;

seed_item          = "seed" table_name [ "(" column_name { "," column_name } ")" ]
                     [ "values" ] "(" expr { "," expr } ")" { "," "(" expr { "," expr } ")" } ";" ;

diff_schema_stmt   = "diff" "schema" schema_name ;

apply_schema_stmt  = "apply" "schema" schema_name
                     [ "to" "version" string_literal ]
                     [ "with" "seed" ]
                     [ "options" "(" schema_option { "," schema_option } ")" ] ;

explain_schema_stmt = "explain" "schema" schema_name
                      [ "version" string_literal ] ;

/* Basic elements */
expr               = literal_value
                    | identifier
                    | unary_operator expr
                    | expr binary_operator expr
                    | function_call
                    | "(" expr ")"
                    | cast_expr
                    | expr "collate" collation_name
                    | expr [ "not" ] "like" expr [ "escape" expr ]
                    | expr [ "not" ] "glob" expr
                    | expr [ "not" ] "regexp" expr
                    | expr [ "not" ] "in" ( "(" [ select_stmt | expr { "," expr } ] ")" | table_name )
                    | expr "is" [ "not" ] expr
                    | expr [ "not" ] "between" expr "and" expr
                    | [ "exists" ] "(" select_stmt ")"
                    | case_expr
                    | window_function ;

literal_value      = numeric_literal | string_literal | blob_literal | "null" | "true" | "false" ;

numeric_literal    = [ "+" | "-" ] ( integer_literal | float_literal ) ;

integer_literal    = digit+ ;

float_literal      = digit+ "." digit* [ "e" [ "+" | "-" ] digit+ ]
                   | "." digit+ [ "e" [ "+" | "-" ] digit+ ]
                   | digit+ "e" [ "+" | "-" ] digit+ ;

string_literal     = "'" { character } "'" { "'" { character } "'" } ;

blob_literal       = "x'" hex_digit+ "'" ;

identifier         = [ schema_name "." ] name ;

schema_name        = name ;

table_name         = [ schema_name "." ] name ;

column_name        = [ table_name "." ] name ;

collation_name     = name ;

function_name      = name ;

function_call      = function_name "(" [ [ "distinct" ] expr { "," expr } ] ")" ;

cast_expr          = "cast" "(" expr "as" type_name ")" ;

case_expr          = "case" [ expr ] { "when" expr "then" expr } [ "else" expr ] "end" ;

window_function    = function_call "over" window_name_or_specification ;

window_name_or_specification = window_name | "(" window_specification ")" ;

window_specification = [ window_name ] [ "partition" "by" expr { "," expr } ] [ "order" "by" ordering_term { "," ordering_term } ] [ frame_spec ] ;

frame_spec         = ( "range" | "rows" ) ( frame_bound | "between" frame_bound "and" frame_bound ) [ frame_exclude ] ;

frame_bound        = "unbounded" "preceding"
                   | "current" "row"
                   | "unbounded" "following"
                   | expr "preceding"
                   | expr "following" ;

frame_exclude      = "exclude" "no" "others"
                   | "exclude" "current" "row"
                   | "exclude" "group"
                   | "exclude" "ties" ;

/* Basic lexical elements */
name               = identifier_start_char { identifier_char } ;

identifier_start_char = alpha | "_" ;

identifier_char    = alpha | digit | "_" ;

alpha              = "a" | "b" | ... | "z" | "A" | "B" | ... | "Z" ;

digit              = "0" | "1" | ... | "9" ;

hex_digit          = digit | "a" | "b" | "c" | "d" | "e" | "f" | "A" | "B" | "C" | "D" | "E" | "F" ;

unary_operator     = "-" | "+" | "~" | "not" ;

binary_operator    = "||" | "*" | "/" | "%" | "+" | "-" | "<<" | ">>" | "&" | "|"
                   | "<" | "<=" | ">" | ">=" | "=" | "==" | "!=" | "<>"
                   | "and" | "or" | "xor"
                   | "->" | "->>" ;
```

This grammar defines the syntax of SQL statements supported by Quereus. While it captures most of the language features, some specialized constructs and edge cases may not be fully represented. For the definitive reference, always consult the Quereus parser implementation.
