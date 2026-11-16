description: Rows written while foreign key checking is switched off can break a foreign key, yet the query optimizer still assumes every foreign key holds, so some queries silently leave those broken rows out of their results.
architecture: docs/optimizer-fd.md#inclusion-dependency-tracking
files: packages/quereus/src/planner/util/ind-utils.ts (lookupCoveringFK, seedTableForeignKeyInds), packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts, packages/quereus/src/core/database.ts (foreign_keys option), packages/quereus-bundle/src/import.ts (turns foreign_keys off while loading)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Tracking whether each foreign key still holds adds catalog state and a validation step to every path that switches checking back on, for a situation only reachable by turning off `foreign_keys` (or an import that reports a violation), and the docs already state the optimizer assumes the pragma's default.
----
## The problem

The optimizer treats a declared foreign key as a proven fact: every non-null child value has a matching parent row. `lookupCoveringFK` and `seedTableForeignKeyInds` (`planner/util/ind-utils.ts`) turn it into an inclusion dependency, and rules act on it. For example `ruleAntiJoinFkEmpty` folds `not exists (select 1 from parent where parent.pk = child.fk)` to an empty result, and join elimination drops a join it proves redundant. The only exception is a backend that declares `permitsOrphanedForeignKeyRows` (invariant OPT-059).

`pragma foreign_keys` (the `foreign_keys` option, default on) can be switched off. Rows written while it is off are not checked, and nothing re-checks them when it is switched back on (`docs/mv-constraints.md` says so for maintained tables, "matching ordinary tables"). From then on the stored rows contradict what the optimizer assumes.

`@quereus/bundle`'s `importBundle` switches it off while loading on purpose, so that a child row whose parent arrives in a later batch can commit. It verifies the foreign keys afterwards and reports each violation as a `foreign-key` error, but the rows stay committed. So any bundle with an orphaned child row reaches this state, and `docs/bundle.md` § Verification now warns users to fix the data.

## Reproduction (verified)

```ts
const db = new Database();
await db.exec('create table p (id integer primary key); create table c (id integer primary key, pid integer references p(id))');
db.options.setOption('foreign_keys', false);
await db.exec('insert into c values (1, 7)');
db.options.setOption('foreign_keys', true);
// select count(*) from c where not exists (select 1 from p where p.id = c.pid)   → 0  (wrong: row 1 is an orphan)
// select count(*) from c left join p on p.id = c.pid where p.id is null          → 1
```

`pid` is NOT NULL here, which is Quereus's column default; the fold only applies to a non-null foreign key.

## Expected behaviour

A query returns the same rows whether or not the optimizer uses the foreign key. Either the optimizer stops relying on a foreign key whose rows may not satisfy it, or the engine makes sure the rows do satisfy it before the optimizer relies on it again.

## Notes for whoever plans this

- The root site is where trust is granted: `lookupCoveringFK` and `seedTableForeignKeyInds`. Both already decline under the orphan capability, so a second reason to decline fits the same seam.
- One shape seen elsewhere: a per-foreign-key "not verified" state, set when rows are written to the child (or a parent row is removed or re-keyed) while `foreign_keys` is off, and cleared by a successful existing-row scan (`validateForeignKeyOverExistingRows`). The optimizer would trust only verified keys. Whether that state must persist with the catalog (a store reopened later still holds the orphans) is part of the design.
- Gating trust on the option's current value alone is not enough: the orphans outlive the moment the option was off.
- Existing-row validation already has to dodge this fold by scanning against a catalog record with the key stripped (`schema/constraint-builder.ts` docs on `validateForeignKeyOverExistingRows`; `packages/quereus-bundle/src/import-verify.ts` does the same). A trust state would let those callers drop the swap.
