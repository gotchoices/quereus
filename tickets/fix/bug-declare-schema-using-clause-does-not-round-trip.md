---
description: A declared table's `using <module>` clause, when the module takes no arguments, cannot round-trip through `declare schema` — the emitter writes the column body in parens right after the module name, and the parser reads that paren as the start of a module-argument list, not a column body, so re-parsing the emitted text fails. A second, narrower defect in the same area drops a trailing `using <module>` silently and can swallow the declaration's closing brace.
architecture: docs/sql-ddl.md#declaration-syntax
files:
  - packages/quereus/src/parser/parser.ts            # declareTableItem (~3781-3816): after `using <module>`, unconditionally treats a following `(` as module-argument syntax — no lookahead to tell it apart from a parenthesized, arg-less column body
  - packages/quereus/src/emit/ast-stringify.ts        # declaredTableToString (~1448), tableBodyDefsToString (~1853), moduleClauseToString (~1860): the body is always emitted in parens, with nothing to force braces when a module name would make parens ambiguous
  - packages/quereus/src/emit/ast-stringify.ts        # declareItemToString (~1436-1443): the `declareIgnored` fallback returns `it.text || '-- ignored'`, a line comment — on the single-line output this emitter produces, that comments out everything after it, including the closing `}`
  - packages/quereus/test/emit-roundtrip-property.spec.ts  # declaredTableInnerArb (~690-705): never generates a `moduleName`/`moduleArgs` on a declared table, so the existing AST round-trip property test cannot see either defect
repro: verified
---

# Declared table's `using <module>` clause does not round-trip

Filed from the SiteCAD board while implementing `scenario`'s schema (`packages/site-cad/src/lib/db/schemas/scenario-fragments.ts`); SiteCAD does not re-parse its own emitted declarations today, so nothing there is broken, but anything that round-trips a declaration through `astToString` will hit this.

## What happens

**1. `using <module>` with no arguments, body in parens — fails to re-parse.**

```
in : declare schema s { table T using memory { id integer primary key, a text null } }
out: declare schema s { table T using memory (id integer primary key, a text null); }
```

Re-parsing the output fails: `Expected ')' after module arguments.` `declaredTableToString` joins `using memory` and the body straight together with a space; `tableBodyDefsToString` always wraps the body in parens, with no brace alternative. The parser (`declareTableItem`) is the other half of the ambiguity: right after `using <module>`, it unconditionally parses a following `(` as a module-argument list (string/number literals or `name = value` pairs) — it never looks ahead to tell a would-be argument list apart from a parenthesized, no-argument column body. So `using memory (id integer primary key, ...)` is read as "module `memory`, args `id`, `integer`, ...", which breaks on the first column definition that isn't a literal or a `name = value` pair.

The form with real arguments round-trips fine (`using memory (x = 1) { ... }`), because the argument list is consumed before the body is reached, and so does `table sessions (body) using memory` — the ordering in the grammar doc's own example — because there the body's parens come before `using`, so there's nothing to confuse them with. Only `using <module>` directly followed by an arg-less parenthesized body is ambiguous.

**2. A clause the parser silently drops, and an emitter line comment that swallows the rest of the output.**

```
in : declare schema s { table T ( id integer primary key ) using memory }
out: declare schema s { table T (id integer primary key); -- ignored; }
```

Two separate defects: the parser accepts `using memory` trailing after a parenthesized body in this position but drops it — the table is not attached to the module the author wrote — and whatever falls into the `declareIgnored` item type is re-emitted as a `-- ignored` line comment, which on this emitter's single-line output comments out the closing `}` along with everything else after it. SiteCAD's own declarations don't use this form, so it's lower-severity than case 1, but the swallowed brace means a declaration containing it can't emit anything useful.

## Reproduction

Against `@quereus/quereus` 4.20.3, using `parseAll` and `astToString` (`@quereus/quereus/emit`) — both cases above, verified.

Round-tripping every SiteCAD declaration (`scenario`, `dynamics`, `local`, `account`, `person`, `org`; physical and lens forms) found exactly one failure: `scenario` hits case 1 at `table EntityTag using memory {`. All the others happen not to combine `using <module>` with an arg-less body, so they round-trip clean.

## Why the existing round-trip property test didn't catch it

`test/emit-roundtrip-property.spec.ts` already generates `declaredTable` items and round-trips them through `parse → stringify → parse`, which is the right mechanism for this — but `declaredTableInnerArb` builds its `CreateTableStmt` with no `moduleName`/`moduleArgs` at all, so the generator's output space never includes a `using` clause on a declared table. Widening it to sometimes add a module name (with and without args) should turn this red immediately under the current emitter/parser, and should be the regression check once fixed.

## Proposed resolution

1. Fix the emitter: when `declaredTableToString` has a module name and no module args, emit the body in braces (parens are never ambiguous after a *bare* table name with no `using`, but are after one) — or, per the parser's actual contract, give the parser a real way to disambiguate so parens stay safe either way. The brace-only fix is the smaller, more local change; it doesn't touch the parser's existing module-argument grammar.
2. Fix `declareItemToString`'s `declareIgnored` fallback to not emit as a line comment on single-line output — block-comment it, or track what caused the ignore more precisely so it doesn't need a comment at all.
3. Widen `declaredTableInnerArb` to generate a `using <module>` clause (with and without args) so the property test's AST-round-trip coverage actually includes this shape going forward.
