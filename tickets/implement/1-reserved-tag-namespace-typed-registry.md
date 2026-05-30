description: A typed, validated registry for the reserved `quereus.*` tag namespace, installed BEFORE the two tickets that first parse these tags (lens-prover acknowledgment tags; the Phase-2 view-mutation `quereus.update.*` override surface). Today the namespace is fully designed in docs but consumed at ZERO code sites and stored as untyped `Record<string, SqlValue>`; the registry makes an unknown / mis-sited / malformed reserved key FAIL LOUDLY with a sited diagnostic instead of silently no-opping. This implement pass ships the module, the single validation entry point, the typed accessor, and a proof-of-concept wiring into the lens-compile path (the `quereus.lens.ack` rationale case) — but NO reserved tag's semantics.
prereq:
files: packages/quereus/src/schema/reserved-tags.ts (new), packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts (pattern to mirror), packages/quereus/src/common/errors.ts, packages/quereus/src/common/types.ts, docs/view-updateability.md, docs/lens.md, packages/quereus/test/logic/ (new .sqllogic for the lens-ack case)
----

## Why this exists

The reserved tag keys are a precise, growing mini-language designed across the docs —
`quereus.update.{target, exclude, default_for.<column>, delete_via, policy}`
(`docs/view-updateability.md` § Tag-Controlled Propagation, table at lines 272–278),
`quereus.lens.ack.<code>[:<target>]` and `quereus.lens.access.<col>`
(`docs/lens.md` § Acknowledging advisories, lines 171–195). Both docs **already name this
ticket's slug** as the owner of shape/site validation (`view-updateability.md:269-270`,
`lens.md:176`).

Today they are consumed at NO code site: a search for every dotted key returns nothing
under `packages/*/src`. Tags are stored as untyped `Record<string, SqlValue>` at every
AST/schema site (`parser/ast.ts` CreateTable/View/MaterializedView/Index/ColumnDef/
TableConstraint, `schema/table.ts` TableSchema + the three constraint schemas) and any
`quereus.*` key is silently ignored. A typo like `quereus.update.taget` or
`quereus.lens.akc` would silently no-op in production with no diagnostic.

The first consumer is imminent — `3-lens-prover-and-constraint-attachment` Phase C plans a
hand-rolled "reserved tag parser + validation (rationale required)" and an
escalation-policy parser; the Phase-2 view-mutation tag override surface
(`view-mutation-plan-node-substrate`) is the second. Without a shared registry these two
tickets each independently parse the namespace at scattered sites — the exact untyped,
typo-prone mini-language to avoid. This ticket installs the guard rail as **additive,
behavior-neutral** infrastructure: it changes NOTHING for already-shipped free-form user
tags, reads no reserved tag's *semantics*, and only validates shape + site, handing the two
downstream tickets a typed surface to consume.

## Architecture

### Diagnostic shape — mirror the existing mutation-diagnostic pattern

`packages/quereus/src/planner/mutation/mutation-diagnostic.ts` is the prior art to copy:
`MutationDiagnostic` = `{ reason, message, column?, table?, suggestion? }` plus a
`ViewMutationError extends QuereusError` raiser. Model `TagDiagnostic` the same way, but
add a `severity` field (the docs distinguish hard-error keys from warning keys — see below):

```ts
export type TagDiagnosticReason =
	| 'unknown-reserved-tag'   // key in the quereus.* namespace with no matching spec
	| 'tag-not-allowed-here'   // valid spec, but not legal at this site
	| 'invalid-tag-value';     // value fails its TagValueSchema (e.g. empty ack rationale)

export interface TagDiagnostic {
	readonly reason: TagDiagnosticReason;
	readonly severity: 'error' | 'warning';
	readonly key: string;           // the offending reserved key, verbatim
	readonly site: TagSite;         // where it was found
	readonly message: string;       // human-facing, sited
	readonly suggestion?: string;   // copy-pasteable remediation when one applies
}
```

