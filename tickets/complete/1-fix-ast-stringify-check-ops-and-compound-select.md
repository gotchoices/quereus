description: Completed — fixed two silent drops in `packages/quereus/src/emit/ast-stringify.ts` on the declarative-schema round-trip: CHECK `operations` list (issue #23) and compound-SELECT tail (issue #21).
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Summary of landed work

### `packages/quereus/src/emit/ast-stringify.ts`

- CHECK column-constraint arm now emits `on <op>[, <op>...]` (when
  `c.operations` is set) and appends `conflictToString(c.onConflict)`.
- CHECK table-constraint arm: same fix.
- Compound SELECT tail switched from reading the dead `stmt.union` /
  `stmt.unionAll` fields to the live `stmt.compound`. New helper
  `compoundOpToKeyword` maps all five op kinds (`union`, `unionAll`,
  `intersect`, `except`, `diff`) to SQL keywords. The switch is exhaustive
  (explicit `: string` return + every case returns), so adding a new op kind
  fails compilation.

### Tests added

- `packages/quereus/test/emit/ast-stringify.spec.ts` — 7 unit tests that walk
  the **post-reparse AST** (not just stringified output), exposing dropped
  fields the prior `emit-roundtrip.spec.ts` could not catch.
- 5 new schema blocks in
  `packages/quereus/test/logic/50-declarative-schema.sqllogic` — verbatim
  repros of #23 and #21, plus UNION (DISTINCT), INTERSECT, EXCEPT, and a
  cross-fix smoke (CHECK whose expression is itself a compound subquery).

## Review findings

### Validation performed

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean (covered by test run via ts-node ESM).
- `yarn workspace @quereus/quereus run test` — 3226 passing, 0 failures. Matches the implementer's reported count.
- Reviewed full diff of `cb9a7c67` cold (handoff read only after).
- Inspected parser grammar for both fixes: CHECK ops list (`parser.ts:3534-3544` and `:3617-3645`, plus `parseRowOpList` at `:3817`); compound SELECT (`parser.ts:587-606`).
- Confirmed `RowOp = 'insert' | 'update' | 'delete'` (`common/types.ts:161`) — safe to comma-join.
- Confirmed `compoundOpToKeyword`'s op-kind union matches the parser's: both pin to the same five-string union, so a future addition surfaces at both places.
- Verified the emitted form `A union all B union all C union all D` reparses back into a right-associative chain whose legs match in order (covered by the four-leg unit test).
- Confirmed inner-leg ORDER BY/LIMIT/OFFSET cannot leak (parser guards via `isCompoundSubquery`, see `parser.ts:629-672`).

### Findings — none requiring inline fixes

- **The UNION-DISTINCT regex check that initially looked weak is not.** The
  pair `expect(emitted).to.match(/\bunion\b/i)` + `expect(emitted).to.not.match(/\bunion\s+all\b/i)` together require "union" present AND "union all" absent — a sound check. (False-alarm noted and dismissed.)
- **CHECK `onConflict` round-trip** — newly emitted by the fix but not
  unit-tested. Risk is low because `conflictToString` is shared and exercised
  by the existing PK/UNIQUE/NOT-NULL/NULL arms in the same suite. Not worth a
  dedicated test in this pass.
- **`'diff'` compound op** — emitter mapping is one-line literal substitution
  alongside the other four ops. No unit/sqllogic coverage was added by the
  implementer; risk is low and a real semantics test belongs with whatever
  ticket originally defined `DIFF`. Out of scope for the round-trip fix.

### Findings — filed as separate tickets

- **`backlog/ast-visitor-compound-select-traversal.md`** (new). `traverseAst`
  in `packages/quereus/src/parser/visitor.ts:74` does not descend into
  `stmt.compound` — it still walks the long-dead `stmt.union` field only. This
  silently skips later legs in compound subqueries during CHECK/DEFAULT
  validation (`rejectIllegalReferences`, `validateCheckConstraintDeterminism`)
  and generated-column dependency extraction
  (`extractGeneratedColumnDependencies`). Pre-existing, but the cross-fix
  smoke test in this ticket newly exercises a CHECK whose expression IS a
  compound subquery, making the gap relevant. The corresponding sites in
  `rename-rewriter.ts` already handle both fields correctly — only `visitor.ts`
  is broken. Ticket includes test plan.

### Findings — explicitly NOT relevant to this fix

- **Declarative views in non-main schemas drop their schema prefix.** Surfaced
  while writing sqllogic; documented in the source file with a comment, and
  the four compound-view tests use `main` to side-step it. Separate
  pre-existing issue, not introduced by this ticket.
- **Dead `stmt.union` / `stmt.unionAll` fields on `SelectStmt`.** Removal is
  tracked by the visitor ticket above (once the visitor stops reading them).

### Coverage I considered and explicitly chose to skip

- **`deferrable` / `initially deferred` on CHECK** — the AST types carry these
  fields but the parser never populates them for CHECK (only for FK, see
  `parser.ts:3697-3717`; trailing comment at `:3892` documents
  "DEFERRABLE syntax not supported for CHECK constraints in Quereus").
  Emitting them would produce SQL that does not re-parse — the implementer's
  decision to leave them off is correct.
- **Compound-op precedence/associativity tests** — the implementer noted the
  parser is right-associative without operator precedence. The fix is purely
  about emission, not parsing. Behavior-level tests of associativity belong to
  the parser, not this ticket.

### Pre-existing failure flagged separately

- See `tickets/.pre-existing-error.md` — repo-wide `yarn test` halts on a
  TypeScript exhaustive-check failure in `packages/quereus-isolation/src/isolation-module.ts:564`. Unrelated to this fix; the quereus package's own tests run clean.
