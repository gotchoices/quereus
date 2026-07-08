description: When parsing fails, the parser used to sometimes discard a precise, already-typed error and replace it with a vaguer one; fixed so typed engine errors always propagate with their original detail and location.
files:
  - packages/quereus/src/parser/parser.ts (parseAll catch block, ~line 108)
  - packages/quereus/test/parser.spec.ts (Error Handling describe block, ~line 300)
difficulty: easy
----

## What changed

`parseAll`'s catch block (`packages/quereus/src/parser/parser.ts`) recognized an
already-typed engine error by comparing `e.name === 'QuereusError'`. Every
`QuereusError` subclass overrides `name` in its constructor (e.g. `ParseError`
sets `name = 'ParseError'`), so the string comparison only matched the base
class, never a subclass. A thrown `ParseError` — which already carries precise
source location — fell through to the "unexpected error" branch, got logged as
an unhandled parser error, and was rewrapped into a brand-new `QuereusError`
that lost the subclass identity (though it did retain a location if the
subclass had one, via `cause`).

Fix: replaced the name-string check with `e instanceof QuereusError` (import
already present). Now any `QuereusError` or subclass — `ParseError`,
`ConstraintError`, `AbortError`, `MisuseError`, etc. — thrown inside
`statement()` propagates unchanged; only genuinely foreign exceptions
(non-`QuereusError`) get wrapped.

## Scope note

Most parser error sites don't actually throw the `ParseError` subclass — they
call the `quereusError()` helper (via `this.error(...)`), which throws a plain
base `QuereusError`. Those were already recognized by the old buggy check
(base class `name` really is `'QuereusError'`), so this bug was latent rather
than affecting every syntax error. The one call site that throws `ParseError`
directly is the `rename_policy` option validator inside `applySchemaStatement`
(parser.ts ~3979, `APPLY SCHEMA ... OPTIONS (rename_policy = '...')`). That is
the site exercised by the new regression test, since it's the cleanest
reproducible case of a subclass instance hitting this catch block.

Grepped the rest of the package for `e.name === 'QuereusError'` / similar
string comparisons — no other call site relies on the old (buggy) rewrap
behavior.

## Testing

Added `packages/quereus/test/parser.spec.ts` → `Parser > Error Handling >
'should propagate a typed ParseError unchanged, preserving subclass and
location'`. Parses `apply schema temp options (rename_policy = 'bogus')`,
asserts the thrown error `instanceof ParseError` with populated `line`/`column`
and a message containing `'Unknown rename_policy'`. Verified this test fails
against the pre-fix code path (name-string check lets the ParseError fall
through and get rewrapped as a base `QuereusError`, failing the `instanceof
ParseError` assertion) and passes after the fix.

Full validation run:
- `yarn test` (packages/quereus) — 6464 passing, 9 pending, no failures.
- `yarn lint` (packages/quereus) — clean, no output.

## Gaps / things the reviewer should double check

- Only one call site was available to exercise the `ParseError` subclass path
  directly; didn't add a second subclass (e.g. hand-throwing a
  `ConstraintError` mid-parse) since none of the real parser code paths do
  that today — the existing test is a faithful reproduction of the reported
  bug, not a synthetic one, but it is narrow.
- Did not touch the `quereusError()` / `this.error()` majority path — those
  already behaved correctly before this fix and are unchanged.
