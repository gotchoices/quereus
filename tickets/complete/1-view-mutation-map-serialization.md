description: Serializer infrastructure that unblocks `Map`-valued `PhysicalProperties` fields. `jsonStringify` (and thus `safeJsonStringify`) now renders a `Map` as a bounded, deterministic `{ "$map": [[k,v],...], "size": N }` summary instead of the default `{}`, so later view-mutation tickets can thread real `Map` fields (`updateLineage`, attribute→default) onto `PhysicalProperties` and have them appear in EXPLAIN / `query_plan()` output. Pure infrastructure — no view-mutation behavior. Reviewed and completed.
prereq:
files: packages/quereus/src/util/serialization.ts (the `jsonStringify` inline replacer `Map` branch + `MAP_SUMMARY_ENTRY_CAP`), packages/quereus/test/util/serialization.spec.ts (9 unit tests), packages/quereus/src/func/builtins/explain.ts (`safeJsonStringify(node.physical)` consumer at line 170, plus logical-attr/trace consumers at 164/541), packages/quereus/src/planner/util/fd-utils.ts (MAX_FDS_PER_NODE/MAX_INDS_PER_NODE = 64, the cap convention matched), packages/quereus/src/planner/debug.ts (`serializePlanTree`/`processValue` — the SEPARATE debug/golden serializer; renders Map as `[COMPLEX_OBJECT]`, NOT touched here)

# View-Mutation `Map` Serialization — Completed

## What shipped

`jsonStringify`'s inline `JSON.stringify` replacer (`util/serialization.ts`) gained
a `Map` branch alongside the existing `bigint` / `Uint8Array` cases. A `Map<K,V>`
now renders as:

```jsonc
{ "$map": [ ["k1", <v1>], ["k2", <v2>], ... ], "size": N }
```

- Entries in `Map` insertion order (deterministic), no key sort.
- Entries are `[String(k), v]` pairs that **re-enter** the replacer, so nested
  `bigint` / `Uint8Array` / nested `Map` values are handled recursively.
- Bounded by `MAP_SUMMARY_ENTRY_CAP = 64` (matches `MAX_FDS_PER_NODE` /
  `MAX_INDS_PER_NODE`); the loop breaks early so work is O(min(size, cap)), and
  `size` always records the true count even when truncated.
- `safeJsonStringify` is unchanged structurally (still try/catch over
  `jsonStringify`); all of its call sites — EXPLAIN physical block, logical
  attributes, trace rows in `func/builtins/explain.ts` — benefit uniformly.

This resolves the "known blocker": a `Map`-valued field on `PhysicalProperties`
previously serialized to `{}` (a Map has no enumerable own properties) on the
EXPLAIN / `query_plan()` surface; it now renders a stable, inspectable summary.

## Review findings

Scope reviewed: the full implement diff (commit `3cc9748d`, two files), the
serializer in context, both serialization surfaces (`safeJsonStringify` vs the
`serializePlanTree`/`processValue` debug path), the cap convention it claims to
match, and the broader regression surface (every consumer of `jsonStringify` /
`safeJsonStringify`).

**Correctness / type safety / performance — checked, no issues.**
The `Map` branch is correct and idiomatic: deterministic order, true `size`,
recursive value handling (verified the returned plain object re-enters the
replacer), early-break bounding (no build-then-slice). `String(k)` keys are
unambiguous for the intended `AttributeId`(number)/string key types. Cross-realm
`instanceof Map` and lossy exotic-key stringification are theoretical and already
match the pre-existing `Uint8Array` branch's posture — not concerns for
engine-controlled `PhysicalProperties`. No code change needed.

**Tests — checked, adequate as a unit floor.**
9 cases cover shape, insertion order, numeric keys, bigint-value re-entry, nested
Map, over-cap truncation with true `size`, Map-in-plain-object, empty Map, and a
bigint/Uint8Array no-regression guard. All pass. No end-to-end EXPLAIN test over a
Map-bearing `node.physical` exists — correctly deferred, since no physical field
is a `Map` yet (that is `view-mutation-physical-lineage`'s job).

**Lint / typecheck / full suite — run, all green.**
`yarn lint` clean, `yarn typecheck` clean, focused spec 9 passing, `test/plan`
suite 66 passing, full `@quereus/quereus` suite **4004 passing / 0 failing / 9
pending** (the 9 pending are pre-existing skips). The clean full-suite run is the
real regression evidence that no existing `Map`-through-`jsonStringify` call site
shifted output (no test asserted on the old `{}` rendering).

**Minor — handoff cited a nonexistent file/symbol (fixed by correction here).**
The review-handoff `files:` header and Notes referenced
`packages/quereus/src/planner/framework/serialization.ts` and a
`serializePhysicalProperties` function as "the OTHER serializer used by the golden
path." Neither exists (`framework/` has no `serialization.ts`; the symbol has zero
references). The actual separate serializer is `planner/debug.ts`
(`serializePlanTree` → `processValue`), which renders a `Map` value as the literal
string `[COMPLEX_OBJECT]` (Map's constructor is neither `Object` nor `Array`), NOT
as `$map`. No shipped code is affected — this is a handoff documentation error;
the accurate reference is recorded in this ticket's `files:` header and in the
`golden-plan-harness-noop` fix ticket so `view-mutation-physical-lineage` is not
misled into teaching Map handling to a function that does not exist.

**Major — golden-plan harness is a no-op (pre-existing; filed as a new ticket).**
The handoff's central validation claim — "3 golden fixtures byte-identical, zero
churn" — is hollow. `test/plan/golden-plans.spec.ts` registers its per-case
comparison `it()`s inside a Mocha `before()` hook, which Mocha never schedules, so
only the informational `should have test cases` test runs (confirmed: the plan run
shows no `should match golden plan for ...` lines). Additionally, no
`.logical.json` / `.physical.json` fixtures are committed — only the `.sql`
inputs — so the comparison would throw "Missing golden files" even if it ran. The
golden corpus therefore catches nothing. This is **pre-existing** (outside this
ticket's two-file diff) and the shipped serializer is correct regardless (verified
via its own unit spec + the clean full-suite run), so it does not block
completion. Filed as `tickets/fix/golden-plan-harness-noop.md` because the
follow-up `view-mutation-physical-lineage` ticket is expected to rely on golden
coverage of `PhysicalProperties` and currently has none.

**Docs — checked, no staleness introduced.**
`docs/view-updateability.md` describes the eventual view-mutation feature and the
`query_plan().properties` surface but does not document `safeJsonStringify`'s Map
handling, so this internal infrastructure change introduces no doc drift. No other
doc references the serializer's Map behavior.

## Follow-up tickets filed

- `fix/golden-plan-harness-noop` — make the golden-plan comparison tests actually
  run, commit fixtures, and decide which serializer (EXPLAIN/`query_plan` `$map`
  path vs `processValue` `[COMPLEX_OBJECT]` path) the golden corpus should reflect.

## Disposition

Implementation is correct, well-tested at the unit level, and regression-clean.
Completed with the handoff's two inaccurate claims corrected above and the
pre-existing harness gap routed to a fix ticket. No inline code changes were
required.
