description: A foreign key whose child column and parent key column declare different explicit collations only fails when the synthesized parent-lookup comparison is planned (first DML against the child). Detect the conflict at CREATE TABLE / ALTER time instead, where the schema relationship is declared.
files:
  - packages/quereus/src/schema/manager.ts                    # FK resolution during table build
  - packages/quereus/src/planner/analysis/comparison-collation.ts
----

With the comparison-collation lattice landed (ticket
`comparison-collation-provenance-and-precedence`), `parent.k = NEW.ref` with
both columns carrying different explicitly-declared collations
(`collationExplicit`) is a plan-time ambiguous-collation error. For FK
enforcement that error surfaces at the first INSERT/UPDATE against the child
table — correct but late: the contradiction is fully visible in the schema at
declaration time.

Expected behavior: when resolving a REFERENCES clause (CREATE TABLE, ADD
COLUMN, ADD CONSTRAINT, declarative-schema diff apply), run the same
`resolveComparisonCollation` over the child column's and parent key column's
types and reject explicit/declared conflicts with a schema-level error naming
the FK, both columns, and both collations. Matching declared collations, or
one-sided declarations (defaulted other side), remain valid — the enforcement
comparison resolves cleanly for those.

Considerations:
- The check must use the same lattice helper, not a re-derived rule, to stay
  in lockstep with what enforcement would actually do.
- Declarative schema (schema-differ) and the store module's PK-collation
  reconcile both adjust collations after column build; validate against the
  post-reconcile schema to avoid false positives on implicit defaults.