Severity policy from the docs: `unknown-reserved-tag` and `tag-not-allowed-here` are
`'error'` (a typo or mis-site must fail loudly). `invalid-tag-value` for an **empty/missing
`quereus.lens.ack` rationale** is `'warning'` (`docs/lens.md:176`: "an empty or missing
rationale is itself a warning"). Other `invalid-tag-value` cases (e.g. an enum miss on
`policy`/`delete_via`) are `'error'`. `validateReservedTags` is **policy-free** — it returns
diagnostics with severity attached; the *caller* decides whether a warning blocks (the lens
PoC logs warnings, escalation policy in `3-lens-prover` may promote them).

### The registry module — `packages/quereus/src/schema/reserved-tags.ts`

```ts
export type TagSite =
	| 'view-ddl'            // CREATE VIEW / CREATE MATERIALIZED VIEW WITH TAGS
	| 'projection'          // a result-column tag (future; reserved for default_for)
	| 'join'                // a JOIN-clause tag
	| 'union-branch'        // a compound-set branch tag
	| 'dml-stmt'            // INSERT/UPDATE/DELETE ... WITH (...) statement-level tag
	| 'logical-table'       // tags on a declared logical TableSchema
	| 'logical-constraint'; // tags on a logical RowConstraint/Unique/ForeignKey schema

export type TagValueSchema =
	| 'string'
	| 'csv-of-identifiers'                 // comma-separated base-table/branch names
	| { enum: readonly string[] }          // closed value set, e.g. policy/delete_via
	| 'required-nonempty-rationale'        // non-empty TEXT; empty => warning
	| 'expression';                        // a SQL expression string (default_for.<col>)

export interface ReservedTagSpec {
	/** Either an exact key, or a template with one `<segment>` placeholder. */
	readonly key: string | { readonly template: string };
	readonly sites: ReadonlySet<TagSite>;
	readonly valueSchema: TagValueSchema;
	readonly description: string;
}

export const RESERVED_TAGS: readonly ReservedTagSpec[];

export function validateReservedTags(
	tags: Record<string, SqlValue> | undefined,
	site: TagSite,
): TagDiagnostic[];

export function getReservedTag<K extends string>(
	tags: Record<string, SqlValue> | undefined,
	key: K,
): TypedValueFor<K> | undefined;
```

**`RESERVED_TAGS` seeds** — frozen, transcribed directly from the doc tables (cite the doc
in a comment beside each entry):

| Spec key | sites | valueSchema | source |
|---|---|---|---|
| `quereus.update.target` | view-ddl, union-branch, join, dml-stmt | `csv-of-identifiers` | view-updateability.md:274 |
| `quereus.update.exclude` | view-ddl, union-branch, join, dml-stmt | `csv-of-identifiers` | view-updateability.md:275 |
| `{template:'quereus.update.default_for.<column>'}` | view-ddl, projection | `expression` | view-updateability.md:276 |
| `quereus.update.delete_via` | union-branch (`except`), join | `{enum:['left_delete','right_insert','parent']}` | view-updateability.md:277, 165, 220 |
| `quereus.update.policy` | view-ddl | `{enum:['strict','lenient']}` | view-updateability.md:278 |
| `{template:'quereus.lens.ack.<code>'}` | logical-table, logical-constraint | `required-nonempty-rationale` | lens.md:176, 190 |
| `{template:'quereus.lens.access.<col>'}` | logical-table | `string` | lens.md:166, 176 |

**Template matching nuance — the ack `:target` suffix.** The live doc example is
`"quereus.lens.ack.no-backing-index:vin"` (`lens.md:190`): the segment after
`quereus.lens.ack.` is `<code>[:<target>]` — a code optionally refined by a `:target`. The
`<column>` template on `default_for` is a single segment. Model the template matcher to
capture **the entire remainder** after the literal prefix as the placeholder value (so
`no-backing-index:vin` and `created` both match their templates); do NOT try to sub-parse
the `:target` here — that is the prover's job. A template whose remainder is empty
(`quereus.update.default_for.` with no column) is itself an `unknown-reserved-tag` /
`invalid-tag-value` error.

