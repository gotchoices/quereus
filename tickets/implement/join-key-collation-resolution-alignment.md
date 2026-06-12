description: Align the pairwise join-key collation resolution sites (USING/NATURAL join, merge join, bloom join, ASOF scan) with the shared provenance-ranked comparison-collation resolver, add plan-time conflict validation for USING pairs, and thread collationSource into materialized-view backing-column collationExplicit.
prereq: comparison-collation-provenance-and-precedence
files:
  - packages/quereus/src/runtime/emit/join.ts                        # USING comparator (~41): left-else-BINARY today
  - packages/quereus/src/runtime/emit/merge-join.ts                  # key collations (~67): left||right today
  - packages/quereus/src/runtime/emit/bloom-join.ts                  # key normalizers (~43): left||right today
  - packages/quereus/src/runtime/emit/asof-scan.ts                   # match column (~54) + partition keys (~69): left??right today
  - packages/quereus/src/planner/analysis/comparison-collation.ts    # shared resolver (landed by prereq)
  - packages/quereus/src/planner/rules/join/equi-pair-extractor.ts   # operandCollation-equality gate — verify vs resolver
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # output type → ColumnSchema.collation (~115); thread collationExplicit
  - packages/quereus/test/logic/11.1-join-using.sqllogic
  - packages/quereus/test/logic/82-bloom-join.sqllogic
  - packages/quereus/test/logic/83-merge-join.sqllogic
  - packages/quereus/test/logic/84-asof-scan.sqllogic
----

# Join-key collation through the shared resolver

The prereq ticket lands `resolveComparisonCollation` (provenance-ranked
lattice: explicit > declared > default > BINARY, plan-time error on
explicit/declared same-rank conflicts) and routes comparison/IN/BETWEEN
through it. Four pairwise comparison sites remain on ad-hoc per-emitter rules
and must move to the same resolver so an equi-key comparison resolves
identically however the join is executed:

- `emit/join.ts` USING comparator: `leftType?.collationName ?? BINARY` —
  left-only; a NOCASE declared on the *right* table's column is ignored today.
- `emit/merge-join.ts` key collations: `left || right` (truthy-left wins, so a
  plain-left's defaulted 'BINARY' shadows a declared NOCASE on the right).
- `emit/bloom-join.ts` key normalizers: same `left || right`.
- `emit/asof-scan.ts` match column and partition keys: `left ?? right`.

Each takes the two paired attributes' `ScalarType`s and calls the shared
resolver. Conflicts cannot legitimately reach emit (see validation below), so
on a `conflict` resolution the emitters throw QuereusError as a loud backstop,
mirroring `effectiveComparisonCollation`.

## Plan-time validation for USING / NATURAL

ON-clause equi-joins are ordinary comparisons — the prereq's
BinaryOpNode.generateType validation already covers them. USING/NATURAL pairs
never materialize as BinaryOpNode, so validate where the USING column pairs
are resolved during join building (locate the site in planner/building — the
JoinNode carries `usingColumns`): for each paired column, run
`resolveComparisonCollation` over the two attribute types and throw the same
ambiguous-collation error on explicit/declared conflict. NATURAL joins reduce
to USING pairs and inherit the check.

## Planner-side lockstep (the real risk in this ticket)

Merge join correctness depends on both inputs being ordered under the *same*
collation the key comparison uses. Today the emitter's `left || right` and
whatever ordering requirement the merge-join planning rule imposes are
implicitly aligned; changing the emitter without finding the planner mirror
re-introduces exactly the drift this ticket family exists to kill. Locate
where merge-join key ordering requirements / physical ordering properties
carry collation (the planning rule that chooses merge join and any
ordering-property comparison it does) and route the same resolver there.
Bloom-filter key normalization (`resolveKeyNormalizer`) must use the resolved
name too, or probe and build sides disagree. Same survey for asof-scan's
ordering prerequisites.

`equi-pair-extractor.ts` gates pair extraction on
`operandCollation(left) === operandCollation(right)` (names only). With the
resolver landed this gate is stricter than necessary (e.g. declared NOCASE vs
defaulted BINARY resolves cleanly to NOCASE but the gate sees differing
names). Loosening it is an *optimization*, not required for correctness —
loosen only if the merge/bloom key collation provably follows the resolver
end-to-end (planner ordering + emitter); otherwise leave the conservative
gate and note it.

## Materialized-view backing columns

`materialized-view-helpers.ts` (~115) maps output column types to
`ColumnSchema.collation` but never sets `collationExplicit`, so the store
module's PK-collation reconcile treats every MV backing text PK as
implicit-default and may re-key it under the store default (NOCASE),
diverging from the published output collation. With provenance available,
set `collationExplicit: true` when the output type's `collationSource` is
'explicit' or 'declared', leave unset for 'default'/absent. This keeps a
deliberately-collated MV column stable across the store reconcile while
preserving the historical NOCASE-keying for genuinely-implicit columns.

## Edge cases & interactions

- USING pair: left declared NOCASE + right plain/defaulted → NOCASE (today:
  left-only already gives NOCASE; the *mirror* case right-declared/left-plain
  flips from BINARY to NOCASE — pin both spellings of the join).
- USING pair with conflicting declared collations → plan-time error; same
  query as ON `l.c = r.c` must error identically (uniformity check).
- Merge join over keys where the resolved collation is NOCASE: result must
  match the same query forced through nested-loop/hash (sqllogic comparing
  plans is impractical — instead assert results on data with case-variant
  keys in 83-merge-join.sqllogic, plus the bloom (82) and asof (84) suites).
- ASOF scan: case-variant partition keys under a declared-NOCASE partition
  column group together regardless of which side declares.
- Outer joins (left/right/full) with USING: null-extended rows unaffected by
  collation, but the match decision uses the resolved collation — cover one
  outer-join case.
- MV whose SELECT publishes an explicit `collate nocase` output column,
  persisted via the store module: backing PK keys NOCASE and stays NOCASE on
  reopen (round-trips DDL); an MV over a plain column under store default
  keeps the historical reconcile behavior. Exercise via `yarn test:store`
  (streamed) — this ticket touches the store interplay directly.
- Equi-pairs synthesized by decorrelation/quickpick reuse validated operands;
  if a synthesized pair trips the emitter backstop, the admitting gate is the
  bug.

## TODO

- Route join.ts USING comparator, merge-join key collations, bloom-join key
  normalizers, asof-scan match/partition collations through
  resolveComparisonCollation (loud-throw backstop on conflict).
- Locate and align the planner-side ordering/key-collation mirrors for merge
  join (and asof ordering prerequisites); document the lockstep pairing in a
  comment at both ends, as comparison-collation.ts does.
- USING/NATURAL plan-time conflict validation at join build.
- Review equi-pair-extractor gate; loosen only with end-to-end proof, else
  document.
- MV backing-column collationExplicit threading.
- Tests: extend 11.1 (USING precedence both spellings + conflict error), 82,
  83, 84 with case-variant declared-collation keys; MV round-trip case;
  `yarn build`, `yarn test`, lint, one streamed `yarn test:store` run.
