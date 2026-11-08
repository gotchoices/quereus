---
description: An index sorted smallest-to-largest can be read largest-to-smallest simply by walking it backwards, but neither storage backend will do that — so a query that asks for descending order sorts the whole table unless someone created a second index specifically declared descending.
files:
  - packages/quereus/src/vtab/memory/module.ts                      # indexSatisfiesOrdering (~line 1060) — requires required.desc === indexCol.desc
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts             # the memory backend already has a descending scan plan
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts            # the walk itself
  - packages/quereus/src/vtab/best-access-plan.ts                   # nullSafeOrderingPrefixLength — NULL placement gate, judged on effective direction
  - packages/quereus-store/src/common/store-module-access-plan.ts   # buildIndexOrderingAdvertisement / chooseOrderingPlan — same direction equality (~line 1554)
  - packages/quereus-store/src/common/store-table-scan.ts           # would need a backwards key-range walk
  - docs/module-authoring.md                                        # the providesOrdering contract modules implement
prereq: debt-memory-reverse-secondary-pk-order
severity: cosmetic
likelihood: normal-use
tradeoffs: A user can get the same speed today by declaring a second index in the direction they need, so this buys convenience and index-count rather than a capability that is otherwise unreachable; and the change has to be made twice, once per backend, with the store half needing a backwards key-range walk it does not have.
---

# Serve descending order from an ascending index by walking it backwards

## What happens today

Both shipped backends decide whether an index can supply a requested ordering by
comparing directions for equality — the requested direction must be the direction the
index column was declared with. Neither will read an index in reverse.

Measured on the memory backend at HEAD, table with `create index t_c on t(c)`:

```
select c from t order by c desc limit 1
  LIMITOFFSET
    SORT ORDER BY c DESC          <- the whole table is sorted
      PROJECT
        INDEXSCAN t USING _primary_
```

Add `create index t_c_desc on t(c desc)` and the same query plans as a one-row index
walk. So the capability is entirely there — it is the *direction* of the stored index
that the planner insists on, not anything about the walk.

## Why it matters

Every `order by x desc limit n` shape pays for this, and so does `max(x)` once
`feat-minmax-index-boundary` lands: that rule turns `max(c)` into "walk `c` descending,
take one row", which today only fires when a descending index happens to exist. The
user report behind that work — `MAX(date)` on a 20,000-row table at 450–900 ms under
the browser storage backend — is exactly this shape. They can fix it by adding a
descending index; they should not have to.

## What "done" looks like

A module may satisfy a requested ordering by walking a matching index backwards, and
says so through the ordering claim it already returns. Concretely that means, per
backend:

- recognizing that a required ordering is the exact element-wise reverse of an index's
  own ordering (all columns flipped — a partial flip is not a reverse walk);
- returning a plan whose scan runs backwards;
- getting NULL placement right. This engine's `ORDER BY` places NULLs **first in both
  directions**. A backwards walk of an ascending index emits NULLs **last**, which is
  the mirror image of the bug `bug-desc-index-ordering-claims-misplace-nulls` already
  fixed for declared-descending indexes. The existing gate,
  `nullSafeOrderingPrefixLength`, is the right place to enforce it — but it has to be
  asked about the *effective* walk direction, not the declared column direction.

## Known hazard before turning this on

`debt-memory-reverse-secondary-pk-order` (backlog) records that the in-memory table's
backwards secondary-index read emits rows *within* one indexed value in forward
primary-key order, while the transaction-isolation layer's merge expects the whole
composite ordering reversed. Nothing requests a backwards read today, so it is dormant
— this ticket is what would wake it. It should land first, or as the first arm of this
work. (Planning found the effect narrower than stated: the isolation secondary-index merge drops shadowed rows by a primary-key set, so the mismatch only misplaces staged rows within one indexed value, and the memory ordering claim never covers the primary-key tail. It is being fixed as contract conformance; see the implement ticket.)

A second hazard, found by reading `scan-layer.ts` and not run because nothing requests a reverse walk today: the memory scan positions a prefix seek at the key `[prefix]`, which sorts just before every full key in that prefix group. That start is right for a forward walk only. Walking backwards from it lands in the previous group, the prefix check fails, and the scan ends with no rows. A reverse prefix walk has to start from the end of the group. This becomes reachable for `where k = ? order by r desc` over `(k, r)` once bug-memory-compound-index-unusable-on-leading-column makes equality on a leading column a prefix seek.

## Scope note

This is a two-backend change plus an engine-side contract clarification, and the store
half needs a backwards key-range walk it does not currently have. It is very likely
more than one implement ticket; whoever promotes it should expect to split by backend.

## Downstream need (2026-11-06)

Optimystic issue gotchoices/optimystic#52 measured it. Sereus Chat's message list reads `select … from App.Message order by Timestamp desc, Id desc limit 100`. On an Optimystic strand that read takes 21 / ~100 / ~450 ms at 100 / 1,000 / 5,000 messages, about the same as `count(*)`. That is with or without an index on `(Timestamp, Id)`, and roughly 2 s per read on a Galaxy S7. Most of that cost is on the Optimystic side, which uses a secondary index only for equality. Even so, the issue lists a DESC reverse walk in Quereus as its third ask.

Re-measured on Quereus 5.0.0, memory table, 2,000 rows, `index MT on M (T)`, `index CT on C (Ts, Id)`:

| query | plan | ms |
|---|---|---|
| `order by T asc limit 10` | LIMITOFFSET INDEXSCAN | 3.1 |
| `order by T desc limit 10` | LIMITOFFSET SORT INDEXSCAN | 23.8 |
| `order by Ts desc, Id desc limit 10` | LIMITOFFSET SORT INDEXSCAN | 21.1 |
| `order by Id desc limit 10` (primary key) | LIMITOFFSET SORT INDEXSCAN | 18.1 |

The primary key is not walked backwards either. The "newest N" shape is common in applications, and declaring a descending index is the only workaround. That suggests the severity should be higher than cosmetic.
