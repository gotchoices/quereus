description: Remove the `quereus.update.default_for.<column>` reserved tag (superseded by the first-class `insert defaults (…)` view construct), retire the inert `'projection'` TagSite, drop the tag readers, flip the mis-site test expectations, and update docs. Second half of the de-tag reframe from blocked/view-ddl-reserved-tag-eager-validation.
prereq: view-insert-default-construct
files:
  - packages/quereus/src/schema/reserved-tags.ts                # delete the default_for spec (~178-190); retire 'projection' from TagSite union (~44-62) + siteLabel arm (~581)
  - packages/quereus/src/planner/mutation/mutation-tags.ts      # drop readDefaultFor + DEFAULT_FOR_TEMPLATE (~40-99); collectMutationTags itself stays
  - packages/quereus/src/func/builtins/schema.ts                # 'tag-default' provenance → 'view-insert-default'
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # remaining tag-form cases → construct; statement-level default_for cases removed
  - packages/quereus/test/logic/06.3.4-view-info.sqllogic       # same
  - packages/quereus/test/logic/50-metadata-tags.sqllogic       # ~501-509, ~585-589: mis-sited default_for flips tag-not-allowed-here → unknown-reserved-tag
  - packages/quereus/test/logic/53-reserved-tags.sqllogic       # ~43-54: same flip on the declarative path
  - docs/view-updateability.md                                  # § Tags: remove default_for; § View insert defaults becomes the only surface
  - docs/sql.md                                                 # note the tag's removal in §2.8/§2.9
----

# Remove the `quereus.update.default_for.<column>` tag

## Background

`view-insert-default-construct` (prereq) landed the first-class replacement and migrated the
behavior tests. This ticket deletes the tag so no behavior-bearing reserved tag remains at
the `view-ddl` site — dissolving the eager-vs-lazy validation-timing question the original
blocked ticket was parked on (nothing is left to time; only the differ-only rename hints
`quereus.id` / `quereus.previous_name` remain at `view-ddl`, inert on a direct create).

## Decisions already made (do not relitigate)

- **Statement-level `default_for` goes too.** The tag's `'dml-stmt'` site backed
  `insert into v with tags ("quereus.update.default_for.created" = …)`
  (`docs/view-updateability.md` ~709-715). Dropped: the view-level construct is the
  documented primary use, and a per-statement default is expressible as an explicit insert
  value. If a per-statement override is ever wanted it is a future construct, not a tag.
- **`'projection'` TagSite is retired.** It exists solely for `default_for` and is inert
  (no parser path produces a per-result-column tag); with the spec gone the site has no
  member. Remove it from the `TagSite` union and its `siteLabel` arm.
- **`collectMutationTags` stays** — it still validates remaining `dml-stmt` reserved keys
  and guards typo'd / mis-sited tags at mutation; only the `default_for` reader goes.
- **What stays tags stays out of scope** — `quereus.lens.*` mapping, rename hints, and lens
  governance tags are genuine metadata; the broader metadata-vs-semantics tag audit is a
  separate concern.

## TODO

- Delete the `quereus.update.default_for.<column>` entry from `RESERVED_TAG_SPECS`; remove
  the `'projection'` site from the `TagSite` union + `siteLabel`.
- Drop `readDefaultFor` + `DEFAULT_FOR_TEMPLATE`; remove the construct ticket's temporary
  tag-fallback read in `single-source.ts` (and any other call site found in its trace) so
  the schema field is the only source.
- Rename the `'tag-default'` provenance string in `deriveViewInfo` to
  `'view-insert-default'` (update any test asserting the provenance label).
- Flip mis-site expectations: `50-metadata-tags.sqllogic` ~501-509 / ~585-589 and
  `53-reserved-tags.sqllogic` ~43-54 — a mis-sited `default_for` is now
  `unknown-reserved-tag` (still an error, different reason).
- Remove the surviving tag-form cases in `93.4` / `06.3.4` (the construct cases from the
  prereq ticket are the coverage); confirm the removed-routing-key cases (`93.4` ~1199-1209)
  are untouched.
- Docs: `docs/view-updateability.md` § Tags loses `default_for` (point to § View insert
  defaults, including the statement-level removal note); `docs/sql.md` updated.
- `yarn build`, lint, `yarn test` green — suite must never go red between the construct
  landing and the tag leaving (this ticket is the leaving).
