description: Remaining builtin aggregate return-type fidelity — json_group_array/json_group_object → JSON nullable, string_concat → TEXT nullable. COMPLETE.
files:
  - packages/quereus/src/func/builtins/json.ts            # jsonGroupArrayFunc / jsonGroupObjectFunc
  - packages/quereus/src/func/builtins/string.ts          # stringConcatFunc
  - packages/quereus/test/logic/06.6-aggregate-extended.sqllogic
  - docs/functions.md                                     # aggregate return-type table (already accurate)
----

# Remaining builtin aggregate return-type fidelity (json/string) — COMPLETE

Follow-on to `aggregate-return-type-fidelity`. Added an explicit `returnType`
to the three builtin aggregates that were still falling through the
`createAggregateFunction` implicit `REAL nullable` default:

| Function | Declared now |
|---|---|
| `json_group_array(value)` | `JSON` nullable |
| `json_group_object(name, value)` | `JSON` nullable |
| `string_concat(value)` | `TEXT` nullable |

Each mirrors the parent ticket's `group_concat` shape:
`{ typeClass: 'scalar', logicalType: <TYPE>, nullable: true, isReadOnly: true }`.
`JSON_TYPE` import added to `json.ts`; `TEXT_TYPE` was already imported in
`string.ts`.

## Review findings

**Implementation diff reviewed first, with fresh eyes** (the code landed in
commit `8ceaf398` — swept there by a concurrent runner; the
`ticket(implement): …` commit `6531e773` carries only the ticket file. Confirmed
the source/test edits are present in HEAD; this is a commit-attribution oddity
only, already flagged in the handoff, not a code problem).

### Checked — correctness / type fidelity
- **`returnType` shape matches the established pattern** used across
  `aggregate.ts` (count/sum/total/group_concat) and `conversion.ts`
  (`json()` → `JSON_TYPE`). Consistent, minimal, DRY. No issue.
- **Type-pin is two-sided and precise.** The maintained-table strict-shape gate
  (`describeAttachShapeMismatch` in `materialized-view-helpers.ts`, type compare
  is by interned logical-type name) means the new test's *successful* create of
  `agg_rt_mt (ja json null, jo json null, sc text null) maintained as …` pins
  the body-derived types to JSON/JSON/TEXT — a stale REAL default would fail the
  attach. The *negative* test (`agg_rt_bad … ja real null`) asserts the error
  substring `body derives type`, which is emitted only by the type-mismatch
  branch of that gate — so it is a genuine "no longer REAL" pin, not a
  false-positive on some unrelated error. Both directions verified green.
- **Empty / degenerate group behavior unchanged.** `json_group_array`/
  `json_group_object` finalize to `null` for an empty (or all-null-key) group —
  matches the nullable declaration and the JSON type's object-accepting
  `validate`. `string_concat` finalizes to `''` (join of `[]`), never `null`;
  the `nullable: true` declaration is therefore *conservative* (the body never
  actually yields NULL). Left as-is deliberately: it matches the ticket spec,
  mirrors its `group_concat` sibling, and the only consequence is that a
  `text not null` maintained column fed by `string_concat` would be rejected by
  the shape gate — a safe over-restriction, not a correctness bug.

### Checked — regressions / interactions
- **Pre-existing `json_group_*` coverage** (logic files 06.7, 18, 24/25-range,
  27.3 window-aggregate form, 80, 97/97.1) all pass — switching from the latent
  REAL default to JSON did not perturb any value-level result on the projection
  path, nor the window-function form (which reuses the aggregate definition;
  there is no separate `json_group_*` window registration to update).
- **Storage round-trip** through the maintained backing is exercised by the new
  post-create `insert into agg_rt values (4,'b','w')` + re-select, confirming the
  JSON type's serialize/deserialize hooks survive a maintenance pass.

### Checked — docs
- `docs/functions.md` aggregate table already lists `json_group_array` /
  `json_group_object` → **JSON** (lines 162–163) and `string_concat` (string-
  aggregate section, no type column) accurately. No doc drift introduced; nothing
  to update. `docs/sql.md` descriptions remain accurate.

### Minor — fixed in this pass
- None required. No minor defects found warranting an inline change.

### Major — new tickets filed
- None. No latent design problems surfaced.

### Gaps explicitly accepted (not defects)
- **No test asserts `JSON_TYPE.validate` directly.** The validate/serialize hooks
  are exercised *transitively* via the maintained-table round-trip and the
  pre-existing `json_group` logic tests, which is sufficient for this ticket's
  acceptance ("a logic test that pins the declared type"). A direct unit test of
  the JSON type's validate hook is out of scope here and belongs with the JSON
  type itself, not this return-type-fidelity change.
- **`test:store` not run** (slow / not agent-runnable in-ticket). The new test
  pins `collate binary` on the PK specifically so the declared collation matches
  the body-derived one under the store suite's NOCASE key default; memory-suite
  green, store path designed-for but unverified here.

## Validation
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- `yarn workspace @quereus/quereus run test` → **5977 passing, 0 failing**,
  9 pending (exit 0). Golden plans unaffected.

No `.pre-existing-error.md` written — the suite is fully green.
