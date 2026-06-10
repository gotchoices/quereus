----
description: Removed the `quereus.update.default_for.<column>` reserved tag (view-DDL and statement-level sites), retiring the last behavioral reserved tag — the whole `quereus.update.*` family is now `unknown-reserved-tag` at every site. Retired the inert `'projection'` TagSite and `'expression'` TagValueSchema, deleted the tag readers and the dead merged-tag-map threading (`collectMutationTags` → validate-only `validateMutationTags`), renamed the `'tag-default'` provenance to `'view-insert-default'`, flipped test expectations, and updated docs. Reviewed and accepted with two minor inline doc fixes; three backlog tickets filed.
files:
  - packages/quereus/src/schema/reserved-tags.ts
  - packages/quereus/src/planner/mutation/mutation-tags.ts
  - packages/quereus/src/planner/mutation/propagate.ts
  - packages/quereus/src/planner/building/view-mutation-builder.ts
  - packages/quereus/src/planner/mutation/single-source.ts
  - packages/quereus/src/func/builtins/schema.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/README.md
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts
  - packages/quereus/test/schema/reserved-tags.spec.ts
  - docs/view-updateability.md, docs/sql.md, docs/schema.md, docs/lens.md, docs/architecture.md
----

# Remove the `quereus.update.default_for.<column>` tag — complete

Second half of the de-tag reframe (prereq `view-insert-default-construct` landed the
first-class `insert defaults (col = expr, …)` clause). This ticket deleted the tag at
both sites, so **no reserved tag carries any behavior**: the registry's `view-ddl`
site admits only the inert rename hints `quereus.id` / `quereus.previous_name`, and
`dml-stmt` admits no reserved key. With no reader left, the merged-tag-map plumbing
went too: `collectMutationTags` became validate-only `validateMutationTags`,
`MutationRequest.tags` / `rewriteViewInsert`'s tags param / `withTags` /
`ReservedTagMap` / `readDefaultFor` / the `'projection'` TagSite / the `'expression'`
TagValueSchema were all removed. `rewriteViewInsert`'s three-pass default precedence
collapsed to the clause; `deriveViewInfo`'s defaultable set is clause-only;
`AttributeDefault.kind` `'tag-default'` was renamed `'view-insert-default'`.

The plan-cache invalidation spec (`view-tag-mutation-plan.spec.ts`) was rewritten:
with no behavioral tag, invalidation is unobservable through tags, so it now pins
eager ALTER rejection of retired keys (view + MV, SET + ADD), the lazy-create /
first-write-fails / DROP-TAGS-recovers migration path on the SAME prepared statement
(also pinning that a failed compile is not cached), case-insensitive ALTER
resolution, and a fresh-statement control.

## Review findings

**Process.** Read the full implement diff (`0644a2c5`, 30 files) with fresh eyes
before the handoff summary; swept the codebase for every removed identifier
(`readDefaultFor`, `DEFAULT_FOR_TEMPLATE`, `ReservedTagMap`, `collectMutationTags`,
`withTags`, `'tag-default'`, the `'projection'` TagSite, the `'expression'` value
schema) and for stray `default_for` / `quereus.update` references in src, docs, and
package READMEs; verified all `validateReservedTags` and `getReservedTagByTemplate`
call sites; confirmed which `AttributeDefault` kinds are constructed and that
nothing reads `.kind`; confirmed the dml-stmt-site validation scope; ran
`yarn build` (exit 0), `yarn lint` (exit 0), and the full workspace `yarn test`
(quereus **5555 passing / 0 failing / 9 pending**; all other packages green — the
`failingKv.iterate` stack line in sync output is a deliberately-failing mock inside
a passing test).

**Minor — fixed inline in this pass:**

- `packages/quereus/README.md` still advertised "a `quereus.update.*` override-tag
  surface" in the Updatable-views feature bullet — the one doc the implement pass
  missed. Reworded to the `insert defaults` clause + presence/membership routing.
- `plan-node.ts`'s `AttributeDefault` docblock implied `'view-insert-default'` is
  actively threaded; it is declared but never constructed (view defaults are
  realized in the write-through rewrite; `deriveViewInfo` folds clause columns
  directly). The comment now says so, pointing at the Divergence-1 note. The union
  member itself was deliberately kept: nothing reads `.kind` (it is informational
  provenance), and the member anchors the documented divergence a future
  thread-onto-PhysicalProperties ticket would close.

**Major — filed as new tickets:**

- `backlog/view-dependency-invalidation-behavioral-coverage` — the implementer's
  flagged discovery, confirmed: with no behavioral tag, the `view`-dependency
  invalidation of cached write-through plans is no longer behaviorally observable
  (the rewritten spec's DROP-TAGS recovery does NOT exercise it — a failed compile
  is never cached, so the retry re-plans regardless). If `recordDependency` or the
  event wiring regressed, no test would fail. Ticket specifies unit-level coverage
  available now and the behavioral re-pin once a mutable view construct exists.
- `backlog/validate-reserved-tags-on-base-dml-statements` — pre-existing asymmetry
  surfaced while verifying validation scope: `dml-stmt`-site validation fires only
  on the view-mediated path, so a reserved key in a base-table DML's `WITH TAGS`
  is silently inert while the same statement through a view errors. Unchanged by
  this ticket, but now a pure typo-guard gap with no behavioral excuse.
- `backlog/rename-tag-target-not-found-diagnostic` — the retained reason name is
  now misleading (raised only for `insert defaults` clause entries; no tag
  involved). Deferred behind the open
  `fix/view-insert-defaults-not-rewritten-on-source-rename`, which reproduces via
  this reason.

**Checked, nothing found (with reasons):**

- *Leftover references*: zero hits for any removed identifier outside sanctioned
  historical-context comments; the two surviving `quereus.update.*` mentions in
  docs/view-updateability.md (§ Set-operation membership writes, § Implemented
  surface note) are explicitly historical descriptions of the never-built routing
  design removed by `remove-update-routing-tag-surface` — correct as written.
- *Error handling / atomicity*: `validateMutationTags` runs in `buildViewMutation`
  before any base op on every write path (single-source, multi-source,
  decomposition, set-op, lens — one funnel), preserving the atomic sited-error
  posture; the 93.4 tombstones assert the rejected insert wrote nothing.
- *Type safety*: no `any` introduced; the `MutationRequest` union narrowed cleanly;
  excess-property checks would catch any straggler `tags:` construction (none
  exist).
- *Test honesty*: every removed behavior case has a clause-form equivalent from the
  prereq, and every removed validation case has a tombstone or a surviving-key
  mis-site replacement (50-metadata-tags and 53-reserved-tags add explicit
  retired-key flips alongside the re-keyed mis-site exemplars, so both rejection
  reasons stay covered). The suite-count drop 5557 → 5555 is accounted for.
- *Docs*: read every touched doc section plus the ones the change should have
  touched; all consistent with the new reality after the README fix above.
  `yarn test:store` not run, consistent with AGENTS.md (tags store verbatim; only
  validation outcomes changed, and clause persistence was covered by the prereq).
