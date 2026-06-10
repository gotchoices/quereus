description: Removed the `quereus.update.default_for.<column>` reserved tag (view-DDL AND statement-level sites), retired the inert `'projection'` TagSite and the `'expression'` TagValueSchema, dropped the tag readers and the dead merged-tag-map threading, renamed the `'tag-default'` provenance to `'view-insert-default'`, flipped mis-site test expectations to unknown-reserved-tag, and updated docs. Second half of the de-tag reframe; prereq `view-insert-default-construct` is complete.
files:
  - packages/quereus/src/schema/reserved-tags.ts                # spec deleted; 'projection' site + 'expression' valueSchema removed; docblock/suggestion updated
  - packages/quereus/src/planner/mutation/mutation-tags.ts      # readDefaultFor + DEFAULT_FOR_TEMPLATE + ReservedTagMap gone; collectMutationTags → validateMutationTags (returns void)
  - packages/quereus/src/planner/mutation/propagate.ts          # MutationRequest.tags removed
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # withTags helper deleted; validation-only call
  - packages/quereus/src/planner/mutation/single-source.ts      # clause is the only insert-default source (tag passes 1+3 removed)
  - packages/quereus/src/func/builtins/schema.ts                # deriveViewInfo defaultable set is clause-only
  - packages/quereus/src/planner/nodes/plan-node.ts             # AttributeDefault.kind 'tag-default' → 'view-insert-default'
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts # tag-target-not-found comment (reason name retained — see flags)
  - packages/quereus/test/schema/reserved-tags.spec.ts          # exemplars re-keyed; tombstone block; RESERVED_TAGS count 18 → 17
  - packages/quereus/test/schema-differ.spec.ts                 # view-ddl acceptance flipped to rename hints + retired-key rejection
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts   # REWRITTEN — see flags
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # tag cases → tombstones; precedence case → clause
  - packages/quereus/test/logic/06.3.4-view-info.sqllogic       # tag-rescue case removed (clause case is the coverage)
  - packages/quereus/test/logic/50-metadata-tags.sqllogic       # mis-site exemplar → lens.writable; retired-key flips added
  - packages/quereus/test/logic/53-reserved-tags.sqllogic       # same flip on the declarative path (§2 + new §2b)
  - docs/view-updateability.md, docs/sql.md, docs/schema.md, docs/lens.md, docs/architecture.md
----

# Remove the `quereus.update.default_for.<column>` tag — review

The prereq (`view-insert-default-construct`, complete) landed the first-class
`insert defaults (col = expr, …)` clause and migrated the behavior tests. This ticket
deleted the tag, so **no reserved tag carries any behavior** — the whole
`quereus.update.*` family is now `unknown-reserved-tag` at every site. The decisions in
the implement ticket (statement-level site goes too; `'projection'` retired;
`collectMutationTags`'s validation role stays; lens/rename tags out of scope) were
followed without deviation.

## What was done

- **Registry** (`reserved-tags.ts`): `default_for` spec deleted; `'projection'` removed
  from `TagSite` + `siteLabel`; `'expression'` removed from `TagValueSchema` (the spec
  was its only user — it shared the TEXT check with `'string'`); unknown-key suggestion
  string and docblocks updated. `view-ddl` now admits only the inert rename hints
  `quereus.id` / `quereus.previous_name`; `dml-stmt` admits no reserved key.
- **Readers + threading**: `readDefaultFor` / `DEFAULT_FOR_TEMPLATE` deleted. With no
  reader left, the merged tag map had no consumer, so the dead plumbing went with it:
  `collectMutationTags` → `validateMutationTags` (validate-only, returns void),
  `MutationRequest.tags` / `rewriteViewInsert`'s `tags` param / the `withTags` helper /
  the exported `ReservedTagMap` type all removed. This is slightly beyond the ticket's
  literal TODO but directly implied by "drop the tag readers" — flagging for review.
- **Rewrite**: `rewriteViewInsert`'s three-pass default precedence collapsed to the one
  remaining source (the clause). `resolveDefaultForColumn` unchanged in behavior.
- **`view_info`**: `deriveViewInfo`'s defaultable set is clause-only (the
  `readDefaultFor(view.tags)` union leg removed).
