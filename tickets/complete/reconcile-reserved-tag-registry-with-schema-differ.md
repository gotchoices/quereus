description: Reconciled the typed reserved-tag registry (`schema/reserved-tags.ts`) with the physical declarative-schema differ. The differ's separate 2-key/soft-warn allow-list (`KNOWN_QUEREUS_KEYS` + `warnUnknownQuereusKeys`) is retired; the differ now validates every declared table/column/view/index/constraint tag through `validateReservedTags` at new physical `TagSite`s and hard-errors on unknown/mis-sited/malformed reserved keys (same caller policy as `validateLensTags`). `quereus.id` / `quereus.previous_name` are first-class registry specs. A shared `raiseReservedTagDiagnostics` helper backs all four raise sites (DRY consolidation). Reviewed: closed an unnamed-table-constraint validation hole inline and added precedence + hole regression tests.
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/reserved-tags-policy.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic, docs/schema.md, docs/view-updateability.md, docs/lens.md
----

## Summary

The physical declarative differ and the typed reserved-tag registry are now one
system: one namespace, one notion of "known `quereus.*` key", one severity
(hard-error-on-unknown) on every apply path. The implementation shipped as
described in the handoff — registry extended with three physical `TagSite`s plus
`quereus.id` / `quereus.previous_name` specs, the differ's soft-warn allow-list
deleted, and the four-way DRY consolidation through `raiseReservedTagDiagnostics`
landed. The review found the core design sound and the consolidation clean, but
caught one real escape hole (below) and closed it.

## Review findings

### What was checked
- **Implement diff read first, fresh** (`git show d09285b2`) across all 14 files
  before reading the handoff.
- **Registry/site model** — new sites (`physical-column/index/constraint`),
  `quereus.id` / `quereus.previous_name` specs, `siteLabel`, `unknownReservedTag`
  suggestion string. Verified site overload (`physical-table` doubling as the
  basis-table advertisement position) does not regress `buildAdvertisementsFromTags`:
  it pre-filters to the `quereus.lens.decomp.*` subset (`decompSubset`) before
  validating, so the two new id/previous_name specs never reach it.
- **DRY consolidation** — all four callers (`validateLensTags`,
  `buildAdvertisementsFromTags`, `raiseTagDiagnostics`, the differ) route through
  the one helper; confirmed no behavioral drift (message prefix, sited loc, warn
  sink all preserved). No dangling references to the deleted
  `KNOWN_QUEREUS_KEYS` / `warnUnknownQuereusKeys` (grep clean). No unused
  `QuereusError`/`StatusCode` imports left behind.
- **Precedence claim** — confirmed tag validation (`raiseReservedTagDiagnostics`
  at the top of `computeSchemaDiff`) runs *before* the throw-y `resolveRenames`,
  so a tag typo wins over a rename conflict deterministically.
- **Cross-path impact** — adding id/previous_name at `view-ddl` makes them
  validate (and be ignored) on the mutation path; harmless over-permissiveness,
  consistent with the documented MV/assertion gaps.
- **Type safety / resource cleanup / error handling** — helper signature
  (`readonly TagDiagnostic[]`, optional `loc`/`log`) is sound; undefined
  line/column thread through `QuereusError` fine; registry stays throw-free.
- **Lint + full test suite** — both clean before and after the review edits.

### Major findings
**One, fixed inline (small + contained, so not spun out):** the differ gated
constraint-tag validation on `if (c.name)` (per the plan's Decision-3 table,
"named only"). But a **table-level** constraint consumes its trailing
`WITH TAGS` *unconditionally* (`parser.ts:4034`; only *unnamed inline column*
constraints defer their tags to the column). So an unnamed table constraint —
e.g. `unique (a, b) with tags ("quereus.update.taget" = 'x')` — could carry a
reserved tag whose typo was a **silent no-op**, the exact escape Decision 2 ("no
surviving soft-warn path for an unknown physical `quereus.*` key") exists to
eliminate. This was an internal contradiction in the plan (Decision 2 vs the
Decision-3 "named only" assumption), inherited by the implementation. Fixed by
validating *every* table constraint (`validateReservedTags` no-ops on
undefined/non-`quereus.*` tags, so unnamed tagless constraints cost nothing);
rename detection still keys off named constraints only, so behavior there is
unchanged. Comment block + `docs/schema.md` updated to match.

### Minor findings (fixed inline)
- Added two `schema-differ.spec.ts` regression tests the handoff explicitly
  flagged as missing: (1) the unnamed-table-constraint typo now throws (locks the
  fix above); (2) a tag typo surfaces **before** a rename conflict (locks the
  precedence/determinism guarantee).

### Accepted as-is (reviewed, not bugs)
- **`'string'` vs a `csv-of-names` value-schema** for the rename hints —
  deliberate (a real id carries a hyphen; `previous_name` may name quoted
  identifiers). The values are not structurally validated as name lists. A
  future `csv-of-names` schema could tighten this; out of scope.
- **MV / assertion over-permissiveness** — an MV's `quereus.id` validates at
  `view-ddl` but is ignored (no MV rename); assertions carry no `tags` field so
  have no site. Both are intentional over-permissiveness, documented.
- **`mapping-advertisement-tags` passes no `log` sink** to the helper — its tag
  set is pre-filtered to `quereus.lens.decomp.*`, which can only ever produce
  error-severity diagnostics (no ack/warning keys reach it), so dropping the warn
  branch there is correct, not a leak.
- **No dedicated `diff schema`-with-typo sqllogic case** — the read-only preview
  shares `computeSchemaDiff` with `apply` (covered by both the differ unit tests,
  which call `computeSchemaDiff` directly, and the new section-9 `apply schema`
  sqllogic case). Adding a separate `diff schema` sqllogic line is low-value
  given that shared entry point; not added.

## Validation performed
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — **4329 passing, 9 pending, 0 failing**
  (was 4327 pre-review; +2 new regression tests).

## Behavior (final)
- `quereus.update.taget` (typo) on any physical declared object — table, column,
  view, index, **named or unnamed table constraint** — ⇒ `unknown-reserved-tag`
  **error** at `apply`/`diff schema`.
- `quereus.update.target` on a physical table ⇒ `tag-not-allowed-here`; on a
  physical view ⇒ valid.
- `quereus.lens.decomp.*` on a physical table ⇒ valid (its site).
- `quereus.id` / `quereus.previous_name` on table/column/view/index/constraint ⇒
  valid; rename detection unchanged.
- A schema with both a tag typo and a rename conflict ⇒ the tag error surfaces
  first (deterministic).

## End
