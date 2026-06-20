----
description: When someone binds a single SQL parameter to a whole array (instead of one value) and compares it to a normal column, the query quietly matches no rows instead of telling them they made a mistake.
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts (equalitySeekKey doc comment references this ticket — the NOTE (array-valued scalar param) marker)
difficulty: medium
----

# Reject (or clearly diagnose) an array-valued scalar parameter

## Repo routing

Filed from the SiteCAD tess board (`C:\projects\SiteCAD_branch`) during a 2026-06-20 backlog triage,
moved here because the fix lives in **this** (Quereus) repo. SiteCAD consumes Quereus via `portal:` +
symlink, so no SiteCAD edit is required for the fix itself — after committing here, a SiteCAD rebuild
(`yarn workspace @quereus/quereus build`) picks it up. The engine already left a
`NOTE (array-valued scalar param)` marker in `equalitySeekKey` pointing at this ticket.

## Background

Quereus has no concept of "expand an array parameter into an IN list" — that is not
standard SQL or SQLite behavior. Binding `where col in (?)` (or `where col = ?`) with
an **array** value, e.g. params `[[1, 2]]`, therefore does not mean "match rows where
col is 1 or 2".

Before the `quereus-single-element-in-list-matches-all` fix, an array-bound single
`in (?)` silently **match-alled** (it seeked on `Literal(undefined)`). After that fix
the seek key is the parameter expression, so the array now compares unequal to every
scalar column value and the predicate matches **nothing**. Less destructive, but still
a silent footgun: the user gets an empty result with no indication that they passed the
wrong shape.

## Desired behavior

Binding an array (or other non-scalar) value to a parameter that is used in a **scalar**
position (equality / IN-element / range bound against a scalar column) should raise a
clear bind-time or plan-time error — something like
`parameter :1 bound to an array value but used as a scalar` — rather than silently
matching nothing.

Genuine array/JSON parameter uses (e.g. a parameter passed to a function that accepts an
array, or stored into a JSON column) must continue to work — the guard must fire only
when a non-scalar value reaches a scalar comparison site.

## Notes / scope

- This is explicitly **out of scope** for the match-all fix; it was split out because a
  correct guard is more than a trivial one-liner (it has to distinguish scalar-comparison
  parameter sites from legitimate array/JSON parameter sites, and hook the right layer —
  parameter binding/coercion vs. the access-path seek-key build).
- The engine fix already left a `NOTE (array-valued scalar param)` comment in
  `equalitySeekKey` (rule-select-access-path.ts) pointing at this ticket.

## Use cases to cover

- `select ... where id = ?` with params `[[1,2]]` → clear error (not empty result).
- `select ... where id in (?)` with params `[[1,2]]` → clear error.
- `select ... where id in (?, ?)` with params `[1, 2]` (two scalar params) → unchanged,
  still matches rows 1 and 2.
- A parameter legitimately bound to an array and consumed by an array/JSON-accepting
  function or column → unchanged, no error.
