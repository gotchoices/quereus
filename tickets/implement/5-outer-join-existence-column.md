description: Write-enabled second half of the outer-join existence column — writing the `existence`-sited boolean drives insert/delete of the non-preserved side (Dataphor `include rowexists`). `set hasB = true` while absent ⇒ insert B; `= false` ⇒ delete the matching B row; both compose with a column write on B and with insert-through-view. Built on the per-row conditional materialization substrate from `view-write-optional-member-transitions`. Read half (projection + `existence` site + grammar) is `outer-join-existence-read`.
prereq: outer-join-existence-read, view-write-optional-member-transitions
files: packages/quereus/src/planner/mutation/propagate.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/analysis/update-lineage.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/sql.md
----

## Why

The read half (`outer-join-existence-read`) reifies the outer-join match guard as a
first-class `existence`-sited boolean column. This half delivers **the payoff**: the
existence column **is** the guard, and *writing* it drives the side's existence.
This is the explicit, per-row control surface for outer-join write-through — the
documented "null-extended ⇒ rewrite as insert" path, now *explicitly triggered* by a
boolean write rather than inferred from which columns a mutation touches
(`docs/view-updateability.md` § Outer Joins, § The Update Site Model).

## The write is exactly a per-row conditional materialization

For a left join `A ⟕ B on <pred>` with existence column `hasB`, an existence write
is a **per-row insert-or-delete branch** keyed on the pre-mutation match:

| write | B currently matches | B currently absent |
|---|---|---|
| `set hasB = true`  | no-op | **insert** into B |
| `set hasB = false` | **delete** the matching B row | no-op |

This is the **same per-row conditional substrate** `view-write-optional-member-transitions`
builds for the non-preserved-side UPDATE (matched→update / null-extended→insert) and
the decomposition optional-member update. That ticket adds a `ViewMutationNode` shape
that partitions the up-front capture into *matched* / *null-extended* subsets and
drains a matched-op and a null-extended-op against the pre-mutation partition. The
existence write is the **insert-or-delete** specialization of that exact machine:

- `set hasB = true`: matched subset → **no op**; null-extended subset → **insert B**
  (join key via the join-predicate equivalence class, other B columns from base
  defaults / `default_for`).
- `set hasB = false`: matched subset → **delete B**; null-extended subset → **no op**.

So the runtime substrate is **reused, not extended** — this ticket wires the
`existence`-site write path into the partition-and-branch core. If the all-null→delete
branch from the transitions ticket is generalized to "delete on demand," the
`hasB = false` delete is that branch driven by a flag instead of all-columns-null.

## Routing the `existence`-site write (`propagate.ts` / `multi-source.ts`)

- `resolveBaseSite` (`update-lineage.ts`): an `existence` site now resolves to a
  **writable-through-effect** descriptor — not a `base` column write (it has no base
  column) but a routing instruction carrying the component (the non-preserved side's
  `TableReferenceNode`) and the guard. Add a discriminator the propagation pass reads
  (e.g. `existenceComponent?: RelationalComponentRef` on the resolved site, with
  `writable: true` but `baseColumn` undefined).
- The multi-source join walk recognizes an assignment whose target lowers to an
  `existence` site and routes it to the conditional-materialization build instead of
  a base-column SET. The assigned value must be a boolean literal / boolean-typed
  expression; `true` ⇒ insert-branch, `false` ⇒ delete-branch. (A non-constant
  boolean is a per-row branch on the *written* value — support a literal first;
  document a non-literal as a follow-up if it complicates the partition.)
- **Composition with a column write on the same side.** `set y = 5, hasB = true`
  while B absent ⇒ insert B with `y = 5`: the existence-insert branch consumes the
  same-side `set` columns as supplied values (they flow into the null-extended-subset
  INSERT projection). `set y = 5` *alone* on a non-preserved column is the
  transitions ticket's matched→update / null-extended→insert path; with `hasB` also
  set, `hasB` is the *explicit* trigger for the same insert (and `hasB = false` with
  a same-side `set` is a contradiction — reject `conflicting-assignment`-style, since
  you cannot both delete the side and write its column).
- **No-default.** A `hasB = true` insert of a B row whose `not null` B column has no
  supplied value and no default fails with the existing `no-default` /
  `null-extended-create-conflict` diagnostic (not a silent drop) — identical to the
  transitions ticket's null-extended insert.

## Insert through the view

`hasB` participates in INSERT routing (§ parent ticket § Model — Insert):

- `insert into AB (id, x, y, hasB) values (9, 'q', 3, true)` ⇒ insert **both** sides
  under the join predicate (the existing multi-source insert envelope with the B
  side supplied — already wired by `view-write-outer-join-static`).
- `insert into AB (id, x, hasB) values (9, 'q', false)` ⇒ insert **only** the
  preserved side (the row is null-extended through the view) — the preserved-only
  insert from `view-write-outer-join-static`, now *explicitly* selected by
  `hasB = false` instead of inferred from B columns being absent.
