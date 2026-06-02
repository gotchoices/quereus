description: Review the reconciliation of the typed reserved-tag registry (`schema/reserved-tags.ts`) with the physical declarative-schema differ. The differ's separate 2-key/soft-warn allow-list (`KNOWN_QUEREUS_KEYS` + `warnUnknownQuereusKeys`) is retired; the differ now validates every declared table/column/view/index/constraint tag through `validateReservedTags` at new physical `TagSite`s and hard-errors on unknown/mis-sited/malformed reserved keys (same caller policy as `validateLensTags`). `quereus.id` / `quereus.previous_name` became first-class registry specs so rename hints stay legal. A shared `raiseReservedTagDiagnostics` helper now backs all four raise sites (DRY consolidation shipped).
prereq:
files: packages/quereus/src/schema/reserved-tags.ts, packages/quereus/src/schema/reserved-tags-policy.ts (NEW), packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts, packages/quereus/src/planner/mutation/mutation-tags.ts, packages/quereus/test/schema/reserved-tags.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic, docs/schema.md, docs/view-updateability.md, docs/lens.md
----

## What shipped

The physical declarative differ and the typed reserved-tag registry are now one
system. Same namespace, **one** notion of "known `quereus.*` key", **one**
severity (hard-error-on-unknown) on every apply path.

