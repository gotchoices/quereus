description: A DELETE/UPDATE WHERE that filters on a computed (non-invertible) decomposition column living on the **anchor** member is wrongly rejected as "references a non-anchor decomposition member". Fix the misleading diagnostic by *supporting* the case: a computed column whose mapping lives on the anchor resolves entirely to anchor base terms (`bumped = 11` → `a + 1 = 11`), which the anchor subquery already evaluates. Only genuinely non-anchor members / EAV / subqueries defer, and their diagnostics must be accurate. Surfaced during review of `decomposition-non-identity-columnar-mapping-coverage`.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/lens.md, packages/quereus/docs/view-updateability.md
----

## Summary (fix-stage findings — reproduced + verified)

`assertAnchorScoped` (`decomposition.ts` ~line 828, reached by both `decomposeDelete` and
`decomposeUpdate` via `anchorPredicate`) gates each WHERE column through `classifyColumn` and
treats anything that is not `kind === 'member' && member.relationId === anchor` as a non-anchor
reference:

```ts
const nonAnchor = [...refs.names].some(name => {
	const route = classifyColumn(shape, name);
	return !(route.kind === 'member' && route.member.relationId === shape.anchor.relationId);
});
if (refs.hasSubquery || nonAnchor) {
	raiseMutationDiagnostic({
		reason: 'unsupported-decomposition-predicate',
		message: `... the WHERE references a non-anchor decomposition member; ...`,
	});
}
```

A `computed-mapping` column **on the anchor** (`bumped = a + 1`, `combined = a || b`) has
`route.kind === 'computed-mapping'`, so it falls into the `nonAnchor` bucket and inherits the
"non-anchor decomposition member" message — factually wrong: the column is on the anchor, it is
merely computed.

**Reproduced** (against the `nonIdentityAd()` fixture in `test/lens-put-fanout.spec.ts`, anchor
`N_core` with `bumped = a+1`, `combined = a||b`): both

```sql
delete from x.N where bumped = 11;
update x.N set a = 0 where combined = '1020';
```

raise `cannot write through logical table 'N': the WHERE references a non-anchor decomposition
member; ...` (`reason: 'unsupported-decomposition-predicate'`).

## Decision: SUPPORT (not just relabel)

`substituteViewColumns(where, shape, view)` already rewrites the user WHERE into the get body's
base terms (`bumped = 11` → `a + 1 = 11`, `combined = '1020'` → `a || b = '1020'`). For a computed
column **whose mapping lives on the anchor member**, the basis expression references only the
anchor relation's base columns, so the substituted predicate is anchor-scoped and evaluable inside
the existing `anchorKeySubquery` (`select <anchorKey> from <anchor> where <pred>`). No new
substrate is needed.

**Verified end-to-end** during the fix stage by temporarily relaxing the gate to allow
`computed-mapping` on the anchor:

- `delete from x.N where bumped = 11` → deleted **only** id=1 (a=10 → bumped=11), table emptied. ✓
- `update x.N set a = 0 where combined = '1020'` (with a second row id=2, a=99, b=20 →
  combined='9920' present) → set `a = 0` on **only** id=1, left id=2 untouched:
  `[{id:1,a:0,b:20},{id:2,a:99,b:20}]`. ✓

So the fix is to let an **anchor-resolvable** column through (identity member **or** a computed
mapping on the anchor), and defer only when the predicate genuinely reaches a non-anchor member, an
EAV pivot, or embeds a subquery — each with an **accurate** diagnostic.

### Invariant the support relies on

A `computed-mapping` whose owning member is the anchor has a basis expression over the **anchor's
own** base columns (each member maps its logical columns to expressions over its own relation), so
the substituted predicate resolves entirely to anchor base terms. This is the natural columnar-
decomposition invariant. A computed mapping on a *non-anchor* member, or an EAV pivot column, does
**not** satisfy it and must still defer.

## Diagnostic distinctions (after support)

Once anchor-computed columns are supported, the remaining deferral cases are:

- a genuine **non-anchor member** column (identity *or* computed on a non-anchor member) — keep the
  existing **"backed by a non-anchor decomposition member"** wording (the
  `delete filtered on a non-anchor member is deferred` test at `lens-put-fanout.spec.ts:160`
  matches `/non-anchor decomposition member/i`; preserve that phrase so it still passes);
- an **EAV pivot** column — give it an EAV-specific message (it is not a "member" join column),
  mirroring the EAV wording already used in `routeAssignment` (`is backed by an EAV pivot member`);
- an embedded **subquery** (`refs.hasSubquery`) — give it a subquery-specific message; lumping it
  under "non-anchor member" is also a misattribution (it may not name any non-anchor column at all).

Keep all three under `reason: 'unsupported-decomposition-predicate'` (the existing reason code) so
the structured-diagnostic contract is unchanged; only the human message text differs per case.

An `unbacked` route (a name that passed the `unknown-view-column` guard because it is in
`shape.columns`, but `classifyColumn` resolves to `'unbacked'`) is rare; defer it with an accurate
message rather than "non-anchor member" (it is not backed by any member). Do not over-engineer —
a single fallback branch is fine.

## Suggested gate shape

Replace the boolean `nonAnchor` collapse with a per-name walk that allows anchor-resolvable columns
and raises a case-specific message otherwise (subquery checked first, since it defers regardless of
which columns it names):

