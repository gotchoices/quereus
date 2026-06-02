description: Make the typed reserved-tag registry (`schema/reserved-tags.ts`) the single source of truth for `quereus.*` keys on BOTH the lens-compile path and the physical declarative-schema differ. Retire `schema-differ.ts`'s separate 2-key/soft-warn allow-list (`KNOWN_QUEREUS_KEYS` + `warnUnknownQuereusKeys`): the differ now validates declared table/column/view/index/constraint tags through `validateReservedTags` at new physical `TagSite`s and raises an unknown/mis-sited/malformed reserved key as a hard `QuereusError` (same caller policy as `validateLensTags`). Adds `quereus.id` / `quereus.previous_name` as first-class specs so the rename hints stay legal, and unifies severity (hard-error-on-unknown) across both paths.
prereq:
files: packages/quereus/src/schema/reserved-tags.ts (TagSite union ~line 40, RESERVED_TAG_SPECS ~line 126, siteLabel ~line 554, unknownReservedTag suggestion ~line 521), packages/quereus/src/schema/schema-differ.ts (KNOWN_QUEREUS_KEYS line 17, warnUnknownQuereusKeys ~line 503, the declared-item loop lines 144-172, readQuereusHint ~line 487), packages/quereus/src/schema/lens-compiler.ts (validateLensTags ~line 548 — the existing raise-first-error/log-warnings pattern to share), packages/quereus/src/schema/mapping-advertisement-tags.ts (buildAdvertisementsFromTags — third copy of the same raise pattern), packages/quereus/src/planner/mutation/mutation-tags.ts (raiseTagDiagnostics — fourth copy), packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic (rename hints that MUST keep passing), docs/schema.md (rename-hint keys), docs/view-updateability.md + docs/lens.md (registry-as-single-source-of-truth note)
----

## Problem (recap)

Two disjoint notions of "known `quereus.*` keys" exist on two non-overlapping apply paths:

| | Typed registry (`reserved-tags.ts`) | differ (`warnUnknownQuereusKeys`) |
|---|---|---|
| Keys | `quereus.update.*`, `quereus.lens.*` (incl. `lens.decomp.*`) | `quereus.id`, `quereus.previous_name` only |
| Unknown key | hard **error** (sited diagnostic) | soft **warning** (`warnLog`, DEBUG-gated → silent) |
| Path | lens-compile (logical schema) + mutation (`view-ddl`/`dml-stmt`) + advertisement (`physical-table`) | physical declarative-schema differ (`computeSchemaDiff`) |

`quereus.update.*` **already has Effect** at the `view-ddl`/`dml-stmt` sites (shipped in
`3.4-view-mutation-tag-override-surface`, consumed at mutation time via `collectMutationTags`). But
the physical *declarative-schema* differ — the `apply schema X` / `diff schema X` path for a
**physical** schema — still routes every declared item's tags through `warnUnknownQuereusKeys`,
which only knows the two rename hints and **soft-warns** on everything else. So a typo on a physical
declared object (`quereus.update.taget`, `quereus.lens.ack.foo` mis-sited, `quereus.previuos_name`)
is silently swallowed there, while the same typo on a logical schema hard-errors. Same namespace,
two behaviors, depending on schema kind — the exact silent-no-op class the registry was built to kill.

A bonus payoff: validating a physical declared **view**'s tags at differ time also closes
known-gap #3 of `3.4-view-mutation-tag-override-surface` ("view tags validated at mutation time, not
at CREATE VIEW") for the declarative path — a malformed reserved tag on a declared view now fails at
`apply`/`diff` instead of silently waiting to error on the first mutation.

## Settled design decisions

These were the open questions in the plan; all are decided here (rationale inline) so implement can
proceed without a human gate.

### 1. `quereus.id` / `quereus.previous_name` become first-class `ReservedTagSpec`s — **required**

Once the differ validates through the registry with hard-error-on-unknown, these two legitimate
rename hints would themselves flag as `unknown-reserved-tag` unless the registry knows them. They
are genuine reserved keys with defined semantics, so they become first-class specs (not a
"differ-local concern the registry delegates" — that would re-introduce a second allow-list, the
very thing we are removing).

- **valueSchema: `'string'` for both** (NOT `csv-of-identifiers`). The differ never value-validated
  these before, and tightening risks false errors:
  - `quereus.id = 'tbl-thing'` (real value in `50.2-declare-schema-renames.sqllogic:44`) contains a
    hyphen; `csv-of-identifiers`' `IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$.]*$/` rejects `-`, so it
    would wrongly fail an existing passing test.
  - `previous_name` may name a quoted identifier with unusual characters.
  `'string'` matches the registry's `isText` check (the differ's `readQuereusHint` already ignores
  non-string values), so behavior for the rename loop is unchanged. A future ticket may tighten to a
  dedicated `csv-of-names` schema; out of scope here.
