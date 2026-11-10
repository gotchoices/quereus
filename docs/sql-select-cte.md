# SQL Queries — WITH Clause (Common Table Expressions)

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

The `WITH` clause: CTE syntax and visibility, data-modifying CTEs, recursive CTEs and their
evaluation, materialization, and common patterns. A satellite of
[SQL Queries — SELECT, Clauses & Expressions](sql-select.md).

## 3.7 WITH Clause (Common Table Expressions)

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
- `materialized` / `not materialized`: Hints for optimization - by default, results are cached if accessed more than once. A CTE that reads a column of an outer query is an exception; see [Optimization and Performance](#373-optimization-and-performance)

**Visibility between CTEs:**

- Every CTE in a `WITH` clause can name the CTEs defined **before** it, whatever its own
  body is — `SELECT`, `VALUES`, or a data-modifying `INSERT` / `UPDATE` / `DELETE … RETURNING`.
  Only a `RECURSIVE` CTE may name itself; no CTE may name a later sibling.
- A CTE body may carry its own `WITH` clause. Its members can name the enclosing clause's
  earlier CTEs, and a name defined there **shadows** a same-named enclosing one for that
  body only.
- Reading a data-modifying CTE yields that CTE's `RETURNING` rows, and its write happens
  **once** per statement execution no matter how many times it is named — the reference is
  what drives the write, and the rows are then replayed from one buffer. See
  `docs/runtime-caching.md` § Shared CTE materialization.
- A CTE that instead reads the **base table** another CTE writes is a different case: it
  is not defined whether it observes that write. Do not rely on either answer; see the
  gap list in `docs/runtime-caching.md`.

**Where a data-modifying CTE may appear:**

A member whose body is an `INSERT` / `UPDATE` / `DELETE … RETURNING` is legal **only in a
statement's own leading `WITH` clause**. Anywhere else it is rejected at build time with
`WITH member '<name>' is data-modifying (INSERT), which is only allowed in a statement's
own leading WITH clause …`. Rejected positions include a `FROM` sub-query, a scalar / `EXISTS` / `IN`
sub-query, a `WITH` clause nested inside another CTE's body, a compound (`UNION`) arm's own
clause, and the body of a stored `CREATE VIEW`, `CREATE MATERIALIZED VIEW`,
`CREATE TABLE … MAINTAINED` or `CREATE ASSERTION` — whether or not anything references the
member. This matches PostgreSQL.

The reason is that only the leading clause has an owner for the write's
once-per-statement-execution guarantee. In the other positions the write is driven by
whatever happens to reference the member: nothing does, and the write silently disappears;
a stored view body re-evaluates, and the write re-runs on every read; a correlated
sub-query evaluates per outer row, and "once per statement" stops meaning anything. Move
the mutation to the statement that uses the query.

**Read-only** nested `WITH` clauses are unaffected — the rule applies to data-modifying
members only.

**Visibility inside the declaring statement:**

- A statement's own leading `WITH` clause is visible to **every clause of that statement**,
  not only to the relation it selects from. For `INSERT` that means the source `SELECT`,
  a scalar subquery inside a `VALUES` row, the `RETURNING` projections, the
  `ON CONFLICT … DO UPDATE` assignments and `WHERE`, and the `WITH CONTEXT` assignments;
  for `UPDATE` / `DELETE`, the `SET` / `WHERE` / `RETURNING` clauses. A view or
  materialized-view target is included — the write-through rewrite carries the same CTEs.
  (A *subquery* in `ON CONFLICT` or `WITH CONTEXT` currently resolves but does not yet
  execute — an unrelated planner gap, tracked separately.)
- A **schema-qualified** `FROM` name never binds a CTE. A CTE lives in no schema, so
  `main.c` can only mean the schema object `c`: `WITH c AS (…) SELECT … FROM c` reads the
  CTE while `… FROM main.c` reads the real table / view, and a qualified name with no
  matching schema object raises the ordinary table-not-found error rather than silently
  binding the CTE. The same rule applies to a qualified DML target (`UPDATE main.c`). This
  matches SQLite and PostgreSQL.
- **Schema-authored** expressions are deliberately excluded: a column `DEFAULT`, a
  generated-column expression, a `CHECK` constraint and a foreign-key existence check
  belong to the table's DDL rather than to the statement, so
  `DEFAULT (SELECT count(*) FROM c)` always binds the real `c` even when the inserting
  statement declares a CTE of that name — and binds it in the *table's own* schema, not
  the writer's (see [§2.1.1](sql-select.md#211-schema-search-path-with-schema)).

```sql
-- A writing CTE reading an earlier reading CTE
with a as (select id from staging),
     b as (insert into target select id, 1 from a returning id)
select count(*) as loaded from b;

-- A writing CTE reading an earlier WRITING CTE: `a` inserts once, `b` reads its RETURNING rows
with a as (insert into q values (300, 1) returning id),
     b as (insert into q select id + 1, 2 from a returning id)
select count(*) as n from b;
```

### 3.7.1 Basic (Non-Recursive) CTEs

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

### 3.7.2 Recursive CTEs

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

### 3.7.3 Optimization and Performance

**Materialization Hints:**
`materialized` stores the CTE's rows once per statement execution and every reference reads them. `not materialized` runs the body once per reference. Without a hint, a CTE referenced two or more times is stored and one referenced once is not. A recursive CTE referenced two or more times, and a CTE whose body is an `insert`, `update` or `delete`, are always stored regardless of hint:
```sql
with recursive 
  large_cte as materialized (select ...),
  small_cte as not materialized (select ...)
select ...
```

A stored result lasts for the whole statement, so a CTE inside a subquery that reads a column of an outer query cannot be stored:

| CTE that reads an outer column, and would be stored | Behavior |
|---|---|
| Deterministic and read-only | Runs once per reference, even when hinted `materialized`; results are the same as sharing |
| Non-deterministic | Error at planning; write `not materialized` to run it once per reference |
| Writes data through a scalar subquery | Error at planning |
| Recursive, referenced two or more times | Error at planning |

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

The values obey the same rules as any other `limit` / `offset` ([§3.6](sql-select.md#36-limit-and-offset-clauses)): NULL or negative is an error, checked before the base case runs.

**Performance Characteristics:**
- **Non-recursive CTEs**: Executed once, results may be cached
- **Recursive CTEs**: Semi-naïve evaluation with O(N) complexity
- **Memory usage**: Working table and result set kept in memory
- **Deduplication**: For `union`, uses B-Tree with proper SQL value comparison

### 3.7.4 Common Patterns and Best Practices

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
