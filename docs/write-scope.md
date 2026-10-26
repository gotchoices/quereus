# Write-scope introspection

> **Stability: Beta** — see [Stability Tiers](stability.md#tiers).

The **write-scope** API describes, as a small JSON-serializable data contract, what a prepared write statement (INSERT, UPDATE, DELETE) does: which rows it targets and how it chose them, where each written value comes from, what else it reads, which constraints could reject it, and whether re-applying it to its own result would change anything.

It answers one question for a host that queues writes and replays them later — a sync client, an offline-first store, a conflict predictor: *if this write is replayed over state another writer has changed, what could make it fail or land differently?*

[Change scope](change-scope.md) describes what a statement *reads* so a watcher can be told when its result might change; for DML without `RETURNING` it deliberately reports no watches. Write scope is the complementary description, computed from the same planner and spoken in the same vocabulary (`QualifiedName`, `TableWatch`, `ScopeValue`, `NonDetSource`), so a host already consuming change scopes reads it without learning new shapes.

```ts
const stmt = db.prepare('update accounts set balance = balance - :amt where id = :id');
const scope = stmt.getWriteScope();
// scope.writes[0].selection      → { kind: 'rows', key: ['id'], values: [[{ kind: 'param', index: 'id', … }]] }
// scope.writes[0].columns        → [{ column: 'balance', provenance: { kind: 'self', columns: ['balance'] } }]
// scope.writes[0].selfIndependent → false   (the new balance depends on the old one)
```

## Data contract

```ts
interface WriteScope {
  readonly writes: ReadonlyArray<TableWrite>;          // one per write site, plan order
  readonly nonDeterministicSources: ReadonlyArray<NonDetSource>;
  readonly unboundParameters: ReadonlyArray<number | string>;
}

interface TableWrite {
  readonly table: QualifiedName;                       // lowercased schema + table
  readonly operation: 'insert' | 'update' | 'delete';
  readonly disposition: WriteDisposition;              // what happens on a constraint conflict
  readonly selection: TargetSelection;                 // how existing target rows were chosen
  readonly columns: ReadonlyArray<WrittenColumn>;      // the values written, with provenance
  readonly reads: ReadonlyArray<TableWatch>;           // everything else the write reads
  readonly constraints: ReadonlyArray<WriteConstraint>;
  readonly selfIndependent: boolean;
}

type WriteDisposition =
  | { kind: 'abort' } | { kind: 'fail' } | { kind: 'rollback' }
  | { kind: 'ignore' } | { kind: 'replace' }
  | { kind: 'upsert'; clauses: ReadonlyArray<UpsertClause> };

interface UpsertClause {
  readonly target: ReadonlyArray<string> | 'primary-key';   // conflict-target columns
  readonly action: 'nothing' | 'update';
  readonly columns: ReadonlyArray<WrittenColumn>;           // DO UPDATE assignments (empty for `nothing`)
  readonly conditional: boolean;                            // the DO UPDATE arm carries a WHERE
}

type TargetSelection =
  | { kind: 'none' }                                                        // INSERT
  | { kind: 'rows'; key: readonly string[]; values: ReadonlyArray<ReadonlyArray<ScopeValue>> }
  | { kind: 'global' };

interface WrittenColumn {
  readonly column: string;                             // lowercased
  readonly provenance: ValueProvenance;                // see Written-value provenance
}

interface WriteConstraint {
  readonly name?: string;
  readonly kind: 'primary-key' | 'unique' | 'not-null' | 'check'
               | 'foreign-key-child' | 'foreign-key-parent' | 'assertion';
  readonly columns: ReadonlyArray<string>;             // target-table columns involved; empty when unknown
  readonly locality: 'row' | 'cross-row';              // can other rows make it pass or fail?
  readonly timing: 'immediate' | 'deferred';           // within the statement, or at commit
  readonly partial?: boolean;                          // unique: has a predicate
  readonly references?: QualifiedName;                 // FKs, assertions: the other table
}
```

`ValueProvenance` and `WrittenColumn` are exported alongside these types; `QualifiedName`, `TableWatch`, `ScopeValue` and `NonDetSource` are the change-scope shapes.

### Field by field

- **`selection`** — for UPDATE and DELETE, how the rows were chosen. `rows` when the WHERE pins a unique key by equality to a literal or a parameter (`where id = 7`, `where id = :p`, `where id = 7 and name = :n`); the `values` are tuples over `key`, with parameter placeholders until bound — exactly `WatchScope.rows`. Any other predicate, no predicate, or a key the analysis could not decode is `global` — including the multi-row forms `where id in (1, 2)` and `where id = 1 or id = 2`, which need the optimizer's rewrite to decode (see [Where the analysis runs](#where-the-analysis-runs)). INSERT is `none`.
- **`columns`** — INSERT lists every table column in schema order (supplied values, defaults and generated columns alike). UPDATE lists the assigned columns in assignment order, including generated-column recomputes. DELETE lists nothing.
- **`reads`** — everything the write reads to decide its effect, other than the target rows' own key: WHERE and SET inputs, the INSERT source query, the subqueries inside constraint checks (a foreign key's parent, a CHECK's subquery table). A watch on the target table itself appears only for *non-key* columns the write reads: `set n = n + 1` reads `n`; `where name = 'a'` reads `name`; `where id = 7` reads nothing beyond the key, so the target does not appear.
- **`constraints`** — see [Constraints](#constraints).
- **`selfIndependent`** — true when no written value (including every DO UPDATE assignment) depends on the target row's previous values or on other rows: every provenance is `literal`, `input`, `fresh` or `volatile`. Re-applying such a write to its own result changes nothing. This is a property of the written *values*, distinct from `PhysicalProperties.idempotent` ("safe to evaluate twice in one transaction"): a `volatile` `set stamp = now()` is self-independent but not idempotent, and a DELETE is trivially self-independent.
- **`disposition`** — the statement's conflict handling: `abort` (the default), `fail`, `rollback`, `ignore`, `replace`, or `upsert` with its clauses. An upsert clause's `target` is the conflict-target column list, or `'primary-key'` when the clause named none; its `columns` carry the DO UPDATE assignments with provenance (`new.<col>` reads resolve to the insert row's provenance, bare column reads are `self`).
- **`nonDeterministicSources` / `unboundParameters`** — as in change scope, unioned across the write sites.

### Worked examples

```sql
insert into orders (id, customer, total) values (:id, :cust, 0)
```

| Field | Value |
| --- | --- |
| `selection` | `{ kind: 'none' }` |
| `columns` | `id` → `input [id]`, `customer` → `input [cust]`, `total` → `literal 0` |
| `reads` | `[]` |
| `constraints` | `primary-key (id)` cross-row, `not-null` per NOT NULL column, `foreign-key-child (customer) → main.customers` cross-row deferred if declared |
| `selfIndependent` | `true` |

```sql
update orders set total = total + :delta where id = :id
```

| Field | Value |
| --- | --- |
| `selection` | `{ kind: 'rows', key: ['id'], values: [[param id]] }` |
| `columns` | `total` → `self [total]` |
| `reads` | `main.orders` columns `{total}` on the selected rows |
| `constraints` | `not-null (total)` if declared; the key is not assigned, so no `primary-key` entry |
| `selfIndependent` | `false` |

```sql
delete from customers where id = 7
```

| Field | Value |
| --- | --- |
| `selection` | `{ kind: 'rows', key: ['id'], values: [[7]] }` |
| `columns` | `[]` |
| `reads` | `[]` |
| `constraints` | `foreign-key-parent (id) → main.orders` cross-row, plus any assertion over `customers` |
| `selfIndependent` | `true` |

## Conservative by construction

The analysis never claims more precision than it has. Each field has a safe fallback and takes it whenever it cannot decode the shape in front of it:

- an undecodable selection is `global` (never `rows` with an empty value list);
- an undescribable value is `other`;
- a constraint whose reach is unknown is `cross-row`.

A host can therefore treat `rows`, a precise provenance kind, or `row` locality as positive knowledge, and the fallbacks as "assume the worst". The analysis never throws on an unexpected plan shape; it logs and falls back.

## Written-value provenance

Every value a write produces carries a label saying where it comes from. The question each label answers for a host predicting conflicts between queued writes: *could a second writer, acting on newer state, make this value collide or go stale?*

| Kind | Meaning | Example |
| --- | --- | --- |
| `literal` | A constant. Carries `value` when the expression is a single literal — as stored, after conversion to the column's declared type (`'1'` into an integer column is `1`). | `values (1)` |
| `input` | A deterministic function of bound parameters and mutation-context variables. Lists the `parameters` and `contexts` read. | `set x = :p` |
| `fresh` | Unique per call with at least 128 bits of entropy. Names the fresh `function`. | `default (randomblob(16))` |
| `volatile` | Depends on a clock, a non-fresh random source, or a volatile UDF. Lists the `sources` (the change-scope `NonDetSource` shape). | `random()` |
| `self` | Depends on the target row's own previous values. Lists the `columns` read. | `set n = n + 1` |
| `other` | Depends on other rows, or on anything the classifier cannot describe. | `set x = (select max(x) from t)` |

How a compound expression is classified:

- **Rank join.** An operator or deterministic function takes the highest kind among its operands, in the order `literal < input < fresh < volatile < self < other`, unioning that kind's detail lists. A computed constant keeps no `value`. Multi-row `values` join each column across rows the same way (two equal literals keep their `value`).
- **Fresh survives only injective wrappers.** A function of a unique value is unique only when the function is injective, so a `fresh` operand stays `fresh` only under `hex`, `lower`, `upper`, `cast`, or `||` against a literal, and only when it is the wrapper's sole non-literal operand: `hex(randomblob(16))` is `fresh`; `substr(randomblob(16), 1, 4)`, `randomblob(16) || :p` and `abs(stamp_id())` are `other`. Only `hex` is injective over a blob: the others first render a blob as text, a non-fatal UTF-8 decode that collapses invalid bytes to U+FFFD, so `randomblob(16) || 'x'` and `cast(randomblob(16) as text)` are `other` (a fresh function declared without a return type is trusted). Multi-row `values` keep a column `fresh` only when every row calls the same fresh function.
- **Fresh sources.** A function registered with `fresh: true` (see [Plugins § Fresh scalar functions](plugins.md#fresh-scalar-functions)). No builtin is flagged; instead one named rule: `randomblob(n)` with a literal integer `n ≥ 16` is `fresh`, any other `randomblob` call is `volatile` with source `random`. `random()` (64 bits) is never fresh.
- **Context variables are inputs.** A read of a `with context` variable is `input` with that variable in `contexts`, whatever the statement's definition of it — the variable is evaluated once per statement, so a host that needs to know whether the definition was itself volatile classifies the definition from the statement text.
- **The write conversion keeps the label.** Converting a written value (an inserted cell or an assigned one) to its column's declared type does not change its kind, except that a `fresh` value becomes `other` when the conversion is lossy (anything but identity, a conversion from or to an untyped value, or text to blob) — a fresh blob written to a `text` column, for one. A literal reports the converted `value`, or none when the conversion rejects it. `collate` never changes the label.
- **Conservative fallback.** A column of an INSERT … SELECT source, a join side, a CTE, a subquery, or an attribute the classifier cannot resolve is `other`; it never throws. The walk follows only the projection chain the insert builder stacks over `values` or the SELECT's top projection, so a SELECT ending in `order by` / `limit` classifies all its columns `other`.

The classifier is `planner/analysis/value-provenance.ts`; it has no public entry point of its own — `TableWrite.columns` and `UpsertClause.columns` are its surface.

## Constraints

Each entry is a constraint that could reject the write (or, for a cascading foreign key, change what it does), classed by **locality** — can other rows make it pass or fail? — and **timing** — is it checked within the statement, or at commit?

| Kind | Source | Locality | Timing | Listed for |
| --- | --- | --- | --- | --- |
| `primary-key` | catalog | cross-row | immediate | INSERT; UPDATE when a key column is assigned |
| `unique` | catalog (`partial` when it has a predicate) | cross-row | immediate | INSERT; UPDATE when one of its columns is assigned |
| `not-null` | catalog, one per NOT NULL column | row | immediate | INSERT; UPDATE for assigned columns only |
| `check` | the checks the planner built for this operation | `row`, or `cross-row` when the expression contains a subquery or a committed-state reference | immediate, or deferred when cross-row or declared `initially deferred` | every operation the CHECK is scoped to (`on delete` CHECKs appear on DELETE) |
| `foreign-key-child` | catalog: the table's own FKs; `references` the parent | cross-row | deferred (the engine probes parent existence at commit) | INSERT; UPDATE when an FK column is assigned |
| `foreign-key-parent` | catalog: every FK declared on another table that references this one, whatever its action; `references` the child | cross-row | immediate when the FK's action for this operation (`on delete` for DELETE, `on update` for UPDATE) is RESTRICT, deferred otherwise | DELETE; UPDATE when a referenced column is assigned |
| `assertion` | catalog: every `create assertion` in any schema whose body depends on the target table; `references` its first other dependent table | cross-row | deferred | every operation |

Foreign keys are read from the catalog rather than from the planned checks: the engine does not plan a per-row parent-side probe when it can batch RESTRICT enforcement at statement end (the common plain DELETE), so the planned checks alone would omit the constraint. Foreign keys appear only while the `foreign_keys` option is on; with enforcement off nothing checks them, so nothing could reject the write. An inbound FK with a cascading action is listed because other rows change what the write does, not because it can reject it.

## Where the analysis runs

Every write site in a plan is one DML executor node, built by the INSERT, UPDATE and DELETE builders. The analysis needs the **logical** shape under it — the constraint-check node, the DML node, the Filter over the target table reference — which physical optimization replaces with access-path operators. So each builder captures that shape at build time in a memo on the executor (`planner/analysis/write-site-analysis.ts`); the memo is carried through every optimizer rebuild of the node, so one analysis serves every optimized copy, and an executor can hand the same object to a virtual-table module on every execution path at the cost of one memo read.

The tradeoff: the analysis runs on the subtree **as built**, with no optimizer pass. `where id = :p` and `where id = 7` are a Filter over the target reference, which the binding extractor already decodes; a shape that needs constant folding or a structural rewrite (`where id = 1 + 1`, `where id = (select 1)`) classifies `global` — the conservative answer the contract allows.

`Statement.getWriteScope(params?)` builds a fresh analysis plan on each call, exactly as `getChangeScope()` does, collects every write site in plan order, and unions their non-deterministic sources and unbound parameters. A statement with no write site returns empty `writes`, never `undefined`. A statement is invalidated on schema change like any other, and the memo lives on a plan that dies with it.

### Several write sites

- **A write through a view, or to a maintained table** — the view-mutation substrate rewrites it into base-table statements that go through the same three builders, so every base write site carries a memo and appears in `writes` as a write to its base table.
- **A data-modifying CTE, or DML in FROM position** (`select * from (insert into t … returning *)`) — each nested executor is its own `TableWrite`. The outer statement's *change* scope already reports the nested write's target as a watch ([change-scope.md § DML write-target propagation](change-scope.md#dml-write-target-propagation-from-position-dml)); that is unchanged.

## Parameters and serialization

`bindWriteParameters(scope, params)` substitutes bound values into every `selection` and every `reads` watch, and drops the bound indices from `unboundParameters` and from `nonDeterministicSources`. It accepts the same key spellings as every other binding surface (`:name`, `$name`, `name`; `1`, `'1'`, `':1'`) and, like them, rejects an object that binds two spellings of one parameter with a `MisuseError` — it is change-scope's `bindParameters`, applied per watch. `getWriteScope(params)` applies it for you; so does a statement with parameters already bound.

`serializeWriteScope` / `deserializeWriteScope` round-trip the scope through JSON; the only non-plain field is `TableWatch.columns` (a `Set`, sent as a sorted array). As with change scope, a literal `bigint` or blob inside a selection value or a `literal` provenance is not JSON-representable; `structuredClone` carries them.

```ts
const wire = JSON.stringify(serializeWriteScope(scope));
const back = deserializeWriteScope(JSON.parse(wire));   // deep-equals scope
```

## Module hook

A virtual-table module can receive its write's description with every row it is asked to write, so a module that queues writes can decide at staging time whether another writer could make the queued write fail. The table opts in with `wantWriteScope = true`; each `update()` call for the statement's own write then carries `UpdateArgs.writeScope`, the write site's `TableWrite`:

- **Bound.** The execution's parameters are substituted into `selection` and `reads` (`bindTableWrite`, the per-write half of `bindWriteParameters`), so the module sees literal key values — on a prepared statement and on `db.exec` alike.
- **Shared.** One object per execution, the same reference for every row; read-only. The upsert DO UPDATE arm receives the INSERT's object, whose `disposition.clauses` describe the arm.
- **Cheap when unused.** Unset, the engine runs no analysis. Set, the write site's memo (see [Where the analysis runs](#where-the-analysis-runs)) is analyzed on first use and reused by every later execution of the prepared plan; binding runs once per execution. The memo freezes the `foreign_keys` option at first use, as the plan freezes its own FK checks at build — recompile to pick up a toggle.
- **The statement's own writes only.** FK cascade child writes — the engine's nested `delete` / `update` against a child table, physical or through a lens — carry no `writeScope`. A write through a view or to a maintained table is described as the base-table write it becomes.
- **Behind `@quereus/isolation`** the opt-in is mirrored from the underlying table, but the description reaches only the overlay's staging write, not the underlying module at commit.

An example decision — an INSERT keyed by a `fresh` value cannot collide on replay; one keyed by an `input` value may:

```typescript
class OfflineQueueTable extends VirtualTable {
  wantWriteScope = true;

  async update(args: UpdateArgs): Promise<UpdateResult> {
    this.queue.push({ args, mayFail: mayFailOnReplay(args.writeScope) });
    return this.storage.update(args);
  }
}

/** Could another writer make this queued write fail when it is replayed? */
function mayFailOnReplay(write: TableWrite | undefined): boolean {
  if (!write) return true;                          // undescribed: assume the worst
  if (write.operation !== 'insert') return true;    // targets rows another writer can change
  return write.constraints.some(c => c.locality === 'cross-row' && !keyedByFresh(write, c));
}

/** A key that includes a fresh (unique-per-call) value cannot collide with anyone's row. */
function keyedByFresh(write: TableWrite, c: WriteConstraint): boolean {
  return (c.kind === 'primary-key' || c.kind === 'unique')
    && c.columns.some(col => write.columns.find(w => w.column === col)?.provenance.kind === 'fresh');
}
```

So an INSERT whose key is `fresh` (`default (randomblob(16))`) into a table with no natural unique key and no foreign key cannot fail on replay, while an INSERT whose unique column is `input` — a value the host supplied as a parameter — may collide with another writer's row. The contract lists every key constraint as `cross-row` and leaves the provenance reasoning to the module.

Module authors: see also [module-authoring.md § Write scope](module-authoring.md#write-scope).

## Known imprecisions

Sound and conservative: never less than what the write may do, sometimes more.

- **A parent read through a foreign key is whole-table.** The child-side existence probe is a correlated subquery, so the parent's watch is `full` even when the FK column's value is a literal or a parameter. It could narrow to `rows` keyed by that provenance; see the `NOTE:` in `write-site-analysis.ts`.
- **Only equality on a unique key narrows the selection.** Ranges, non-key predicates and subquery-driven keys are `global`, as in change scope.
- **Shapes that need optimization to decode are `global`** — `where id in (1, 2)`, `where id = 1 or id = 2`, `where id = 1 + 1`; see [Where the analysis runs](#where-the-analysis-runs).
- **Assertion membership follows the catalog's recorded dependents.** An assertion's dependent-table list is recorded when it is created and is not re-derived afterwards, so an assertion whose body reads a view that was later redefined over other tables can be missed or over-listed. See the note on `dependentTables` in `schema/assertion.ts`.
- **Referential actions are described by their constraint, not their effect.** A cascading inbound FK appears as a `foreign-key-parent` entry; the child rows it would delete or null out are not listed under `reads` or as writes.
- **Conflict handling is per statement.** A constraint-level `on conflict` default (`unique on conflict replace`) is not reflected in `disposition`.
- **The target watch is trimmed by name.** A read of the target table from a subquery (`set x = (select max(x) from t)`) is a separate watch and is kept whole; only the source scan's watch loses the key columns.

## See also

- [change-scope.md](change-scope.md) — the read-side contract this one shares its vocabulary with.
- [plugins.md § Fresh scalar functions](plugins.md#fresh-scalar-functions) — declaring a unique-per-call function so its values classify `fresh`.
- [usage.md § Write-scope introspection](usage.md#write-scope-introspection) — the `Statement` entry point.