- `hasB = true` with no B columns supplied: insert B with defaults (join key via EC);
  `no-default` if a `not null` B column is undefaulted.

The `existence` column is itself never stored — on INSERT it is consumed as a
routing directive, not written to any base column.

## Static surfaces (`func/builtins/schema.ts`)

Flip the existence column's `column_info` row to `is_updatable = 'YES'` (it is now
writable through its insert/delete effect) while keeping `base_table` / `base_column`
= `null` (it maps to no base column — it is writable through an *effect*). The view's
`is_insertable_into` / `is_deletable` already reflect the per-side routing from
`view-write-outer-join-static`; confirm the existence column does not regress them.
Keep the surfaces agreeing with the dynamic `propagate()` truth.

## Tests (acceptance gate: `test/property.spec.ts` § View Round-Trip Laws → the outer-join family)

Extend the `rj_ex` view from `outer-join-existence-read`
(`select c.cc, c.cv, p.pv, exists right as hasP from rjchild c left join rjparent p on p.pp = c.pr`):

- **`hasP` false→true, B defaulted** — `update rj_ex set hasP = true where cc = K`
  over a null-extended row: a `rjparent` row appears (join key via EC, other columns
  defaulted); PutGet shows `hasP` now reads `true`. With an undefaulted `not null`
  parent column → rejects with `no-default` / `null-extended-create-conflict` (not a
  silent drop).
- **`hasP` false→true, no-op when present** — over a matched row: base unchanged.
- **`hasP` true→false** — `update rj_ex set hasP = false where cc = K` over a matched
  row: the `rjparent` row disappears, `rjchild` untouched (PutGet); over an already
  null-extended row: no-op.
- **Composition** — `update rj_ex set pv = 5, hasP = true where cc = K` over a
  null-extended row inserts `rjparent` with `pv = 5`. `set pv = 5, hasP = false` →
  reject (contradiction: delete-the-side + write-its-column).
- **Insert-through** — `insert into rj_ex (cc, cv, pv, hasP) values (...,true)`
  inserts both sides; `insert into rj_ex (cc, cv, hasP) values (...,false)` inserts
  only `rjchild` (reads back null-extended).
- **GetPut** — writing the read-back `hasP` value back is a no-op on the base (true→
  true and false→false both leave the base diff empty).
- **Key Soundness** unchanged from the read half; **negative self-tests** stay red
  on an injected materialized-side divergence.

Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 80 /tmp/t.log`
and `yarn workspace @quereus/quereus lint`.

## Out of scope (keep rejecting)

- Non-literal boolean existence writes (per-row branch on the written value) — defer;
  document if it complicates the partition. Literal `true`/`false` is the v1 surface.
- The projection-position sugar `exists(<alias>) as hasB` — deferred by the read half;
  unchanged here.
- Everything `view-write-optional-member-transitions` keeps rejecting (composite
  shared keys, aggregate/window write, multi-source insert RETURNING) — unchanged.

## TODO

- `update-lineage.ts` `resolveBaseSite`: resolve an `existence` site to a
  writable-through-effect descriptor carrying the component ref + guard
  (`writable: true`, `baseColumn` undefined, `existenceComponent` set).
- `multi-source.ts`: recognize an assignment lowering to an `existence` site; route
  it to the conditional-materialization build from `view-write-optional-member-transitions`
  — `true` ⇒ insert-branch (null-extended subset), `false` ⇒ delete-branch (matched
  subset); fold same-side `set` columns into the insert-branch projection; reject
  `set col, hasB = false` as a contradiction.
- `propagate.ts`: thread the existence-site assignment through the multi-source
  classify/route path; surface the diagnostics.
- INSERT path (`multi-source.ts` / `view-mutation-builder.ts`): consume `hasB` as a
  routing directive — `true` ⇒ both-side envelope insert, `false` ⇒ preserved-only;
  never store the flag column.
- `view-mutation-node.ts` / `view-mutation.ts`: if the transitions substrate needs a
  delete-branch the existence path requires but it landed insert-only, add the
  delete-branch to the shared conditional shape (do **not** fork a second branch
  implementation — extend the shared one).
- `func/builtins/schema.ts`: flip the existence column to `is_updatable='YES'`,
  `base_*` null; verify `view_info`/`column_info` agree with the dynamic truth.
- Tests above; docs (`view-updateability.md` § Outer Joins — document existence-write
  insert/delete + composition + insert-through; remove any "read-only" note for the
  existence column; `docs/sql.md` — note the write semantics of the `exists … as`
  column).
- Confirm the downstream `set-operator-membership-columns` substrate expectations:
  the `existence` `UpdateSite` + write routing here must stay component-generic (no
  hard-coded join side in the routing) so the set-op membership work extends it.
