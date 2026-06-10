description: First-class view insert-default construct — `create [materialized] view v (cols) as <body> insert defaults (col = expr, …)` — replacing the `quereus.update.default_for.<column>` reserved tag's behavior with a real language construct carrying AST `Expression` values (not re-parsed text). Behavior-preserving addition; the tag's removal lands in the chained `remove-view-default-for-tag`. Converted from blocked/view-ddl-reserved-tag-eager-validation per the human-approved de-tag reframe (2026-06-08).
files:
  - packages/quereus/src/parser/ast.ts                          # CreateViewStmt/CreateMaterializedViewStmt: add insertDefaults?: ReadonlyArray<{ column: string; expr: Expression }>
  - packages/quereus/src/parser/parser.ts                       # createViewStatement (~2685) / createMaterializedViewStatement (~2745) / declarative declareViewItem (~3534): trailing `insert defaults ( ident = expression , … )` clause
  - packages/quereus/src/schema/view.ts                         # ViewSchema / MaterializedViewSchema: insertDefaults field
  - packages/quereus/src/planner/building/create-view.ts        # buildCreateViewStmt — thread insertDefaults onto CreateViewNode
  - packages/quereus/src/planner/building/materialized-view.ts  # buildCreateMaterializedViewStmt — same, in lockstep
  - packages/quereus/src/runtime/emit/create-view.ts            # emitter copies onto ViewSchema (MV emitter same)
  - packages/quereus/src/planner/mutation/single-source.ts      # rewriteViewInsert ~737: consume schema field instead of readDefaultFor(tags); resolveDefaultForColumn unchanged
  - packages/quereus/src/func/builtins/schema.ts                # deriveViewInfo ~833-876: read the schema field for the `defaultable` set
  - packages/quereus/src/emit/ast-stringify.ts                  # createViewToString / declaredViewToString: render `insert defaults (…)`
  - packages/quereus/src/schema/ddl-generator.ts                # generateViewDDL / generateMaterializedViewDDL: lift schema field back to AST
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic     # ~1143-1159 tag-default cases → new syntax
  - packages/quereus/test/logic/06.3.4-view-info.sqllogic       # ~184-216 insertability-rescue cases → new syntax
----

# First-class view insert-default construct

## Background / chosen design

`quereus.update.default_for.<column>` is the last behavior-bearing reserved tag at the
`view-ddl` site: a TEXT SQL-expression string supplying an omitted-insert default during
view/MV write-through, consumed at step 5 of the insert-defaulting precedence chain
(`docs/view-updateability.md` §93: after user value / constant-FD / FD reconstruction / EC
propagation, before the base column's declared `default`). Carrying *semantics* as a tag
forced an unresolvable eager-vs-lazy validation-timing question (the original blocked
ticket); the human chose the **de-tag reframe**: replace the tag with a first-class
construct, after which no behavior-bearing tag remains at `view-ddl` and the timing question
dissolves. Precedent: the view-mutation routing tags were removed the same way
(`remove-update-routing-tag-surface`; see `reserved-tags.ts:13-16`).

**Chosen syntax — Option 2, the dedicated trailing clause** (over inline column-list
defaults), because the dominant real use targets a base column the view *projects away*
(`default_for.created` on a view that doesn't output `created`), which has no slot in the
view's rename-only output column list:

```sql
create view dfi_v (id, name) as select id, name from dfi
  insert defaults (created = epoch_ms('now'));
```

- Name-keyed exactly like the tag it replaces, so `resolveDefaultForColumn` and the
  `deriveViewInfo` reader only swap their source map — minimal blast radius.
- `CreateViewStmt.columns: string[]` stays untouched (arity/name readers, MV backing-shape
  derivation, differ column handling all unaffected).
- The value is a first-class `Expression` with a real `loc` — the
  `parseExpressionString(exprText)` lower-from-text disappears and diagnostics are sited.
- `insert` and `defaults` are existing keywords; the pairing is unambiguous after a complete
  body (parsed in the same trailing position as `with tags`).

## Semantics (unchanged from the tag)

- Evaluated per omitted-insert row at write-through, exactly as a base-column `default`;
  inherits base-column-default determinism rules (mutation-context envelope resolves
  non-deterministic values). No new determinism constraint.
- Target resolution via the existing `resolveDefaultForColumn` (`single-source.ts:664-678`):
  a base column the view projects away, or a `base`-lineage view column; unknown name is the
  existing hard sited diagnostic. Applied only when the column is not already supplied by the
  insert or a constant-FD pin.
- This ticket is **additive**: the tag keeps working until `remove-view-default-for-tag`
  deletes it. The schema-field reader takes precedence when both are present (document the
  precedence in the code; the overlap window is one ticket long).

## Edge cases & interactions

- **MV lockstep** — wire `CreateView` and `CreateMaterializedView` identically (same
  write-through spine: every MV is a single-source passthrough). Verify an MV insert-default
  on a projected-away source column is transparent to row-time backing maintenance
  (maintenance projects the *resulting source row*) with a write-through test.
- **Every `readDefaultFor` call site** must gain the schema-field read: grep confirms
  `single-source.ts` and `schema.ts` today, but trace the `ReservedTagMap` threading through
  `multi-source.ts` / `decomposition.ts` (outer-join null-extended creates and the join
  insert-default chain reference the same merged `req.tags`).
- **Declarative round-trip** — `declareViewItem` (parser) and `declaredViewToString`
  (stringify) must learn the clause alongside the direct path; the differ compares via these
  renderers, so a changed default expression is a view-modified diff (acceptable — it changes
  write-through behavior). Add a declarative-equivalence case.
- **Round-trip property** — the AST round-trip property suite (`emit-roundtrip-property`)
  must cover the new field (stringify → parse ≡).
- **Unresolvable-column conservatism** — `view_info.is_insertable_into` stays conservative
  for a default naming an unresolvable column (silently skipped in the info derivation; hard
  error at write), matching today's `dfi_v_typo` case.

## TODO

- AST: `insertDefaults?: ReadonlyArray<{ column: string; expr: Expression }>` on
  `CreateViewStmt` + `CreateMaterializedViewStmt`.
- Parser: trailing `insert defaults ( ident = expression , … )` in `createViewStatement`,
  `createMaterializedViewStatement`, and `declareViewItem`.
- Schema: `insertDefaults` field on `ViewSchema` + `MaterializedViewSchema`; thread through
  `CreateViewNode` / `CreateMaterializedViewNode` and both emitters.
- Stringify + DDL-generator round-trip (`createViewToString`, `declaredViewToString`,
  `generateViewDDL`, `generateMaterializedViewDDL`).
- Consumer swap: `rewriteViewInsert` reads the schema field (AST `Expression`, `cloneExpr`
  instead of `parseExpressionString`); `deriveViewInfo` reads the same field; tag fallback
  retained with documented precedence until the removal ticket.
- Rewrite `93.4-view-mutation.sqllogic` ~1143-1159 and `06.3.4-view-info.sqllogic` ~184-216
  to the new syntax (keep one tag-form case alive until the removal ticket flips it).
- New cases: MV insert-default write-through (incl. backing-maintenance transparency);
  declarative round-trip; sited error for an unknown default column.
- `yarn build`, lint, `yarn test` green.
- Docs: `docs/view-updateability.md` § Tags → add § View insert defaults (construct is
  primary; tag noted as deprecated-pending-removal); `docs/sql.md` §2.8/§2.9 syntax.
