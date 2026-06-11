----
description: Multi-source view UPDATE — a cross-source SET value (or authored-inverse `new.<x>` forward read) reaching a partner side through an UNQUALIFIED body projection fails with a generic "Column not found" instead of riding the captured-read machinery (or a structured diagnostic).
files:
  - packages/quereus/src/planner/mutation/multi-source.ts   # stripSideQualifier — unqualified refs assumed owning-side
  - packages/quereus/src/planner/mutation/backward-body.ts  # baseTermExpr is the projection expr verbatim (unqualified stays unqualified)
----

# Cross-source reads through unqualified body projections

`stripSideQualifier`'s substitution returns `undefined` for an unqualified
column reference (`if (!col.table) return undefined`), assuming it belongs to
the owning side. A join-view body may legally project a partner-side column
**unqualified** when the name is unambiguous across the sides (e.g.
`create view v as select a.pid, bv || '' as bv2, av from a join b …` — `av`
lives only on side `a`). The projection's `baseTermExpr` is then the
unqualified `av`, so when a cross-source SET value (or an authored inverse's
`new.av` forward read) is lowered onto the partner-owning side, the leftover
unqualified `av` lands in the wrong side's base UPDATE and fails at build with
the generic `Column not found: av`.

Observed while reviewing `authored-inverse-write-path` (the behavior predates
that ticket — the plain cross-source `set x = av` path flows through the same
code). Qualifying the projection in the view body (`a.av as av`) works today
and is the workaround.

Expected behavior, in preference order:

1. Resolve an unqualified body-projection reference to its owning side by
   unique column ownership (the same rule `resolveColumnSide` already applies
   to join-condition operands), then route it through the existing
   captured-read machinery exactly like a qualified partner read.
2. Failing that, reject with a structured mutation diagnostic naming the view
   column and the side ambiguity — not a generic column-not-found from the
   lowered base statement.

No silent mis-bind exists today: a name owned by BOTH sides fails body
planning as ambiguous, and a partner-only name fails loud as above. This is a
functionality/diagnostics gap, not a correctness hole.
