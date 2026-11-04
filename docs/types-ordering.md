# Semantic Ordering and Comparison Identity

> **Stability: Stable** — see [Stability Tiers](stability.md#tiers).

Which comparison a value gets when its declared logical type orders differently from its
stored representation — the `semanticOrdering` / `collationAware` flags, the surfaces that
route through the type's `compare`, the ones that route through `groupKey` identity
instead, and how text converts before it is compared against a DATE, TIME, DATETIME or
TIMESTAMP. A satellite of [Quereus Type System](types.md).

## Semantic ordering

Some logical types define an order that observably differs from the storage-class +
collation order of their stored representation. These declare
`semanticOrdering: true` on the `LogicalType`, and the rule is:

> Wherever a value of a declared logical type is ordered or compared — ORDER BY,
> `<`/`>`/`=` operators, BETWEEN, IN membership, primary-key/index order and range
> scans, DISTINCT / GROUP BY / set-operation identity, window ORDER BY/PARTITION BY,
> merge/hash join keys, UNIQUE constraint enforcement — the type's `compare` function
> is the order. Text/byte order is a storage encoding detail, never a user-visible
> semantic.

Today the flag is set on **TIMESPAN** (elapsed-time order) and **JSON** (structural
order). DATE/TIME/DATETIME need no flag: their canonical ISO text order *is* their
semantic order, so the cheaper storage-class compare is already correct. ANY and
untyped expressions have no semantic-ordering type and keep storage-class +
collation ordering (their declared `compare` reproduces exactly that ordering, which
is why the flag — not mere presence of `compare` — gates routing).

A sibling flag, `collationAware: true`, marks the types whose `compare` **applies the
collation function it is handed** — TEXT and ANY. It drives the opposite decision
from `semanticOrdering`: not "route comparisons through `compare`" but "key declared
structures under the column's collation". A key structure built over a column
(memory PK/index BTrees via `createTypedComparator`, the persistent store's key
bytes, the isolation overlay's shadow keys — resolved through `pkKeyCollationName`)
keys a collation-aware column under its declared COLLATE, so `k any collate nocase`
enforces and orders case-insensitively everywhere; a collation-blind type (JSON, the
temporals — whose `compare` is not the generic storage-class + collation comparison:
the temporals ignore the argument, JSON ranks structurally and applies the collation
only to a string-scalar pair) keys hard-BINARY regardless.
Creating an index therefore never changes a query's answer for either kind.

The flag keys on the **declared** logical type of the column/expression, not the
runtime value: an ANY column holding a duration-shaped string still orders as text.
When only one side of a comparison is declared (e.g. `timespan_col > 'PT90M'` with a
plain text literal), the runtime temporal check in the generic comparison path still
compares durations semantically; the typed fast path engages when *both* sides share
the semantic-ordering type. JSON reaches that shared-type shape a different way — it
has no runtime escape hatch (its values are objects, not text), so the *undeclared*
side is cast to JSON at plan time instead, and the typed path then engages normally.
See the JSON entry under [types.md § Special Types](types.md#special-types). Probes of a
different storage class (an integer literal
against a TIMESPAN column) order by storage class and never falsely compare equal
(`createTypedComparator`'s mismatch fallback).

The comparison builtins follow the rule through a schema declaration: `nullif`,
`greatest` and `least` mark the argument positions they compare as one group
(`BaseFunctionSchema.comparesArgs`), which drives the same object-physical
coercion `=`/IN/simple CASE apply and an emit-time comparator bound through the
shared collation lattice — so `nullif(d, 'PT120M')` matches exactly when
`d = 'PT120M'` does, and `greatest`/`least` rank a TIMESPAN or collated-TEXT group
the way ORDER BY would. A `greatest`/`least` group whose operands do not all
declare one type (a TIMESPAN column against a bare text literal) routes through
the same generic path a mixed `>` does, so the runtime duration check still
applies. Which raw value `greatest`/`least` return for values a non-BINARY
comparator ties ('PT1H' vs 'PT60M') is unspecified, the same latitude the min/max
aggregate and DISTINCT take.

All three of them *return* one of their arguments, so they also declare
`BaseFunctionSchema.returnsArg` and their coercion runs at emit time rather than
as a plan-time cast: `makeComparisonGroup` (`runtime/emit/operand-comparator.ts`)
converts a per-row *copy* of each argument for the comparison and the emitter hands
back the raw argument. Both paths make the identical conversion (a plan-time
`CastNode` runs the same `lenientCast`), so only the returned value differs —
`greatest(json_col, '{"a":2}')` compares structurally but returns the text literal
as written when the literal wins. Rewriting the argument instead would make the
cast's output the result, which is how `least('abc', 1)` used to return `0`, a
value that was never an argument. A comparison builtin that returns a *fresh*
value leaves `returnsArg` unset and keeps the plan-time rewrite. Because the
arguments the planner sees are then the ones the user wrote, `greatest`/`least`
declare `ANY` for a group that is neither all-one-type nor all-numeric, rather
than advertising the first argument's type for a value that may not have it. A
NULL-typed argument is left out of that test — the only value it can win with is
NULL, which the declaration is nullable for anyway — so `greatest(int_col, null)`
still declares INTEGER.

`greatest`/`least` both skip NULL arguments, matching the `min`/`max`
aggregates and the window MIN/MAX — a NULL argument contributes nothing, and
an all-NULL (or zero-argument) call returns NULL. The result never depends on
where a NULL sits in the argument list, e.g. `least(1, null, 3)` is `1`.
Pinned by `test/logic/24-builtin-branches.sqllogic`.

**Join keys: the mixed-pair rule.** A physical equi-join key (hash / bloom / merge)
compares with no type context, so it can only carry a pair whose two sides agree on
semantic ordering — either neither declares a semantic-ordering type, or both declare
the SAME one. A **mixed** pair, `timespan_col = text_col`, is inadmissible: `=` runs
its generic path's runtime duration check and matches 'PT1H' against 'PT60M', which a
raw-text hash key or merge co-walk does not. The equi-pair extractor
(`planner/rules/join/equi-pair-extractor.ts`) declines such a pair, demoting it to the
join's residual predicate, so the `=` operator's own semantics decide the match. The
cost is that a rare shape drops to nested-loop; losing rows is worse.

Declining rather than canonicalizing the key is deliberate. Merge join needs both
inputs physically sorted in its comparator's order, and a `timespan` side is sorted by
elapsed time while a `text` side is sorted by text — no single comparator merges those
two orders, so canonicalizing would fix hash join and leave merge join unsound.
Canonicalizing also introduces a false-positive hazard: TIMESPAN's `groupKey` returns a
*number*, so a `timespan` ↔ `integer` pair would hash-match values `=` reports unequal.

`using (k)` has no comparison machinery of its own: `buildUsingCondition`
(`planner/building/select.ts`) desugars it at build time into the `l.k = r.k` node an ON
join builds — through `buildComparison` (`planner/building/expression.ts`), the single
helper both spellings construct a comparison with — so it inherits everything hanging
off that node: plan-time cross-type coercion (a JSON column joined `using` a TEXT
column compares structurally), the
collation lattice, the mixed-pair rule above, and NULL handling (`null = null` is
UNKNOWN, so a NULL key never matches on either physical path).

One surface still does **not** follow the rule.

**AS OF** match/partition columns compare by storage class + collation. Correct for the canonical AS OF column
types (DATE/DATETIME, whose ISO text order is their semantic order), wrong for a TIMESPAN
or JSON match column. AS OF has no residual to demote into, so the join gate does not
apply. Tracked as `tickets/backlog/bug-asof-match-column-ignores-semantic-ordering`.

**CHECK / assertion-derived equality facts** follow it. `check-extraction.ts` lifts
cross-column mirror FDs, an equivalence class, and one-way `col = expr` determinations from a
declared CHECK onto the table reference itself — where predicate inference reads them
directly — so each cross-column arm carries the same `semanticOrderingsAgree` gate. `create
table ck (d timespan, s text, check (d = s))` mints nothing for the pair, and a row
`('PT1H', 'PT60M')` — which the CHECK legitimately accepts, since `=` compares the two by
elapsed time — still comes back from `select … where d = 'PT1H'`. A **constant pin** from a
CHECK (`check (d = 'PT60M')`) is ungated for the same reason the filter-side pin is (below).

**Filter-level equality facts** follow it, with one deliberate asymmetry.
`extractEqualityFds` (`planner/util/fd-utils.ts`) mints value-level claims from `where`
equalities, and the **cross-column** arm carries the same `semanticOrderingsAgree` gate the
join extractors do (invariant OPT-051): `where d = s` over a TIMESPAN `d` and a TEXT `s`
mints no mirror FDs and no equivalence class, because two surviving rows can agree on `d`
(same elapsed time) while disagreeing on `s` (distinct strings) — the two columns have no
common notion of "same value". A **constant pin** (`where d = 'PT60M'` ⇒ `∅ → d` plus a
constant binding) is deliberately *not* gated: under the engine's identity for a TIMESPAN
column — the same identity `distinct` / `group by` / `unique` use — every surviving row
holds the same value, so the FD is true, and a `ConstantBinding` claims only that the
column *compares equal to* the bound value under its own comparison, not that it stores
that spelling. A consumer needing raw-value identity must not read a binding.

Hash-keyed identity (GROUP BY, window PARTITION BY, hash-join build/probe) cannot
call `compare` pairwise, so a semantic-ordering type whose stored form is not
canonical for equality also supplies `groupKey` — a canonical representative such
that compare-equal values serialize to the same hash key (TIMESPAN maps to total
seconds against the same fixed reference date `compare` uses). JSON needs no
`groupKey`: canonical-text equality and structural equality coincide.

`IN` is an identity test, so it routes through `groupKey` rather than `compare`: when
either side declares a semantic-ordering type, `emitIn` normalizes the probe and every
RHS value before comparing, so `d IN ('PT120M')` matches a `'PT2H'` row exactly as
`d = 'PT120M'` does. Normalizing (instead of dropping `compare` into the membership
BTree's comparator) is what keeps the set structures sound — the normalized keys rank
by plain storage-class order, which stays total even when a list literal is not a valid
value of the type, whereas `TIMESPAN.compare` mixes elapsed-time and text ordering
there and is not.

UNIQUE enforcement collapses the same identity on **every** backend. A constrained
column whose declared type carries semantic ordering is compared through that type's
`compare`; every other column keeps the storage-class + collation comparison (a
TEXT/ANY column's declared `compare` honors the collation it is handed —
`collationAware` — and is equivalent to the generic path, so the cheaper generic
comparator is used; the `hasSemanticOrdering` flag is the gate). The
per-column comparators are built once per constraint check by the shared
`uniqueEnforcementComparators` (`schema/unique-enforcement.ts`), which the memory
backend's three re-validators, the persistent store's finders, the isolation
overlay's merged-view search, and the covering materialized view's shared candidate
generator (`lookupCoveringConflicts` — see [mv-constraints.md](mv-constraints.md))
all call, so the backends cannot drift. Concretely, in a
`d timespan unique` column an insert of `'PT60M'` after `'PT1H'` raises a UNIQUE
violation, `insert or ignore` drops it, and `insert or replace` evicts the existing
row — the same on memory and store.

`insert … on conflict (<cols>) do update / do nothing` routes on that same identity.
The virtual table reports the conflicting row but not which constraint fired, so the
DML executor decides which `on conflict` clause a violation belongs to by comparing
the proposed and existing rows at the clause's target columns — through comparators
built by the same `uniqueEnforcementComparators` (per-column enforcement collations
resolved at plan time by `resolveConflictTargetEnforcement` in
`planner/building/insert.ts`, comparators built once at emit in
`runtime/emit/dml-executor.ts`). So `on conflict (d) do update` fires for a re-spelled
TIMESPAN duration rather than aborting with a UNIQUE error, while a NOCASE/RTRIM
column keeps routing by its collation. One residual corner is unfixable by value
comparison and stays out of scope: an insert violating the targeted constraint *and*
another one at once is suppressed by the matching clause, because the vtab
short-circuits on the first violation and never reports the second.

The persistent store follows the same rule for both identity and order (resolved by
`quereus-store`'s `storeSemanticKeyTransform`): a TIMESPAN key member is encoded
through `groupKey`, so `'PT1H'` and `'PT60M'` collide on one physical key — duplicate
spellings raise the ordinary PK/UNIQUE violation, `on conflict` actions fire, and the
isolation overlay shadows across spellings; a JSON key member is encoded in a
store-local **structural byte form** (`jsonStructuralKey`, `quereus-store`'s
json-key.ts) whose memcmp order reproduces the structural compare — so a store scan
emits JSON keys in `compare` order, agreeing with the memory backend, and the
isolation overlay aligns its merge streams (an in-transaction update or delete of a
JSON-keyed row shadows correctly). With both types' key bytes order-faithful *and*
identity-faithful, the store reads such columns through their key bytes rather than
by scanning: it *advertises* PK order over TIMESPAN/JSON key members (`order by <pk>`
elides its Sort), serves a leading-column *range* predicate as a byte-window seek,
and serves an *equality* as a point read — a full-PK `where d = 'PT60M'` fetches the
single key the row stored as `'PT1H'` occupies, and `where j = json('{"b":2,"a":1}')`
the one stored as `'{"a":1,"b":2}'`; the same holds for a secondary index whose
leading columns are such types.

Two gates govern all of it: an explicit per-type allow-list
(`semanticKeyOrderIsFaithful`, `quereus-store`'s pk-key-resolution.ts — a claim about
the values a table can *hold*, deliberately not inferred from a transform's mere
existence) and a per-value probe gate (`semanticProbeIsKeyFaithful`) on each seek
*probe*, since nothing coerces a query value to the column's declared type. A probe
with no faithful byte position (a numeric or unparseable TIMESPAN probe, a
blob/bigint JSON probe) degrades in whichever way that arm can afford, and the
type-aware residual decides every row either way:

- a *range* bound is **dropped**, which only widens the window back toward a full scan;
- a *full-PK equality* **declines the whole point arm** — a point window is a single
  byte position and cannot be widened, only under-fetched;
- a secondary index's *EQ prefix* **stops short** at that column — a window over the
  columns before it is a strict superset, which the residual then narrows.

(An unpaired surrogate inside a JSON probe is deliberately not degraded: it *raises*,
matching the rule a text primary key's seek bounds already carry.) IN-list
multi-seeks are the one shape still declined outright — their merged windows are the
whole access, with none of the three degradations available — tracked as backlog
`feat-store-semantic-key-multiseek`.

The `min`/`max` **aggregates** follow the same rule: at emit (and materialized-view
plan-build) time the call site binds the aggregate to its argument's declared type
and resolved collation (`AggregateFunctionSchema.bindArgs`, applied via
`bindAggregateSchema`), replacing step/merge/decode/finalize with closures over the
argument's semantic comparator. So `min(timespan_col)` returns the shortest
duration, `min(json_col)` the structurally-least document, and `min` over a
`collate nocase` column the NOCASE-least value — each agreeing with
`order by … limit 1` — and store-maintained materialized-view min/max columns
(delta merge and read-side rollup both execute the bound algebra) agree with
direct evaluation. Untyped/ANY arguments with no declared collation keep the
storage-class + BINARY behavior. Under a semantic tie with byte-different
spellings (`'PT1H'` vs `'PT60M'`), which raw value survives is unspecified — the
same latitude DISTINCT and GROUP BY take for a group representative.

An aggregate's *result* type carries its argument's logical type but **not** the
argument's collation, so a materialized view over `min(nocase_col)` has a
BINARY-declared backing column. Anything that re-ranks stored partials must
therefore take the collation from the argument, not from the backing column — the
read-side rollup does so via the collation the rewrite matcher records alongside
each stored partial (`MergeReagg.argCollation`).

**Window** `min(x) over (…)` / `max(x) over (…)` follow the same rule through the
same seam. Window functions live in their own registry
(`schema/window-function.ts`), so it carries its own `bindArgs` hook — taking the
same `AggregateArgBinding` and routing through the same
`createSemanticValueComparator` — applied by `bindWindowSchema` where
`runtime/emit/window.ts` resolves each call site's schema. The window emitter has
three execution shapes (the buffered frame walk, the streaming running
accumulator, and the streaming sliding-frame scan) and all three fold through
that one bound schema, so they cannot rank differently for the same query.

## DATE, TIME, DATETIME and TIMESTAMP against text

> Comparing one of these types against text normalizes the text exactly as a write to that
> column would. Text that does not parse compares as plain text. A comparison asks whether
> the column's value equals what this text would have stored.

Each of these types is stored in one form: a UTC date, a UTC time, bare UTC datetime text or
an integer. Order over that form is already its semantic order, so none has a
`semanticOrdering` flag. What they need is for the text a query spells to reach that form
before the comparison. On a DATETIME, `t = '2020-01-01T00:00:00Z'` finds the row that text
created and `t >= '2021-06-05T09:00:00+02:00'` compares the instant it names. On a TIMESTAMP,
`ts = '2020-01-01T00:00:00Z'` finds `1577836800000`.

The optional `normalizeComparand` hook on `LogicalType` provides this, and these four types
define it, each sharing its text conversion with its `parse` so that a write and a
comparison cannot drift. When one operand has the hook and the other is textual or ANY,
`crossTypeCoercion` (`types/comparison-coercion.ts`) converts the other one. ANY is
included because an untyped `?` announces it, and a bound parameter is the most common way
an application hands in a timestamp.

This is not `cast(x as datetime)`. Text that does not parse compares as plain text, so
`t = 'garbage'` is false and `t < 'garbage'` is true for every row. A TIMESTAMP gives the
same answers, because a number sorts before text. Only text converts, so a number is not
read as an epoch, although a write or a CAST reads it that way. Only the
planner's own casts behave like this: a user-written `cast('junk' as datetime)` is still
NULL.

Consequences worth knowing:

- A DATE compared with text carrying a time compares the date part only, not that date's
  midnight: for a stored `2024-01-15`, `d = '2024-01-15T12:00:00'` is true and
  `d < '2024-01-15T12:00:00'` is false. An offset or `[zone]` moves the text to its UTC date
  first, as a write does, so `d = '2024-01-15T23:00:00-05:00'` finds `2024-01-16`.
- `date(col)` returns DATE, so `date(col) = <text>` follows the same rule. The literal folds
  to a bare date before the sargable range rewrite reads it, and the rewrite declines anything
  else, so the filter and the evaluated comparison agree. `date(col) = '2020-01-01[Mars/Base]'`
  names a zone a write rejects, so it compares as text and matches nothing.
- Blank text against a TIMESTAMP is NULL, because a write of it stores NULL, so `ts = ''`,
  `ts <> ''` and `ts not in ('')` match no rows, as they do for INTEGER. DATE, TIME and
  DATETIME reject blank text on a write, so for them it stays text.
- Integer-shaped text against a TIMESTAMP reads as that integer, trimmed and with no unit
  interpretation, so `ts = ' 1000 '` finds `1000`. Datetime text reads as epoch milliseconds.
- Time-only text carrying an offset or `[zone]` is rejected by a write to TIME, so
  `t = '12:00:00-05:00'` compares as text and finds nothing.
- A date-only bound against a DATETIME means that date's midnight, so
  `t between '2021-01-01' and '2022-01-01'` includes a row at exactly midnight on 2022-01-01.
- A literal folds to the stored form at plan time, so `=`, ranges, BETWEEN and IN lists
  still plan as index seeks. A parameter keeps the cast in its seek key.
- A text operand that differs per row, such as a text column, parses per row. A parameter or
  literal that repeats one string is remembered at the comparison site and parses once.
- `dt_col = text_col` does not plan as a hash join, because the cast moves the pair out of
  the join's equality keys and into its residual condition. The same holds for the other
  three types. Joins between two columns of one type are unaffected.
- `nullif`, `greatest` and `least` rank by the converted key and still return the argument as
  written, so `greatest(t, '2021-06-05T11:00:00+02:00')` returns that literal's own spelling
  when it wins.
- A watch on `t = ?` keys on the converted value, not the bound spelling
  ([Change Scope](change-scope.md)).

**One probe against many values** follows the rule in
[types.md § Type Coercion in Comparisons](types.md#type-coercion-in-comparisons). A probe of
one of these types converts each textual or ANY value independently, and a textual or ANY
probe converts once, only when every non-NULL value has that one type. A probe against a list
mixing such a type and text stays unconverted, because converting it would make
`text_col in (dt_col, '2020-01-01T00:00:00Z')` miss an exact text match that the `=`
disjunction finds.

**Shape checks see the canonical spelling.** `check (ts like '%Z')` on a `datetime` column
fails every insert, because the engine owns the stored spelling and a CHECK sees the stored
value. A column that must keep the caller's exact text should be `text`, using `datetime(col)`
to compare it as an instant.

**Rows stored earlier with a `Z`.** `datetime('now')` used to return a `Z` spelling while
announcing DATETIME, so the write path stored that `Z` unconverted. Nothing migrates those
rows, and they do not match a normalized comparison exactly. `update t set c = datetime(c)`
rewrites them.
