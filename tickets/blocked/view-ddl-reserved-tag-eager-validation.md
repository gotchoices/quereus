description: DESIGN QUESTION — human sign-off needed. Should direct `CREATE VIEW` / `CREATE MATERIALIZED VIEW … WITH TAGS` validate reserved `quereus.*` tags eagerly at create (mirroring the differ + the new CREATE TABLE/INDEX path), or is lazy-at-mutation the intended contract? Changing it alters WHEN the error fires and rewrites a deliberately-codified test contract (93.4) owned by the view-mutation subsystem. Blocked on a call from the view-mutation owner.
files:
  - packages/quereus/src/planner/building/create-view.ts        # buildCreateViewStmt — stores stmt.tags, no reserved-tag validation
  - packages/quereus/src/planner/building/materialized-view.ts  # buildCreateMaterializedViewStmt — same
  - packages/quereus/src/planner/mutation/mutation-tags.ts       # collectMutationTags — validates view tags at 'view-ddl' ONLY when the view is mutated
  - packages/quereus/src/schema/schema-differ.ts                # ~238-245 — differ validates declared (M)V tags eagerly at 'view-ddl'
  - packages/quereus/src/planner/building/ddl.ts                # CREATE TABLE/INDEX eager-validation precedent (create-reserved-tag-validation)
  - packages/quereus/src/schema/reserved-tags.ts                # 'view-ddl' site; legal keys: quereus.id / previous_name (differ-only) + quereus.update.default_for.<column> (mutation-only)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # ~1160-1192 — deliberately codifies "view-tag error surfaces at mutation, not at create"
----

# View DDL reserved-tag validation: eager-at-create vs lazy-at-mutation

> **Disposition (2026-06-08) — Options A/B SUPERSEDED.** The human chose the de-tag
> reframe. Options A and B below (eager-at-create vs lazy-at-mutation) are kept as the
> historical framing only; both are moot once the sole behavior-bearing `view-ddl` tag is
> replaced by a first-class construct. See **`## De-tag reframe — first-class view
> insert-default construct (design, 2026-06-08)`** at the end of this file for the chosen
> direction and staging.

> **Update (2026-06-07) — reframe under consideration (human, pending).** A third path sits
> *above* Option A/B: stop carrying this *semantic* behavior as a tag at all. The only
> behavior-bearing tag at this site is `quereus.update.default_for.<column>` (an omitted-insert
> default on view write-through); if that moves to a **first-class view insert-default
> construct**, the eager-vs-lazy *validation-timing* question dissolves (no tag → no tag
> validation to time). Precedent: the view-mutation **routing** tags were already removed this
> way in favor of per-row presence/membership columns (`reserved-tags.ts:15-18`,
> `mutation-tags.ts:22-27`). The human is weighing this de-tagging direction against the A/B
> options below — decision deferred. A broader "which reserved tags are genuinely metadata vs.
> semantic behavior" audit is a *separate* concern (the `quereus.lens.decomp.*` mapping,
> `quereus.id` / `previous_name` rename hints, and lens governance tags likely **stay** tags).

## Why this is blocked (not an implement ticket)

This is a genuine contract question with two internally-consistent answers, and
the original reviewer (`create-reserved-tag-validation`) explicitly asked for the
**view-mutation owner's** call before any change, because the eager option
rewrites a test contract (`93.4-view-mutation.sqllogic` ~1160-1192) that
*deliberately* asserts the lazy timing. The plan stage could not obtain that
sign-off (the interactive question went unanswered in the autonomous runner), and
there is no clearly-dominant default — so it parks here rather than shipping a
speculative behavior change to another subsystem's documented contract.

**Unblock condition:** the view-mutation owner (or the human) picks Option A or
Option B below. Then move this file to `tickets/implement/` (Option A — the TODO
is already written) or `tickets/complete/` (Option B — no code change; record the
decision). No code lands until then.

## The situation

`CREATE VIEW … WITH TAGS` and `CREATE MATERIALIZED VIEW … WITH TAGS`
(`create-view.ts` / `materialized-view.ts`) **store** `stmt.tags` on the view
node but never validate reserved tags at create time. The only `view-ddl`
validation today is in `mutation-tags.ts` `collectMutationTags`, which runs at
the `view-ddl` site **only when the view is mutated**
(`93.4-view-mutation.sqllogic:1160-1164`, 1182-1192).

Crucially, on a **direct** create *no reserved view tag has any create-time
effect*: the only keys legal at `view-ddl`
(`reserved-tags.ts`) are

- `quereus.id` / `quereus.previous_name` — rename hints read **only by the
  declarative differ**; inert on a directly-created view, and
- `quereus.update.default_for.<column>` — a **mutation-only** insert-default
  override.

