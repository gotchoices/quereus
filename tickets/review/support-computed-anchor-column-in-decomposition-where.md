description: A DELETE/UPDATE WHERE filtering on a computed (non-invertible) decomposition column that lives on the **anchor** member is now *supported* instead of being wrongly rejected as "references a non-anchor decomposition member". A computed column whose mapping basis lives on the anchor (`bumped = a + 1`, `combined = a || b`) substitutes entirely into anchor base terms (`bumped = 11` → `a + 1 = 11`), which the existing anchor key subquery already evaluates — no new substrate. Genuinely non-anchor members / EAV pivots / embedded subqueries still defer, each now with an *accurate* case-specific diagnostic (no more misattributing an EAV/subquery predicate as a "non-anchor member"). Implement is done, build + lint + full test suite green; review for completeness of the new diagnostic branches and multi-member interaction.
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/test/lens-put-fanout.spec.ts, docs/lens.md, docs/view-updateability.md
----

## What changed (implement summary)

The misleading-diagnostic bug was fixed by **supporting** the case, per the fix-stage
decision, not just relabeling it.

### `decomposition.ts` — the gate rewrite

`assertAnchorScoped` (`packages/quereus/src/planner/mutation/decomposition.ts:875`, reached
by both `decomposeDelete` and `decomposeUpdate` through `anchorPredicate` ~`:848`) previously
collapsed every non-`member`-on-anchor route into one boolean `nonAnchor` and raised a single
"non-anchor decomposition member" message — factually wrong for a `computed-mapping` whose
member **is** the anchor (the column is on the anchor, it is merely computed).

It now does a per-name walk:

- **Subquery first** (`refs.hasSubquery`) — defers regardless of which columns it names, with a
  subquery-specific message.
- **Anchor-resolvable → admitted**: `(route.kind === 'member' || route.kind === 'computed-mapping')
  && route.member.relationId === anchorId`. Both `ColumnRoute` variants carry `member`, so the
  union narrows. An identity base column on the anchor *or* a computed mapping whose basis lives
  on the anchor both substitute (via `substituteViewColumns`) into a predicate over the anchor's
  own base columns, which `anchorKeySubquery` already evaluates.
- **Otherwise → defer** via the new `nonAnchorPredicateDiagnostic` (`:922`), which switches on
  `route.kind` to produce an accurate message per case — `eav` (EAV pivot member), `unbacked`
  (backed by no member), and the `default` genuine **non-anchor member**. All three keep
  `reason: 'unsupported-decomposition-predicate'` (structured contract unchanged); only the human
  text differs. The genuine-non-anchor branch **preserves the `non-anchor decomposition member`
  substring** so the existing deferral test's `/non-anchor decomposition member/i` regex still
  matches.

The encapsulation-leak guard (`unknown-view-column` for a name not in `shape.columns`) is
unchanged and still runs first.

Doc comments updated to "anchor-resolvable" wording: the module header bullet (`:59`),
`anchorPredicate` (`:836`), `assertAnchorScoped` (`:854`), and the shared `backward-body.ts`
consumer comment (`:23`).

### Invariant the support relies on

A `computed-mapping` whose owning member is the anchor has a basis expression over the **anchor's
own** base columns (each member maps its logical columns to expressions over its own relation), so
the substituted predicate resolves entirely to anchor base terms. A computed mapping on a
*non-anchor* member, or an EAV pivot column, does **not** satisfy this and still defers. This is
the natural columnar-decomposition invariant — but note it is **assumed**, not asserted at the
gate: the gate trusts that `route.member.relationId === anchorId` ⇒ basis-on-anchor. See gaps.

## Tests added (`lens-put-fanout.spec.ts`, `non-identity columnar mappings` block)

Fixture `setupNonIdentity` (anchor `N_core`, single member, `bumped = a+1`, `combined = a||b`,
seeded row `(1, 10, 20)` → bumped=11, combined='1020'):

- **DELETE on the invertible-transform anchor column** — `delete from x.N where bumped = 999`
  deletes nothing; `delete from x.N where bumped = 11` empties the anchor. ✓
