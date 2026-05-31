<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-05-31T08:29:01.738Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\temporal-filter-raw-literal-comparison-test.implement.2026-05-31T08-29-01-736Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Pin in the sqllogic corpus that a pushed-down temporal (DATE/DATETIME/TIME) comparison literal is compared RAW (BINARY, no canonicalization) against the stored canonical value. A future planner change that inserted literal canonicalization for temporal operands (a temporal cast-insertion arm, or a parsed/canonicalized seek-key value) would silently start matching a non-canonical literal, with no test failing today. Add non-canonical-literal filter cases so the native engine's no-canonicalization contract is bound by an automated test.
files:
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic (add the new section here)
  - packages/quereus/test/logic.spec.ts (sqllogic runner; describe is `File: 98-temporal-edge-cases.sqllogic`)
  - packages/quereus/src/planner/building/expression.ts (insertCrossTypeCoercion — Cast inserted ONLY for numeric↔textual operand pairs)
  - packages/quereus/src/planner/analysis/constraint-extractor.ts (getLiteralValue — returns the raw AST literal)
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts (seek-key value path; also reads the literal raw via getLiteralValue)
  - packages/quereus/src/runtime/emit/temporal-arithmetic.ts (tryTemporalComparison — TIMESPAN-only; DATE/DATETIME/TIME fall through)
  - packages/quereus/src/runtime/emit/binary.ts (calls tryTemporalComparison, else BINARY_COLLATION compare)
----

# Pin RAW comparison of pushed-down temporal filter literals

## Background

A DATETIME/DATE/TIME column canonicalizes its **stored** value to the bare
`PlainDateTime`/`PlainDate`/`PlainTime` form. The existing `dt_canon` / `d_canon`
/ `t_canon` sections of `98-temporal-edge-cases.sqllogic` already pin this: e.g.
`1500000000000`, `'2017-07-14T02:40:00Z'`, `'2017-07-14T04:40:00+02:00'` and three
other shapes all store the single bare canonical value `'2017-07-14T02:40:00'`.

The **comparison literal** on the read/filter path, however, is **not**
canonicalized — it is compared **RAW** (BINARY, byte-for-byte) against the stored
canonical value. Three source sites make this true today:

- `planner/building/expression.ts` `insertCrossTypeCoercion` — a `Cast` is
  inserted only when one operand `isNumeric` and the other `isTextual`. Temporal
  types are neither, so no cast is synthesized around a temporal comparison
  operand (confirmed: the function gates purely on `isNumeric`/`isTextual`).
- `planner/analysis/constraint-extractor.ts` `getLiteralValue` — returns the raw
  AST literal value; the same helper feeds the pushed-down seek-key path in
  `planner/rules/predicate/rule-sargable-range-rewrite.ts`, so the seek key is the
  raw literal too.
- `runtime/emit/temporal-arithmetic.ts` `tryTemporalComparison` — handles TIMESPAN
  only; DATE/DATETIME/TIME comparisons fall through to `BINARY_COLLATION` in
  `runtime/emit/binary.ts`.

The net contract: a Z-suffixed or offset-bearing literal that denotes the *same
instant* as the stored row does **not** equal the bare stored value, because the
two byte strings differ.

## The gap

This RAW-comparison contract is currently only **source-verified**, not pinned by
a test. A future change that added temporal literal canonicalization — a temporal
arm in `insertCrossTypeCoercion`, or canonicalizing the seek-key value in the
sargable-range rewrite — would make these comparisons start *matching* a
non-canonical literal, and **no existing test would fail**. The `dt_canon` section
only exercises canonicalization of *stored* values via INSERT; it never filters
with a non-canonical literal.

## Cross-repo motivation (why this matters beyond Quereus)

The Lamina storage engine (separate repo) replays this exact sqllogic corpus
through its conformance harness (`packages/lamina-quereus-test/src/sqllogic/sqllogic.test.ts`)
and compares Lamina against native Quereus. Lamina compares the filter literal raw
on every path; it relies on native Quereus *also* comparing raw, so there is no
divergence. That "matches native Quereus" claim is today only a manual reading of
the three sites above. Landing these cases here binds the native side directly:
any future Quereus literal-canonicalization regression fails the native expectation
in this file, and any Lamina drift fails the conformance replay. This ticket is the
native-side half of Lamina's `lamina-temporal-filter-differential-native-pin`
backlog item, which cannot be landed from inside the Lamina checkout.

## What to add

Append a new section to `98-temporal-edge-cases.sqllogic` (after the existing
canonicalization sections, before EOF). Expected outputs below are derived from the
`dt_canon`/`d_canon`/`t_canon` canonical forms already pinned in this file; confirm
each by running the focused file and adjust only if the engine genuinely differs.