**`validateReservedTags` algorithm.** For each key in `tags`:
- Not in the `quereus.` namespace → skip (free-form user tag, untouched).
- In namespace, no spec matches the key (exact or template) → `unknown-reserved-tag` (error).
- Spec matches but `site` ∉ `spec.sites` → `tag-not-allowed-here` (error).
- Spec matches, site OK, value fails `valueSchema` → `invalid-tag-value` (severity per the
  rule above: empty `required-nonempty-rationale` → warning; all other value failures → error).

**`getReservedTag` typed accessor.** A typed read so downstream consumers read e.g.
`delete_via` as the `'left_delete' | 'right_insert' | 'parent'` union, never a re-parsed bare
`SqlValue`. Implement `TypedValueFor<K>` as a conditional/mapped type keyed off the literal
key (enum specs → their union; `csv-of-identifiers` → `string`; `expression`/`string` →
`string`). For templated keys, expose a companion `getReservedTagByTemplate(tags, template)`
returning `Array<{ segment: string; value: TypedValueFor }>` so a consumer can enumerate all
`default_for.<column>` / `lens.ack.<code>` instances. Keep the accessor read-only; it does no
validation (callers run `validateReservedTags` first).

### PoC wiring — the lens-compile path

Wire ONLY the `quereus.lens.ack` rationale case (the nearest live consumer) into
`deployLogicalSchema` (`schema/lens-compiler.ts:40`). After each `logicalTable` is built
(line 85) and its `attachedConstraints` collected (line 111), call `validateReservedTags`:
- on `logicalTable.tags` with site `'logical-table'`,
- on each constraint's `.tags` (the constraint schemas carry `tags?` — `table.ts:387/423/492`)
  with site `'logical-constraint'`.

Collect the diagnostics. `severity:'error'` diagnostics throw a `QuereusError`
(`common/errors.js`, `StatusCode.ERROR`) with the sited message — consistent with the
existing `throw new QuereusError(...)` lens-compile errors. `severity:'warning'` diagnostics
are logged via the existing `log` channel (`createLogger('schema:lens-compiler')`,
lens-compiler.ts:13) for now — the deploy-summary warning channel (`docs/lens.md:169`) does
not exist yet and is `3-lens-prover` Phase C's to build. Validation happens **inside the
compile-first loop** (before catalog mutation, lens-compiler.ts:80-128) so an invalid tag
fails the deploy atomically, leaving existing lens state untouched.

The PoC implements NO tag semantics — it only validates shape/site and surfaces a sited
diagnostic. `quereus.update.*` validation is reachable through the same `validateReservedTags`
entry point but is NOT wired into any DML/view path here; that wiring is
`view-mutation-plan-node-substrate` Phase 2's.

### Why this path, not the alternatives

- **Do nothing / parse ad hoc per ticket** — rejected: produces the scattered mini-language
  the gap warns about; silent no-op on typos in production.
- **A full grammar-backed tag DSL** — rejected as over-scope for a ~7-key namespace; a frozen
  spec table is DRY and sufficient.
- **Registry now** — additive, behavior-neutral for shipped tags, and gives `3-lens-prover`
  Phase C and the view-mutation override surface a ready `validateReservedTags` +
  `getReservedTag` to consume rather than re-implement. Defensible default, single path.

## Unblocks (downstream consumers — documentation, do not edit those tickets here)

- **`3-lens-prover-and-constraint-attachment`** Phase C: its "reserved tag parser +
  validation (rationale required)" and escalation-policy parser CONSUME this registry instead
  of hand-rolling. This slug should be added as a prereq of `3-lens-prover` when both are
  scheduled (seq 1 ≤ seq 3, invariant-clean).
- **`view-mutation-plan-node-substrate`** Phase 2: the `quereus.update.*` override surface
  validates and reads through this registry.

## Out of scope

- Implementing the SEMANTICS of any reserved tag (propagation restriction, `default_for`
  expressions, ack fingerprinting, escalation policy) — those stay in their owning tickets.
- Wiring `quereus.update.*` validation into any DML/view path (that is
  `view-mutation-plan-node-substrate` Phase 2). The entry point ships; the call sites do not.
- A deploy-summary warning channel (`docs/lens.md:169`) — `3-lens-prover` Phase C owns it;
  the PoC logs warnings via the existing logger.
