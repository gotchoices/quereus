description: On the in-memory backend, filtering on the first column of a multi-column index or primary key reads the whole table instead of using the index, which makes common per-parent lookups cost as much as a full scan. The persistent store backend already handles this.
files:
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/planner/rules/access/
repro: verified
----

Reported in GitHub issue #33. Reproduced on the v4.25.0 build:

```sql
create table t (k text, r integer, x integer, primary key (k, r));
select x from t where k = 'a' and r = 1;   -- IndexSeek USING primary
select x from t where k = 'a';             -- Filter over a full primary-key scan

create table u (id integer primary key, k text, r integer, x integer);
create index u_kr on u (k, r);
select x from u where k = 'a';             -- Filter over a full primary-key scan, u_kr unused
```

GitHub issue #36 reports that the store backend seeks on these shapes, so this looks like memory-side parity with the store's prefix seek work, not a new design.

Expected: equality on a leading prefix of a compound index or primary key seeks that index. Results stay correct, including any ordering claim made for the walked range. Also check the combination from the issue, where `where k = 'a' order by r desc limit 1` over `(k, r desc)` absorbs the ordering but walks the entire index.