```ts
function assertAnchorScoped(view, shape, where) {
	const refs = collectViewColumnRefs(where);
	// unknown-view-column guard (UNCHANGED — keep it first)
	for (const name of refs.names) { /* ... existing ... */ }

	if (refs.hasSubquery) {
		raiseMutationDiagnostic({ reason: 'unsupported-decomposition-predicate', table: view.name,
			message: `cannot write through logical table '${view.name}': the WHERE embeds a subquery; a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution (deferred — filter only on anchor base columns)` });
	}

	const anchorId = shape.anchor.relationId;
	for (const name of refs.names) {
		const route = classifyColumn(shape, name);
		// Anchor-resolvable: an identity base column on the anchor, OR a computed mapping
		// whose basis is the anchor (substitutes into anchor-scoped base terms).
		if ((route.kind === 'member' || route.kind === 'computed-mapping') && route.member.relationId === anchorId) continue;
		if (route.kind === 'eav') {
			raiseMutationDiagnostic({ reason: 'unsupported-decomposition-predicate', table: view.name,
				message: `cannot write through logical table '${view.name}': the WHERE references column '${name}', backed by an EAV pivot member; ... (deferred)` });
		}
		raiseMutationDiagnostic({ reason: 'unsupported-decomposition-predicate', table: view.name,
			message: `cannot write through logical table '${view.name}': the WHERE references column '${name}', backed by a non-anchor decomposition member; a predicate-honest multi-member fan-out needs snapshot-consistent base-op execution (deferred — filter only on the anchor / shared key, or pin the rows via the anchor)` });
	}
}
```

(The `eav` branch's `route.member` is the EAV pivot member; note EAV pivots are absent from
`memberByTableId` but `classifyColumn` still returns the pivot member — fine for the message. Adjust
wording to match the codebase's voice; the regex contract is only that the non-anchor-member case
keeps the substring `non-anchor decomposition member`.)

Note `ColumnRoute` for `'member'` and `'computed-mapping'` both carry `member`, so the combined
guard `(route.kind === 'member' || route.kind === 'computed-mapping')` narrows `route.member`
correctly. Confirm TypeScript is happy with the union narrowing (it was in the fix-stage spike).

## Tests (pin the chosen SUPPORT behaviour)

Add to the `non-identity columnar mappings (computed-mapping route)` describe block in
`packages/quereus/test/lens-put-fanout.spec.ts` (fixture `setupNonIdentity`, seeded row
`(1, 10, 20)`):

- **DELETE on the invertible-transform anchor column** — `delete from x.N where bumped = 11`
  deletes the matched row (assert `main.N_core` is empty afterward, and a non-matching value
  e.g. `where bumped = 999` deletes nothing).
- **DELETE on the non-invertible composite anchor column** — `delete from x.N where combined =
  '1020'` deletes id=1; add a second row (`insert into main.N_core values (2, 99, 20)` →
  combined='9920') and assert only id=1 is removed.
- **UPDATE with a WHERE on a computed anchor column** — seed a second row, then
  `update x.N set a = 0 where combined = '1020'` updates **only** id=1
  (`[{id:1,a:0,b:20},{id:2,a:99,b:20}]`). (The SET target `a` is the identity sibling, which is
  already writable; the point of the case is the *WHERE* on a computed anchor column.)

Keep the existing genuine-non-anchor deferral case (`delete filtered on a non-anchor member is
deferred` at `lens-put-fanout.spec.ts:160`, on the multi-member `split()` fixture filtering on
`b`) so the two diagnostics stay distinguishable — verify it still matches
`/non-anchor decomposition member/i` under the new message wording.

## Docs

Refine the "anchor-only predicate" / "non-anchor member" deferral wording — the gate now accepts
**anchor-resolvable** predicates (identity *or* computed-on-anchor), and defers only genuine
non-anchor members / EAV / subqueries:

- `docs/lens.md` — line ~75 ("the anchor-only predicate gate"), line ~77 (DELETE bullet), and line
  ~81 (Pending list: "a DELETE/UPDATE `WHERE` that references a non-anchor member").
- `packages/quereus/docs/view-updateability.md` — line ~1005 ("decomposition: member routing +
  anchor-only predicate gate") and line ~1009 ("anchor-only predicate gate" / "Still deferred ...
  a non-anchor-member predicate").
- The module header comment in `decomposition.ts` (lines ~59-62: "A DELETE/UPDATE **WHERE that
  references a non-anchor member**") and the `assertAnchorScoped` / `anchorPredicate` doc comments
  (which say "anchor-only" / "every logical column the predicate names must be backed by the anchor
  member") — update to "anchor-resolvable (identity base column **or** a computed mapping on the
  anchor)".

## TODO

- [ ] Rewrite `assertAnchorScoped` (`decomposition.ts` ~828) to allow anchor-resolvable columns
      (identity member OR `computed-mapping` whose `member` is the anchor) and raise a case-specific
      message for the subquery / EAV / non-anchor-member / unbacked deferrals (keep
      `reason: 'unsupported-decomposition-predicate'`; preserve the `non-anchor decomposition member`
      substring for the genuine non-anchor case).
- [ ] Update the `anchorPredicate` / `assertAnchorScoped` doc comments and the module header bullet
      to "anchor-resolvable" wording.
- [ ] Add the DELETE-on-`bumped`, DELETE-on-`combined`, and UPDATE-with-WHERE-on-`combined` support
      cases to the `non-identity columnar mappings` describe block; confirm the existing
      non-anchor-member deferral test still passes.
- [ ] Update `docs/lens.md` and `packages/quereus/docs/view-updateability.md` predicate-gate wording.
- [ ] `yarn workspace @quereus/quereus run test` (or `node test-runner.mjs`) green; run
      `yarn workspace @quereus/quereus lint` (single-quote globs on Windows) on the touched file.
