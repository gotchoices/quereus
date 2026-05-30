description: Review the typed registry for the reserved `quereus.*` tag namespace and its PoC wiring into the lens-compile path. Additive, behavior-neutral infrastructure: validates shape + site of reserved tags (unknown / mis-sited / malformed → sited diagnostic), reads NO reserved tag's semantics. The single validation entry point, typed accessors, and the lens-ack PoC ship; no `quereus.update.*` DML/view wiring (that is view-mutation Phase 2).
prereq:
files: packages/quereus/src/schema/reserved-tags.ts (new, the registry), packages/quereus/src/schema/lens-compiler.ts (PoC wiring: validateLensTags + call in deployLogicalSchema), packages/quereus/test/schema/reserved-tags.spec.ts (new, 30 unit cases), packages/quereus/test/logic/53-reserved-tags.sqllogic (new, end-to-end lens-ack), docs/view-updateability.md (anchor ~269), docs/lens.md (anchor ~176), packages/quereus/src/schema/schema-differ.ts (NOT changed — see gap #1), packages/quereus/src/schema/lens.ts (LogicalConstraint shape consumed), packages/quereus/src/schema/table.ts (constraint .tags consumed)
----

## What shipped

A frozen, typed registry for the reserved `quereus.*` tag namespace, plus a proof-of-concept
wiring into `apply schema` for a logical schema. The namespace was previously consumed at ZERO
code sites and stored as untyped `Record<string, SqlValue>`; a typo (`quereus.update.taget`)
silently no-opped. The registry makes unknown / mis-sited / malformed reserved keys fail with a
sited diagnostic.

### `packages/quereus/src/schema/reserved-tags.ts` (the module)

- **Types**: `TagSite` (7 sites), `TagValueSchema` (`string` | `csv-of-identifiers` |
  `{enum}` | `required-nonempty-rationale` | `expression`), `ReservedTagSpec`,
  `TagDiagnostic` / `TagDiagnosticReason` (`unknown-reserved-tag` | `tag-not-allowed-here` |
  `invalid-tag-value`) with a `severity: 'error' | 'warning'` field, `TypedValueFor<K>`.
- **`RESERVED_TAGS`**: 7 frozen specs transcribed from the doc tables (each cites its doc line):
  `quereus.update.{target, exclude, default_for.<column>, delete_via, policy}`,
  `quereus.lens.ack.<code>`, `quereus.lens.access.<col>`.
- **`validateReservedTags(tags, site)`**: policy-free; never throws. Per key: non-`quereus.*`
  → skipped; no spec → `unknown-reserved-tag` (error); wrong site → `tag-not-allowed-here`
  (error); bad value → `invalid-tag-value` (empty ack rationale → **warning**, else **error**).
- **`getReservedTag(tags, key)`** (typed by exact key; enum keys narrow to their union) and
  **`getReservedTagByTemplate(tags, template)`** (enumerate `default_for.<col>` /
  `lens.ack.<code>` instances; captures the whole remainder incl. any `:target`). Both do NO
  validation — callers must validate first.

### PoC wiring — `lens-compiler.ts`

`deployLogicalSchema` now calls `validateLensTags(slot)` inside the compile-first loop (before
any catalog mutation, so a bad tag aborts the deploy atomically). It validates
`logicalTable.tags` (`logical-table` site) and each constraint's `.tags` (`logical-constraint`
site). First `error` diagnostic → `throw new QuereusError(message, StatusCode.ERROR)`;
`warning` diagnostics → `log(...)` (errors take precedence; warnings log only if none fail).

## How to validate

```
# build (clean)
yarn workspace @quereus/quereus run build

# unit registry tests (30 cases) — pure function, all reasons/severities/accessors
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/schema/reserved-tags.spec.ts" --colors

# end-to-end lens PoC
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "53-reserved-tags" --colors

# full suite (memory-backed)
node packages/quereus/test-runner.mjs        # 3878 passing, 9 pending at handoff
```

Status at handoff: build clean; full quereus suite **3878 passing / 0 failing**; my files lint
clean. One **pre-existing** lint error exists in an unrelated untracked file
(`test/zzz-temporal-literal-probe.spec.ts`, a temporal-literal debug probe I did not create) —
documented in `tickets/.pre-existing-error.md` for the runner's triage pass.

## Use cases / scenarios the tests pin (treat as a floor, not a ceiling)