### Registry (`reserved-tags.ts`)
- Three new `TagSite`s: `physical-column`, `physical-index`,
  `physical-constraint` (+ `siteLabel` cases "a physical column / index /
  constraint"). `physical-table`'s doc comment now states it covers BOTH the
  basis-table/advertisement position and the physical declarative-schema table
  position; the `view-ddl` doc comment notes it also covers a physical declared
  view in the differ.
- Two new first-class specs: `quereus.id` and `quereus.previous_name`, each
  `valueSchema: 'string'`, sites = `physical-table`, `physical-column`,
  `view-ddl`, `physical-index`, `physical-constraint`.
- `unknownReservedTag` suggestion string now lists `quereus.{id, previous_name}`.
- Registry stays **policy-free** (returns diagnostics, never throws).

### Shared raise helper (`reserved-tags-policy.ts`, NEW)
- `raiseReservedTagDiagnostics(diagnostics, { messagePrefix?, loc?, log? })` —
  the single "throw first error / log warnings" caller policy. Lives in a sibling
  module (not `reserved-tags.ts`) so the registry keeps its no-throw /
  no-`QuereusError`-dependency guarantee.
- **The 4-way DRY consolidation SHIPPED** (it was "recommended, not blocking").
  All four sites route through the helper: `lens-compiler.validateLensTags`,
  `mapping-advertisement-tags.buildAdvertisementsFromTags`,
  `mutation-tags.raiseTagDiagnostics` (passes `messagePrefix` + sited `loc`), and
  the new differ call.

### Differ (`schema-differ.ts`)
- Deleted `KNOWN_QUEREUS_KEYS` and `warnUnknownQuereusKeys`. `readQuereusHint`
  kept (reads the now-validated rename-hint values).
- In the declared-item loop, each item's tags accumulate diagnostics via
  `validateReservedTags(tags, <site>)` (table→`physical-table`,
  column→`physical-column`, view/MV→`view-ddl`, index→`physical-index`, named
  constraint→`physical-constraint`). **Collection granularity:** accumulate
  across the whole schema, raise once — and that raise runs **before** the
  throw-y rename resolution, so a tag typo surfaces deterministically rather than
  being masked by a rename conflict.
- `diff schema` and `apply schema` both reach this via `computeSchemaDiff`, so a
  malformed tag now fails the read-only preview too (intended).

## Behavior change (the regression this closes)
- `quereus.update.taget` (typo) on any physical declared object ⇒
  `unknown-reserved-tag` **error** at `apply`/`diff`. Previously: silent
  DEBUG-gated soft-warn (effectively a no-op).
- `quereus.update.target` on a physical **table** ⇒ `tag-not-allowed-here`; on a
  physical **view** ⇒ valid.
- `quereus.lens.decomp.*` on a physical table ⇒ still valid (its site).
- `quereus.id` / `quereus.previous_name` on table/column/view/index/constraint ⇒
  valid; rename detection unchanged.

## Validation performed (this is the FLOOR, not the ceiling)
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus test` — **4327 passing, 9 pending, 0 failing**.
- New unit cases:
  - `test/schema/reserved-tags.spec.ts` — new `describe('rename hints + physical
    declarative sites')`: id/previous_name valid at all five physical sites
    (incl. hyphenated `'tbl-thing'`), typo'd keys ⇒ single
    `unknown-reserved-tag`/error, `update.target` table-vs-view, decomp
    no-regression, non-column-legal key on `physical-column`. Count assertion
    bumped 20→22 (+2 rename hints).
  - `test/schema-differ.spec.ts` — new `describe('reserved-tag validation')`:
    typo on declared table tag throws, typo on declared column tag throws, valid
    `previous_name` still yields the rename op (parity), hyphenated `quereus.id`
    accepted, `update.policy` on a declared view accepted.
- `test/logic/50.2-declare-schema-renames.sqllogic` — unchanged sections 1-8 all
  pass; new **section 9**: physical `declare schema` with `quereus.update.taget`
  then `apply schema` ⇒ `error: unknown reserved tag`.

## Use cases for the reviewer to probe
- **Severity unification is the whole point** — confirm there is NO surviving
  soft-warn path for an unknown physical `quereus.*` key. (Grep for `warnLog` in
  schema-differ: it is now only the helper's warning sink, which in practice
  never fires on the physical path — see gap below.)
- **Determinism**: a schema with BOTH a tag typo AND a rename conflict must
  surface the tag error first (validation precedes rename resolution). Worth a
  direct test if you want belt-and-suspenders.
- **`diff schema` preview** surfaces the error: covered only transitively (both
  paths call `computeSchemaDiff`, and the differ unit test exercises
  `computeSchemaDiff` throwing directly). No dedicated `diff schema`-with-typo
  sqllogic case was added — add one if you want explicit end-to-end coverage of
  the preview path.

## Honest gaps / deferrals (flagged, not papered over)
1. **`'string'` vs `csv-of-names` value-schema** — `quereus.id` /
   `quereus.previous_name` use `valueSchema: 'string'` (deliberate: a real id
   carries a hyphen, e.g. `'tbl-thing'`, and `csv-of-identifiers`' regex rejects
   `-`; `previous_name` may name quoted identifiers). The values are therefore
   NOT structurally validated as name lists. A future ticket may add a dedicated
   `csv-of-names` schema. Out of scope here, as the ticket settled.
2. **Named-constraint-only validation** — the differ validates tags only on
   **named** table constraints (`if (c.name)`), matching the prior behavior and
   the ticket's Decision-3 table. A reserved-tag typo on an *unnamed* physical
   constraint still escapes validation. Low-risk (the rename hints only work on
   named constraints, and `quereus.lens.ack.*` is a logical-* site), but it is a
   genuine residual gap if a reviewer wants it closed.
3. **MV / assertion over-permissiveness** — a materialized view's
   `quereus.id` validates at `view-ddl` but is silently ignored (the differ
   supports no MV rename). Assertions carry no `tags` field, so they have no site
   and are never validated. Both are documented as intentional
   over-permissiveness, not bugs.
4. **DRY consolidation: SHIPPED** (not deferred). If the reviewer dislikes the
   sibling-module placement of `raiseReservedTagDiagnostics`, that is the only
   structural call worth revisiting — the ticket explicitly allowed either
   `reserved-tags.ts` or a sibling; I chose the sibling to keep the registry
   throw-free.

## Docs updated
- `docs/schema.md` — new "Reserved-tag validation on the declarative path"
  subsection under Rename Detection.
- `docs/view-updateability.md` — site list extended with the physical sites;
  registry framed as the single shape/site source of truth across all paths;
  `raiseReservedTagDiagnostics` named.
- `docs/lens.md` — single-source-of-truth note added to the Acknowledging-advisories
  bullet (covers the physical differ + the shared policy helper).
