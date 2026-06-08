description: Fixed operator precedence table in ast-stringify to match parser — prevents round-trip semantic changes
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-precedence.spec.ts
----
## What was built

The `needsParens` precedence table in `ast-stringify.ts` was corrected to match the parser's actual operator hierarchy. Previously, equality and comparison operators shared the same level, and `||`/`XOR` were missing, causing `parse → stringify → parse` to produce semantically different ASTs.

### Key changes
- Precedence table now has 7 levels matching the parser: OR/XOR (1) → AND (2) → equality (3) → comparison (4) → add/sub (5) → mul/div/mod (6) → concatenation (7)
- `isAssociative()` includes XOR and `||`
- Removed stale NOT/IN/IS entries (these use dedicated AST node types, not binary)

## Testing
14 round-trip tests in `emit-precedence.spec.ts` covering:
- Equality vs comparison separation (`(a = b) < c` preserves parens)
- Concatenation operator (`(a + b) || c` preserves parens; `a || b || c` drops them)
- XOR (`(a xor b) and c` preserves parens)
- Full low→high and high→low mixed chains
- Right-associativity: non-associative ops (`a - (b - c)`) preserve parens; associative ops (`a + b + c`) don't

All 927 tests pass. TypeScript types clean.

## Notes
- `GLOB`, `MATCH`, `REGEXP` are in the precedence table but not yet implemented in the parser — harmless forward-compatibility entries.