### DATETIME (core — mirrors the Lamina-side assertion exactly)

```sql
-- ============================================================
-- DATETIME pushed-down filter: the comparison LITERAL is compared
-- RAW (BINARY, no canonicalization) against the stored canonical
-- value. Row 1 stores the bare form '2017-07-14T02:40:00' (see
-- dt_canon above). A Z-suffixed or offset-bearing literal that
-- denotes the SAME instant does NOT match the bare stored value.
-- Pins the no-canonicalization contract against a future planner
-- change that inserts a temporal cast or canonicalizes the seek key.
-- ============================================================

CREATE TABLE dt_filter (ts DATETIME PRIMARY KEY);
INSERT INTO dt_filter VALUES ('2017-07-14T02:40:00Z');   -- stores bare '2017-07-14T02:40:00'
INSERT INTO dt_filter VALUES ('2017-07-14T03:40:00');    -- a later canonical row, stored bare
-- run

-- Z-suffixed literal of the SAME instant as row 1: raw compare → no match.
SELECT count(*) as c FROM dt_filter WHERE ts = '2017-07-14T02:40:00Z';
→ [{"c":0}]

-- +01:00-offset literal denoting the SAME instant as row 1
-- ('2017-07-14T03:40:00+01:00' == 02:40:00Z): still raw, still no match — and
-- note it does NOT match row 2 either, whose bare stored value shares the
-- '2017-07-14T03:40:00' prefix but lacks the '+01:00' suffix.
SELECT count(*) as c FROM dt_filter WHERE ts = '2017-07-14T03:40:00+01:00';
→ [{"c":0}]

-- The bare canonical literal matches exactly.
SELECT count(*) as c FROM dt_filter WHERE ts = '2017-07-14T02:40:00';
→ [{"c":1}]

-- Range: raw lexicographic order places bare '...02:40:00' BELOW the
-- Z-suffixed '...02:40:00Z' (the bare form is a proper prefix), so row 1
-- is included by strict-less-than and row 2 ('...03:40:00') is not.
SELECT ts FROM dt_filter WHERE ts < '2017-07-14T02:40:00Z';
→ [{"ts":"2017-07-14T02:40:00"}]

DROP TABLE dt_filter;
```

### DATE and TIME (recommended — same code path, cheap, subsumes Lamina's optional note)

DATE and TIME share the identical raw-comparison path (all `isTemporal`, all
BINARY compare) but are not separately exercised for the filter literal. Adding
them here closes that gap natively for all three temporal types — and, because
Lamina replays this file, removes the need for a Lamina-side-only DATE/TIME
extension. Use the bare canonical forms the existing `d_canon`/`t_canon` sections
establish (`'2024-01-15'`, `'10:30:00'`):

```sql
CREATE TABLE d_filter (d DATE PRIMARY KEY);
INSERT INTO d_filter VALUES ('2024-01-15T10:30:00Z');   -- stores bare '2024-01-15'
INSERT INTO d_filter VALUES ('2024-01-20');
-- run

SELECT count(*) as c FROM d_filter WHERE d = '2024-01-15T10:30:00Z';
→ [{"c":0}]

SELECT count(*) as c FROM d_filter WHERE d = '2024-01-15';
→ [{"c":1}]

DROP TABLE d_filter;

CREATE TABLE t_filter (t TIME PRIMARY KEY);
INSERT INTO t_filter VALUES ('2024-01-15T10:30:00Z');   -- stores bare '10:30:00'
INSERT INTO t_filter VALUES ('12:00:00');
-- run

SELECT count(*) as c FROM t_filter WHERE t = '2024-01-15T10:30:00Z';
→ [{"c":0}]

SELECT count(*) as c FROM t_filter WHERE t = '10:30:00';
→ [{"c":1}]

DROP TABLE t_filter;
```

## Validation

Run the focused file in the default (memory) backend and in store mode — the
filter path differs between backends, so both must pass:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "98-temporal-edge-cases"
```

and the same prefixed with `QUEREUS_TEST_STORE=true` (or run `yarn test` /
`yarn test:store` per AGENTS.md for the full sweep).

## TODO

- Add the DATETIME `dt_filter` section to `98-temporal-edge-cases.sqllogic`,
  confirming each expected output by running the focused file.
- Add the DATE `d_filter` and TIME `t_filter` sections (recommended).
- Run the focused logic file in memory mode and store mode; both must pass.
- If any expected output differs from the engine's actual behavior, treat that as
  a finding — the no-canonicalization contract may have already drifted — and note
  it in the review handoff rather than silently editing the expectation to match.
