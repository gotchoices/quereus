----
description: Rename the `tag-target-not-found` MutationDiagnosticReason to `default-target-not-found` — it is raised only for `insert defaults (col = expr, …)` clause entries; no tag is involved anymore.
files:
  - packages/quereus/src/planner/mutation/mutation-diagnostic.ts   # reason union, line ~17
  - packages/quereus/src/planner/mutation/single-source.ts         # resolveDefaultForColumn: doc comment ~line 661, raise site ~line 670
  - docs/view-updateability.md                                     # diagnostic catalog, line ~863
effort: low
----

# Rename `tag-target-not-found` → `default-target-not-found`

After `remove-view-default-for-tag`, this `MutationDiagnosticReason` is raised in
exactly one place: `resolveDefaultForColumn` in
`packages/quereus/src/planner/mutation/single-source.ts`, when an
`insert defaults (col = expr, …)` clause entry names a column that is neither a
view-output column nor a base-table column. The "tag" in the name is a fossil of
the retired `quereus.update.default_for.<col>` override surface and misleads
users reading the structured diagnostic (no tag appears anywhere in their
statement).

## Decision (settled)

New name: **`default-target-not-found`**. Chosen over
`insert-default-target-not-found` for brevity, matching the union's existing
terse style (`no-default`, `no-inverse`); there is only one defaults construct,
so the shorter form is unambiguous. Pure rename of the machine-readable
`reason` string — the human `message` text is unchanged, and backwards
compatibility is explicitly not a concern yet.

## Exhaustive occurrence list (verified by repo-wide grep, 2026-06-10)

The literal string `tag-target-not-found` appears in exactly these production
locations — nothing else in `src/`, `test/`, or other packages references it:

1. `packages/quereus/src/planner/mutation/mutation-diagnostic.ts:17` — union
   member. Also rewrite its trailing comment: drop the parenthetical
   "(reason name retained from the tag-era override surface the clause
   replaced)" — it becomes false after the rename. Keep the construct
   description ("an `insert defaults (col = expr, …)` clause entry names a
   column that is neither a view nor a base column").
2. `packages/quereus/src/planner/mutation/single-source.ts:661` — the
   `resolveDefaultForColumn` doc comment names the reason; update the string
   there too.
3. `packages/quereus/src/planner/mutation/single-source.ts:670` — the
   `raiseMutationDiagnostic({ reason: … })` raise site.
4. `docs/view-updateability.md:863` — the `MutationDiagnostic` catalog entry in
   the `## Diagnostics` section. Same comment-fossil cleanup as (1): drop the
   "reason name retained from the tag-era surface" parenthetical.

Remaining grep hits live under `tickets/complete/` (historical records — leave
untouched) and the plan ticket this one replaces.

## Tests

No test asserts the literal reason string (verified: `test/` greps for
`tag-target-not-found` return zero hits; `property.spec.ts` asserts
`mutationDiagnostic.reason` only for other reasons). The sqllogic coverage of
this path pins the human **message** instead:

- `test/logic/93.4-view-mutation.sqllogic` — the unknown-column
  `insert defaults` cases assert message fragments like `not a column` /
  `names column`; the message is unchanged, so these must keep passing as-is.
- `test/logic/41.3-alter-rename-propagation.sqllogic:761` and
  `test/logic/53.2-materialized-view-rename-propagation.sqllogic:181` mention
  the message in comments only.

Optionally add one `expect(err.mutationDiagnostic.reason).to.equal('default-target-not-found')`
assertion to `test/quereus/view-mutation-substrate.spec.ts` (which already has
the pattern at line ~147 for `cross-source-ambiguous-cardinality`) so the
machine-readable string is pinned going forward — cheap and directly tests the
renamed surface.

## Edge cases & interactions

- **Stale-name leakage**: after the edit, a repo-wide grep for
  `tag-target-not-found` must hit only `tickets/complete/` history. In
  particular the two prose comments (union member, `resolveDefaultForColumn`
  doc comment) and the docs catalog must not retain the old name or the
  now-false "retained from the tag era" justification.
- **Message stability**: the sqllogic tests above pass on message text — do not
  reword `message` while renaming `reason`.
- **TypeScript exhaustiveness**: `MutationDiagnosticReason` is a string-literal
  union; the compiler will flag any missed raise site, so a clean
  `yarn workspace @quereus/quereus run build` (or `yarn build`) after the
  rename is itself the completeness check for code. Docs need the manual grep.
- **No other diagnostic overlap**: `unknown-view-column` covers top-level
  where/set/returning refs; this reason remains exclusively the
  `insert defaults` clause-entry guard. The rename must not merge or reroute
  either.

## TODO

- Rename the union member in `mutation-diagnostic.ts` and fix its comment (drop the tag-era parenthetical).
- Update the raise site and doc comment in `single-source.ts:resolveDefaultForColumn`.
- Update the catalog entry in `docs/view-updateability.md` `## Diagnostics` (same comment cleanup).
- Add a `mutationDiagnostic.reason === 'default-target-not-found'` assertion to `test/quereus/view-mutation-substrate.spec.ts`.
- Grep repo for `tag-target-not-found`; confirm only `tickets/complete/` hits remain.
- Run `yarn build` and `yarn test`; confirm 93.4 / 41.3 / 53.2 sqllogic suites pass unchanged.