- Re-touching `complete/3-metadata-tags` (WITH TAGS syntax / hashing / round-trip) or
  `complete/expose-tags-through-introspection` (the `tags` introspection columns).

## TODO

### Phase 1 — registry module
- Create `packages/quereus/src/schema/reserved-tags.ts` with `TagSite`, `TagValueSchema`,
  `ReservedTagSpec`, `TagDiagnostic`/`TagDiagnosticReason`, and the frozen `RESERVED_TAGS`
  table seeded per the table above (cite the doc line beside each entry).
- Implement key matching: exact-key specs and single-placeholder template specs (remainder
  captured whole, including any `:target`). Reject empty remainders.
- Implement `validateReservedTags(tags, site)` per the algorithm above (namespace gate →
  unknown → wrong-site → value-schema, with the severity rule). Non-`quereus.*` keys pass
  through untouched.
- Implement `getReservedTag` (typed, by exact key) and `getReservedTagByTemplate` (enumerate
  templated instances). Define `TypedValueFor<K>` off the literal key. No `any`.

### Phase 2 — value-schema validators
- `string` / `expression`: value must be a non-null TEXT `SqlValue` (expression validity is
  NOT checked — deferred to the consuming ticket).
- `csv-of-identifiers`: non-empty TEXT, comma-split, each trimmed segment a non-empty
  identifier-shaped token.
- `{enum}`: value ∈ the enum (case-sensitive per the doc's lowercase literals).
- `required-nonempty-rationale`: TEXT; empty/whitespace/missing → `invalid-tag-value`
  **warning**; non-empty → ok.

### Phase 3 — lens-compile PoC wiring
- In `deployLogicalSchema` (lens-compiler.ts), validate `logicalTable.tags` (`logical-table`)
  and each constraint's `.tags` (`logical-constraint`) inside the compile-first loop.
- Errors → `throw new QuereusError(diag.message, StatusCode.ERROR)`; warnings → `log(...)`.

### Phase 4 — docs
- Fill in the two doc anchors that already name this slug: `docs/view-updateability.md`
  (§ Tag-Controlled Propagation, the "shape and site validation ... is specified under
  reserved-tag-namespace-typed-registry" sentence at 269-270) and `docs/lens.md` (§
  Acknowledging advisories, the sentence at 176) — point them at `schema/reserved-tags.ts`
  and summarize the `TagSite` / `TagValueSchema` / diagnostic-reason surface and the
  error-vs-warning severity split. Keep it tight; do not duplicate the spec table.

### Phase 5 — tests
Add a `.sqllogic` (and/or a unit test for the pure registry) covering the validation seeds:
- Unknown `quereus.*` key (`quereus.update.taget`, `quereus.lens.akc.x`) → `unknown-reserved-tag`
  error at the declaring site.
- A `quereus.update.delete_via` at a view-DDL site (only `target`/`exclude`/`default_for`/
  `policy` are legal there) → `tag-not-allowed-here` error.
- Empty `quereus.lens.ack.<code>` rationale on a logical table/constraint → `invalid-tag-value`
  **warning** (deploy succeeds; warning logged), not an error.
- `quereus.update.policy = 'looose'` → `invalid-tag-value` error (enum miss).
- A valid reserved tag at a legal site (`quereus.lens.ack.no-backing-index:vin = 'rationale'`)
  → no diagnostic; `getReservedTagByTemplate` returns the segment/value; deploy succeeds.
- A non-`quereus.*` user tag (`display_name = 'X'`) → untouched, no diagnostic.

For the lens-ack cases, drive through `declare logical schema ... with tags (...)` + `apply
schema` so the PoC wiring is exercised end-to-end (see `lens.md:183-193` for the syntax). Use
the `-- error:` directive (logic.spec.ts) to assert the hard-error messages; assert the
warning path by confirming the deploy succeeds and the tag is readable.

### Phase 6 — build + test gate
- `yarn workspace @quereus/quereus run build` (or `yarn build`) — clean.
- `yarn test` — green (stream with `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`).
- Lint `packages/quereus` (single-quote globs on Windows).
