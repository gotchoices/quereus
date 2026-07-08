description: When parsing fails, the parser used to sometimes discard a precise, already-typed error and replace it with a vaguer one; fixed so typed engine errors always propagate with their original detail and location.
files:
  - packages/quereus/src/parser/parser.ts (parseAll catch block, ~line 108)
  - packages/quereus/test/parser.spec.ts (Error Handling describe block, ~line 300)
difficulty: easy
----

## What changed

`parseAll`'s catch block (`packages/quereus/src/parser/parser.ts:108`) recognized
an already-typed engine error by comparing `e.name === 'QuereusError'`. Every
`QuereusError` subclass overrides `name` in its constructor (e.g. `ParseError`
sets `name = 'ParseError'`), so the string comparison only matched the base
class, never a subclass. A thrown `ParseError` — which already carries precise
source location — fell through to the "unexpected error" branch, got logged as
an unhandled parser error, and was rewrapped into a new base `QuereusError`,
losing subclass identity.

Fix: replaced the name-string check with `e instanceof QuereusError` (import
already present). Any `QuereusError` or subclass thrown inside `statement()`
now propagates unchanged; only genuinely foreign exceptions get wrapped.

## Review findings

Adversarial pass over implement commit `e645bac3`. Change is a one-line
`instanceof` swap plus one regression test.

**Correctness — verified, no issues.**
- `e instanceof QuereusError` is the right predicate. `quereusError()` helper
  (`common/errors.ts:134`) throws `new QuereusError` (base), and all subclasses
  extend `QuereusError`, so both base-thrown and subclass-thrown parser errors
  are recognized. Confirmed `instanceof` works across the prototype chain:
  subclasses call `Object.setPrototypeOf`; base uses native `class extends
  Error` (target ES2020+), and `errors.ts:178` already relies on the same
  `instanceof QuereusError` check in production.
- Wrapping branch still logs before throwing (`errorLog(...)` then
  `quereusError(...)`) — no silently-eaten exception. Compliant with AGENTS.md
  "don't eat exceptions silent".

**Behavior-change surface — checked, safe.** The only reversal vs. old code:
a `QuereusError` *subclass* (name ≠ `'QuereusError'`) is now re-thrown instead
of wrapped — exactly the fix. The theoretical opposite (a non-`QuereusError`
object with `name` manually set to `'QuereusError'`) would flip from re-thrown
to wrapped, but nothing in the codebase constructs such an object; not a
concern.

**Same-anti-pattern sweep — none found.** Grepped whole repo for
`.name === 'QuereusError'` / `name === 'ParseError'`: no matches. The remaining
`e.name === 'AbortError'` check (`errors.ts:112`) is intentional web-convention
matching for platform `DOMException`, not this bug.

**Tests.** Implementer's test (`parser.spec.ts:300`) is faithful (real
`rename_policy` validator site that throws `ParseError` directly), asserts
`instanceof ParseError` + populated `line`/`column` + message. Narrow but the
narrowness is inherent — it's the only real parser path that throws a subclass
instance today. No additional test warranted; a synthetic hand-thrown subclass
would test nothing the existing one doesn't.

**Docs.** Internal error-handling change, no public API or syntax change — no
doc file affected. Confirmed by reading the touched files; nothing stale.

**Disposition:** minor findings — none. No major tickets filed. No tripwires.

## Testing

- `yarn lint` (packages/quereus) — clean, exit 0.
- `yarn test` (packages/quereus) — 6464 passing, 9 pending, exit 0.
- Parser spec in isolation — 97 passing.