- **sites:** the physical declarative positions — `physical-table`, `physical-column`, `view-ddl`,
  `physical-index`, `physical-constraint` (see Decision 3). The differ does NOT support
  materialized-view or assertion renames, but allowing the hint at `view-ddl` (shared by views +
  MVs) is harmless over-permissiveness (the differ simply ignores an MV `quereus.id`); document it,
  don't add a separate MV site.

### 2. Severity is unified: hard-error-on-unknown on BOTH paths — **no deliberate divergence**

The soft-warn-on-unknown posture in the differ is **retired**. The forward-compat argument ("older
parser tolerates newer keys") does not hold here: the registry is the single source of truth, AGENTS.md
says "Don't worry about backwards compatibility yet," and a silent no-op on a reserved-namespace typo
is precisely the failure mode the registry exists to eliminate. The differ adopts the identical
caller policy already used by `validateLensTags` / `buildAdvertisementsFromTags`:

> collect diagnostics → first `severity:'error'` ⇒ throw `QuereusError`; `severity:'warning'`
> (e.g. empty `quereus.lens.ack` rationale) ⇒ `log`, never block.

The registry itself stays policy-free (returns diagnostics with severities; never throws). The
*per-diagnostic* severity already differs by reason (unknown/mis-sited/bad-value = error; empty ack
rationale = warning) — that is intrinsic to the diagnostic, identical on every path, and is NOT a
path divergence. Document in the differ that this is a deliberate, unified policy.

### 3. New `TagSite`s for physical declarative-schema positions

The differ inspects five tag-bearing declared positions (assertions carry no `tags` field, confirmed
in `ast.ts` — `CreateAssertionStmt` has none, so no site needed):

| Declared item (differ loop, lines 144-172) | AST tags field | TagSite |
|---|---|---|
| physical table | `tableStmt.tags` | **`physical-table`** (reuse) |
| column | `col.tags` | **`physical-column`** (NEW) |
| view / materialized view | `viewStmt.tags` | **`view-ddl`** (reuse) |
| index | `indexStmt.tags` | **`physical-index`** (NEW) |
| named table constraint | `c.tags` (named only) | **`physical-constraint`** (NEW) |

Reuse rationale:
- **`physical-table`** already exists for basis-table `quereus.lens.decomp.*`. A physical declared
  table *is* a basis table, so decomp tags declared in a physical schema's DDL should validate fine
  there — reuse is correct, not a hack. Update its doc comment to note it covers both the
  basis-table (advertisement) and physical declarative-schema (differ) table positions, and add the
  two rename-hint specs to its site list.
- **`view-ddl`** already covers `CREATE VIEW / CREATE MATERIALIZED VIEW WITH TAGS` and is where
  `quereus.update.*` is legal. A declared physical view is exactly that position, so validating it
  at `view-ddl` keeps a physical declared view's `quereus.update.policy` validated identically
  whether reached via the differ or via mutation-time `collectMutationTags`. Add the rename hints to
  `view-ddl`'s site list.

Add three new sites: `physical-column`, `physical-index`, `physical-constraint`. Give each a
`siteLabel` case ("a physical column" / "a physical index" / "a physical constraint"). These also
fill the column-validation gap noted in the completed registry ticket's review (no `column` site
existed); a reserved key mis-placed on a physical column is now `tag-not-allowed-here` rather than
silently escaping.

Net behavior after wiring:
- `quereus.update.taget` (typo) on any physical declared object ⇒ `unknown-reserved-tag` **error**.
- `quereus.update.target` on a physical **table** ⇒ `tag-not-allowed-here` (update.* sites are
  view-ddl/union-branch/join/dml-stmt), but on a physical **view** ⇒ valid.
- `quereus.lens.decomp.*` on a physical table ⇒ valid (already its site).
- `quereus.id` / `quereus.previous_name` on table/column/view/index/constraint ⇒ valid; rename
  detection unchanged.

## DRY: consolidate the raise pattern (recommended, not blocking)

"collect diagnostics → throw first error / log warnings" is currently copied **four** times
(`lens-compiler.validateLensTags`, `mapping-advertisement-tags.buildAdvertisementsFromTags`,
`mutation-tags.raiseTagDiagnostics`, and now the differ would be a fifth). Add ONE shared helper and
route all callers through it. The registry stays policy-free, so the helper is a clearly-named,
opt-in convenience — put it in `reserved-tags.ts` (or a sibling `reserved-tags-policy.ts`):

```ts
/** Throw the first error diagnostic (optionally prefixed/sited); log the rest as warnings. */
export function raiseReservedTagDiagnostics(
	diagnostics: readonly TagDiagnostic[],
	opts?: { messagePrefix?: string; loc?: { line?: number; column?: number }; log?: (d: TagDiagnostic) => void },
): void
```

`mutation-tags.ts` needs the sited `loc` + view-context prefix; the lens/advertisement/differ
callers pass neither. Keep each caller's existing log channel via the `log` callback. If threading
all four through one signature proves awkward, it is acceptable to ship the differ wiring with its
own small raise (matching `validateLensTags`) and leave the 4-way consolidation as a follow-up
backlog note — but prefer the shared helper.