- **DELETE on the non-invertible composite anchor column** — second row inserted
  (`insert into main.N_core values (2, 99, 20)` → combined='9920'); `delete from x.N where
  combined = '1020'` removes only id=1. ✓
- **UPDATE with a WHERE on a computed anchor column** — second row present;
  `update x.N set a = 0 where combined = '1020'` updates only id=1 →
  `[{id:1,a:0,b:20},{id:2,a:99,b:20}]`. The SET target `a` is the writable identity sibling; the
  point is the *WHERE* on the computed anchor column. ✓

The existing **genuine non-anchor-member deferral** test (`delete filtered on a non-anchor member
is deferred`, `lens-put-fanout.spec.ts:160`, on the multi-member `split()` fixture filtering on
`b`) still passes against `/non-anchor decomposition member/i`, keeping the two diagnostics
distinguishable.

## Validation run (all green)

- Focused spec: `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js
  "packages/quereus/test/lens-put-fanout.spec.ts"` → **41 passing**.
- Full suite: `node test-runner.mjs` (from `packages/quereus`) → **4418 passing, 9 pending**.
- `tsc --noEmit` → clean. `eslint` on the two touched source files → clean.
- (The "Rule '…' never fired across 30 runs" lines in the full-suite output are pre-existing
  property-planner warnings, unrelated to this change.)

## Known gaps — review focus (tests are a floor, not a finish line)

1. **The three new deferral branches are untested.** Only the `default` (non-anchor member) branch
   and the `unknown-view-column` guard have coverage. The `eav` and `unbacked` branches of
   `nonAnchorPredicateDiagnostic`, and the `refs.hasSubquery` subquery branch, have **no direct
   test** — their messages are unverified and reachability is unconfirmed. Worth adding: a WHERE
   filtering on an EAV-served column (use the EAV fixture in the same file), and a WHERE embedding
   a subquery, asserting the new case-specific messages. `unbacked` is genuinely rare (it must pass
   the `shape.columns` guard yet classify to `'unbacked'`) — confirm whether it's even reachable or
   just defensive.

2. **No multi-member × anchor-computed-WHERE interaction test.** All support cases use the
   *single-member* `nonIdentityAd` fixture. A DELETE that must fan out to **other** members while
   filtering on an anchor-computed column is not exercised. The mechanism should hold (each
   non-anchor member reads its identifying set from `select anchorKey from anchor where <pred>`,
   and the substituted pred is anchor-scoped), but it is untested in combination — a reviewer
   wanting confidence could build a fixture with a computed anchor column **plus** a mandatory
   non-anchor member and DELETE on the computed column.

3. **The basis-on-anchor invariant is assumed, not checked.** The gate admits any
   `computed-mapping` whose `member` is the anchor without verifying the substituted expression
   only names anchor base columns. For a faithfully-synthesized decomposition body this is always
   true, but if a future advertisement could put a computed mapping on the anchor whose basis
   references a *non-anchor* relation, the gate would wrongly admit it. Consider whether this is
   worth an assertion or is adequately guaranteed upstream by the advertisement validator.

4. **Store path not exercised.** Only the default memory-backed suite ran (`yarn test:store` not
   run, per agent-runnable guidance). The predicate substitution is AST construction consumed by
   the anchor subquery (path-agnostic), so store behavior should match, but it was not verified
   here.

## Docs updated

- `docs/lens.md` — the predicate-gate prose ("anchor-resolvable predicate gate"), a new sentence
  spelling out what "anchor-resolvable" admits, and the Pending list (genuine non-anchor / EAV /
  subquery, each with its own accurate message).
- `docs/view-updateability.md` — the `backward-body.ts` and `decomposition.ts` bullets:
  "anchor-resolvable predicate gate", the **Landed** DELETE note, and the **Still deferred** clause
  (now "genuine non-anchor-member / EAV-pivot / embedded-subquery predicate", each a distinct case
  under the shared reason code).