So a typo on a view tag that is **never mutated never surfaces** (the hole), but
equally: at create time the tag genuinely does nothing, so validating at the
point of *effect* (mutation) is internally consistent (the lazy defense).

Note the asymmetry this leaves: the declarative differ already validates declared
(materialized) view tags **eagerly** at the `view-ddl` site
(`schema-differ.ts:238-245`), and `create-reserved-tag-validation` made direct
`CREATE TABLE` / `CREATE INDEX` validate eagerly — so direct `CREATE VIEW` is the
*only* DDL authoring path that defers reserved-tag validation.

## The design question

Should direct `CREATE VIEW` / `CREATE MATERIALIZED VIEW` reserved tags ALSO be
validated **eagerly at create**, or is **lazy-at-mutation** the intended contract?

### Option A — eager at create (consistency / fail-fast)

Validate view & MV reserved tags at build time in `buildCreateViewStmt` /
`buildCreateMaterializedViewStmt`, mirroring the differ and the
`raiseStmtTagDiagnostics` helper in `ddl.ts`.

- **Pros:** one uniform "a typo can't be silently stored on any authoring path"
  posture across every DDL path (the stated thrust of the whole reserved-tags
  effort — `ddl.ts:13-14`, `reserved-tags.ts:155-156`); a never-mutated view's
  typo is caught at authoring time; removes the last DDL-path asymmetry.
- **Cons / cost:** changes **when** the error fires for view tags. Must rewrite
  `93.4-view-mutation.sqllogic` ~1160-1192 so the removed-routing-key / typo
  cases error at the `create view` line instead of at the first `insert`. The
  mutation-path validation (`collectMutationTags`) stays (a view can still be
  reached without re-validating, and statement-level `dml-stmt` tags are
  validated there regardless) — so this ADDS an eager gate, it does not move the
  lazy one.

### Option B — keep lazy-at-mutation (intended contract)

Treat lazy as the deliberate contract: a view's reserved tags are meaningful only
at mutation, so an unused typo is harmless and surfaces on first mutation.

- **Pros:** validates at the point of effect; no churn to the 93.4 contract; the
  create path stays minimal (DML statement tags are already validated lazily at
  `dml-stmt`, symmetric with view-level `view-ddl` tags).
- **Cons:** the never-mutated-view typo hole persists; direct `CREATE VIEW`
  remains the lone DDL path that defers reserved-tag validation.

## Edge cases & interactions (for whichever option lands)

- **Materialized views** must be decided **together with** plain views — same
  `view-ddl` site, same `stmt.tags` slot; do not split their behavior.
- **`default_for.<column>` is the only functional view tag.** Under Option A its
  *shape/site* is validated at create, but its *semantic* effect (omitted-insert
  default) still only fires at mutation — eager validation must not change the
  effect, only catch a malformed key earlier.
- **Differ unchanged.** The declarative-differ `view-ddl` validation already
  fires eagerly; neither option touches it — keep them consistent (Option A makes
  direct-create match the differ; Option B accepts the divergence by design).
- **Mutation path stays.** `collectMutationTags` must keep validating at mutation
  regardless (statement-level `dml-stmt` tags, and a view mutated after a tag was
  added by other means). Option A adds a gate; it does not remove this one.
- **`IF NOT EXISTS` / re-create:** under Option A a malformed tag should fail at
  plan-build even if the view already exists, matching the CREATE TABLE precedent
  (`50-metadata-tags.sqllogic:457-461`).
- **Sited diagnostics:** an eager view error should carry the statement's
  line/column (reuse the `ddl.ts` `raiseStmtTagDiagnostics` pattern), matching the
  mutation-path sited errors the 93.4 tests assert.

## TODO (Option A only — delete this section if Option B is chosen)

- [ ] Add eager reserved-tag validation to `buildCreateViewStmt`
      (`create-view.ts`) and `buildCreateMaterializedViewStmt`
      (`materialized-view.ts`): `validateReservedTags(stmt.tags, 'view-ddl')`
      raised via the shared `ddl.ts` `raiseStmtTagDiagnostics` pattern (factor it
      to a shared helper rather than copy-paste).
- [ ] Rewrite `test/logic/93.4-view-mutation.sqllogic` ~1160-1192 so the
      view-DDL typo / removed-routing-key cases assert the error at `create view`
      / `create materialized view`, not at the first `insert`. Keep the
      statement-level (`dml-stmt`) typo cases (~1156-1158) firing at mutation.
- [ ] Add eager-validation cases (valid `default_for`, typo'd key, mis-sited key)
      to the view test surface; mirror the CREATE TABLE block style in
      `50-metadata-tags.sqllogic`.
- [ ] `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log`
      + lint; reconcile any other test that depended on lazy view-tag timing.
- [ ] Update `docs/view-updateability.md` (Tags section) to state the create-time
      validation timing.