## Key tests (TDD targets)

**Unit — `test/schema/reserved-tags.spec.ts`** (extend the 31 existing cases):
- `quereus.id` / `quereus.previous_name` are valid (zero diagnostics) at each of `physical-table`,
  `physical-column`, `view-ddl`, `physical-index`, `physical-constraint`. Include the hyphenated
  `quereus.id = 'tbl-thing'` value — must NOT error (guards the `'string'` decision).
- A typo'd key (`quereus.previuos_name`, `quereus.update.taget`) at a physical site ⇒ single
  `unknown-reserved-tag` / `error`.
- `quereus.update.target` at `physical-table` ⇒ `tag-not-allowed-here`; at `view-ddl` ⇒ valid.
- `quereus.lens.decomp.role.d1` still valid at `physical-table` (no regression).
- A reserved key on `physical-column` that isn't column-legal ⇒ `tag-not-allowed-here`.

**Unit — `test/schema-differ.spec.ts`** (new `computeSchemaDiff` cases; build minimal
`DeclareSchemaStmt` + `SchemaCatalog` fixtures, or drive via `parse(...)`):
- Physical declared table with `quereus.update.taget` ⇒ `computeSchemaDiff` throws `QuereusError`
  (headline regression-closer; previously silent).
- Physical declared schema with valid `quereus.previous_name` ⇒ does NOT throw and still produces
  the expected `renames` op (parity with current rename behavior).
- `quereus.update.policy = 'strict'` on a declared view ⇒ does NOT throw (legal at `view-ddl`).

**Integration — sqllogic:**
- `50.2-declare-schema-renames.sqllogic` and any other rename test MUST keep passing unchanged
  (proves the rename hints stay legal end-to-end).
- Add a case (extend `50.2` or a new `5x-*.sqllogic`): `declare schema` (physical) carrying a
  typo'd `quereus.*` key, then `apply schema` ⇒ error. Use the `error:` directive form (see
  sibling sqllogic error tests for the directive syntax).

## TODO

### Phase 1 — registry: specs + sites
- Add `physical-column`, `physical-index`, `physical-constraint` to the `TagSite` union; add a
  `siteLabel` case for each.
- Update the `physical-table` doc comment to note it now also covers physical declarative-schema
  tables (differ), not just advertisement basis tables.
- Add `ReservedTagSpec`s for `quereus.id` and `quereus.previous_name`: `valueSchema: 'string'`,
  sites = `physical-table`, `physical-column`, `view-ddl`, `physical-index`, `physical-constraint`.
  Add a doc comment + (optional) doc citation to `docs/schema.md`.
- Refresh the `unknownReservedTag` `suggestion` string (~line 521) to list the two new hint keys.

### Phase 2 — differ wiring
- Delete `KNOWN_QUEREUS_KEYS` (line 17) and `warnUnknownQuereusKeys` (~line 503). Keep
  `readQuereusHint` (it still reads the now-validated values).
- In the declared-item loop (lines 144-172), replace each `warnUnknownQuereusKeys(...)` call with
  `validateReservedTags(tags, <site>)` accumulation, then raise via the shared helper (Decision 2
  policy). Sites per the table in Decision 3.
- Decide collection granularity: validate per-item and raise on the first error is fine (matches
  the differ's existing fail-fast throws for rename conflicts), or accumulate across the whole
  schema then raise — pick the simpler; document the choice. Validation must run BEFORE any throw-y
  rename resolution so a tag typo surfaces deterministically.
- Confirm `diff schema` (read-only preview via `emitDiffSchema`) now also surfaces the error — this
  is intended (a malformed tag should fail the preview too).

### Phase 3 — DRY (recommended)
- Add `raiseReservedTagDiagnostics` (see above) and route `validateLensTags`,
  `buildAdvertisementsFromTags`, `mutation-tags.raiseTagDiagnostics`, and the new differ call
  through it. If too awkward to unify in one pass, ship the differ with a local raise and file a
  small backlog note for the 4-way consolidation.

### Phase 4 — tests + docs + validation
- Add the unit + differ + sqllogic tests above.
- Grep the test corpus / sqllogic for any physical-schema use of an `quereus.*` key that currently
  expects success-with-soft-warn and would now hard-error; if found and legitimate, fix the key or
  add the spec — do NOT silently weaken the policy. (Initial sweep found none beyond the valid
  rename hints.)
- Docs: `docs/schema.md` (rename-hint keys are registry-governed); `docs/view-updateability.md` +
  `docs/lens.md` (note the registry is the single shape/site source of truth for the physical
  declarative path too, hard-error-on-unknown).
- Validate (stream output, never silent-redirect):
  - `yarn workspace @quereus/quereus run build`
  - `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows)
  - `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/recon.log; tail -n 80 /tmp/recon.log`
- Hand off to review honest about: the `'string'` vs `csv-of-names` value-schema deferral; whether
  the 4-way DRY consolidation shipped or was deferred; and the MV/assertion over-permissiveness note.