- **Provenance rename**: `AttributeDefault.kind` `'tag-default'` → `'view-insert-default'`
  (plan-node.ts + comments). NOTE: no code constructs this kind anywhere — pre-existing;
  it is declared in the union and discussed in `deriveViewInfo`'s Divergence-1 comment
  only. No test asserts the label (searched).
- **Stale-comment sweep**: alter-table.ts, schema-differ.ts (RENAME_HINT_KEYS), manager.ts
  (×2), lens-compiler.ts, ast.ts, parser.ts, parser/index.ts, view.ts, plan-node.ts,
  mutation-diagnostic.ts.
- **Docs**: `view-updateability.md` § Tags rewritten (table dropped — it had one row;
  validation-only framing; lazy-create vs eager-ALTER/differ timing documented), § View
  insert defaults gains the removal note incl. statement-level ("supply an explicit
  insert value"), step 5 / Dataphor / stale `no-default`-suggestion claim fixed;
  `sql.md` §2.8/§2.9 + ALTER-TAGS sections; `schema.md` + `architecture.md` + `lens.md`
  exemplar/behavioral-tag phrasing.

## Discovery the reviewer should weigh: the invalidation observable is gone

While flipping `view-tag-mutation-plan.spec.ts` I found `ALTER VIEW/MV … SET|ADD TAGS`
validates **eagerly** at the `view-ddl` site (`buildSetObjectTags`) — the retired key
cannot be *introduced* via ALTER at all. Since no behavioral tag remains, there is **no
way left to observe** the `view_modified` → cached-write-through-plan invalidation
through tags (a stale plan and a fresh plan now behave identically under any *legal*
tag change). The spec was rewritten to pin what is genuinely observable:

- eager ALTER rejection of the retired key (view + MV, SET + ADD);
- the migration escape hatch: a direct `create view … with tags (retired key)` is
  stored lazily, the first prepared write-through fails at plan time, and `DROP TAGS`
  (which never value-validates) recovers **the same prepared statement** (also pins that
  a failed compile is not cached); case-differing ALTER identifier rides this path;
- a fresh-statement control.

Consequence: the `view`-dependency recording in `buildViewMutation` is now pinned only
structurally (comment), not behaviorally. If a future behavioral view construct (e.g. an
`alter view … set insert defaults`) lands, invalidation coverage should be restored
against it. The reviewer may judge whether that warrants a backlog note now.

## Known gaps / judgment calls to re-check

- **`tag-target-not-found` reason name retained** although it is now raised only for the
  `insert defaults` clause. Renaming would churn the prereq's tests and the open
  `fix/view-insert-defaults-not-rewritten-on-source-rename` ticket which reproduces via
  this reason; comments updated instead. A rename (`default-target-not-found`?) is a
  candidate follow-up, not done here.
- **`'view-insert-default'` kind is declared but never constructed** (pre-existing — the
  provenance is consumed only notionally; `deriveViewInfo` folds clause columns directly).
  Reviewer may consider whether the union member should exist at all.
- The test-suite count moved 5557 → 5555 (tag-behavior specs removed/condensed vs.
  tombstones added) — deliberate, not lost coverage: every removed behavior case has a
  clause-form equivalent from the prereq, and every removed validation case has a
  tombstone (unknown-reserved-tag) or a surviving-key mis-site replacement.
- `yarn test:store` not run (AGENTS.md reserves it for store diagnosis/release). Tag DDL
  round-trip is unchanged by this ticket (tags store verbatim; only validation outcomes
  changed), and the clause round-trip was covered by the prereq's persistence tests.

## Validation

- `yarn build` (full workspace) exit 0; `yarn lint` (packages/quereus) exit 0.
- `yarn test` full workspace green: quereus **5555 passing / 0 failing / 9 pending**;
  all other packages passing (the `failingKv.iterate` stack line in sync output is a
  deliberately-failing mock inside a passing test, noted in the prereq's review too).
- Key cases to spot-check while reviewing: 93.4 `df_v` (statement-level tombstone),
  `df5_v` (view-DDL tombstone), `dfp_v` (precedence via clause), removed-routing-key
  cases ~1242-1273 untouched; 53-reserved-tags §2/§2b; 50-metadata-tags inline + ADD
  CONSTRAINT pairs; `view-tag-mutation-plan.spec.ts` (rewritten rationale above);
  reserved-tags.spec count 17.