Unit (`reserved-tags.spec.ts`):
- Free-form user tag (`display_name`) → no diagnostic; reserved + user mixed → only reserved checked.
- Unknown key on exact (`quereus.update.taget`) and templated (`quereus.lens.akc.x`) → error.
- Empty template remainder (`quereus.update.default_for.`, `quereus.lens.ack.`) → unknown (error).
- Mis-sited: `delete_via`@view-ddl, `lens.ack`@view-ddl, `policy`@dml-stmt → error.
- Enum miss: `policy='looose'`, `delete_via='sideways'` → error; every valid enum member accepted.
- CSV: `'base_a, base_b'` ok; `''` and `'a, , b'` → error.
- Rationale: `''` / whitespace → **warning**; non-empty → ok.
- `string`/`expression`: text ok; non-text `default_for` value → error.
- `getReservedTag` enum read; absent / null → undefined.
- `getReservedTagByTemplate` enumerates segments incl. `no-backing-index:vin`; skips empty remainder.

End-to-end (`53-reserved-tags.sqllogic`, via `declare logical schema ... with tags` + `apply schema`):
- Unknown key on a logical table → `apply` errors (`-- error: unknown reserved tag`).
- Mis-sited `quereus.update.policy` on a logical table → `apply` errors (`-- error: not allowed`).
- Empty `quereus.lens.ack.<code>` rationale → **deploy succeeds** (warning), reads return rows.
- Valid `quereus.lens.ack.no-backing-index:vin` on a table AND on a `unique` constraint → deploy succeeds.
- Free-form `display_name` tag on a logical table → untouched, deploy succeeds.

## Known gaps / decisions to scrutinize (reviewer: these are starting points)

1. **Unreconciled with `schema-differ.ts`'s `warnUnknownQuereusKeys`** (deliberately untouched).
   There are now TWO notions of "known `quereus.*` keys": the differ's tiny set
   (`quereus.id`, `quereus.previous_name`) that only *soft-warns* on unknown keys in the
   **physical declarative-schema differ** path, and this registry's 7-key set wired only into
   the **lens-compile** path. They don't conflict (disjoint key sets + disjoint paths), but: the
   differ would soft-warn (not error) on a `quereus.update.*` key in a physical declared schema,
   and the registry doesn't recognize `quereus.id`/`previous_name`. Decide whether to reconcile
   (register id/previous_name as specs with an `apply-schema` site, or have the differ defer to
   the registry). Left out of scope as the PoC is lens-only.

2. **`quereus.update.*` is validated by the entry point but wired into NO DML/view path.** The
   sqllogic cannot exercise update-tag error/enum cases end-to-end (those keys aren't legal at
   logical sites), so they're only covered against the pure function. `view-mutation-plan-node-substrate`
   Phase 2 must call `validateReservedTags(..., 'view-ddl' | 'dml-stmt' | 'union-branch' | 'join')`
   at the real sites and read via `getReservedTag`/`getReservedTagByTemplate`.

3. **Warnings are only `log(...)` (DEBUG-gated), so effectively silent in normal runs.** No
   deploy-summary channel yet (`docs/lens.md:169`; `3-lens-prover` Phase C owns it). The
   sqllogic asserts the deploy *succeeds* for the empty-rationale case but CANNOT assert the
   warning was *emitted* — there is no observable channel. Stronger coverage needs that channel.

4. **Rationale severity is lenient by choice.** ALL `required-nonempty-rationale` failures
   (empty / whitespace / missing / even non-text like a number) are **warnings**, not just
   empty/missing, so an ack never hard-blocks a deploy (doc intent: "acknowledgment suppresses
   the warning only; never blocks"). A reviewer may prefer a non-text rationale to be a hard
   error — flagging the divergence from a strict reading of the ticket's severity rule.

5. **`csv-of-identifiers` token grammar is a heuristic** (`/^[A-Za-z_][A-Za-z0-9_$.]*$/`,
   dotted to admit `schema.table`). Quoted identifiers with spaces would be rejected. Not
   exercised by any wired path yet; refine when view-mutation consumes it.

6. **Accessors trust the caller validated first** and cast. `getReservedTagByTemplate` coerces a
   non-string value via `String(value)`. A consumer that skips `validateReservedTags` gets
   silent coercion. Ensure consumers validate first.

7. **PoC errors carry no line/column** (consistent with the existing `throw new QuereusError`
   lens-compile errors; the tag AST has no per-key loc). Sited line numbers would need parser
   plumbing.

## Out of scope (unchanged; owned elsewhere)

- Semantics of any reserved tag (propagation, `default_for` expressions, ack fingerprinting,
  escalation policy) — owning tickets.
- `quereus.update.*` DML/view wiring — `view-mutation-plan-node-substrate` Phase 2.
- Deploy-summary warning channel — `3-lens-prover` Phase C.
- `complete/3-metadata-tags`, `complete/expose-tags-through-introspection` — untouched.

## Downstream consumers (documentation only)

- `3-lens-prover-and-constraint-attachment` Phase C: consumes `validateReservedTags` +
  `getReservedTagByTemplate` for its reserved-tag parser + escalation policy. Add this slug as
  its prereq when both are scheduled (seq 1 ≤ seq 3).
- `view-mutation-plan-node-substrate` Phase 2: validates/reads `quereus.update.*` through this registry.
