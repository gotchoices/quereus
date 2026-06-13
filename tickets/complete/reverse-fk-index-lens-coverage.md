description: Lens basis-FK gate — a derived, event-invalidated Set on SchemaManager (basis schema.table keys backing ≥1 logical-FK-referenced parent slot) that O(1) short-circuits the three basis-keyed lens FK paths (cascade walker, RESTRICT pre-check, divergent-basis suppression). The logical-FK analogue of the physical reverse-FK index.
files:
  - packages/quereus/src/schema/manager.ts                    # lensFkGate cache + invalidateLensFkGate() + basisTableBacksLogicalParentFk(); listener + addSchema/getOrCreateSchema/removeSchema/clearAll/importTable invalidation
  - packages/quereus/src/schema/lens-fk-discovery.ts          # buildLensBasisFkGate(); basisFksOverriddenByDivergentLensFk gated at entry
  - packages/quereus/src/runtime/foreign-key-actions.ts       # executeLensForeignKeyActions + assertLensRestrictsForParentMutation gated at entry
  - packages/quereus/src/schema/lens-compiler.ts              # deployLogicalSchema invalidates the gate after clear-and-rebuild
  - packages/quereus/test/lens-enforcement.spec.ts            # describe('lens enforcement: basis-FK gate short-circuit') — now 6 cases
  - docs/schema.md                                            # § Lens basis-FK gate
----

# Complete: Lens basis-FK gate (logical-FK analogue of the reverse-FK index)

A derived, event-invalidated `Set<string>` (`lensFkGate`) on `SchemaManager` holding the basis
`schema.table` keys (lowercased) that back ≥1 logical parent slot referenced by ≥1 logical FK.
`basisTableBacksLogicalParentFk(schema, table)` lazily builds it via `buildLensBasisFkGate` and answers
in O(1). The three basis-keyed lens FK paths early-return on a gate miss instead of running the
per-write `for (schema) for (slot) { resolveSlotBasisSource… }` reverse-map scan:

- `executeLensForeignKeyActions` (runtime cascade walker)
- `assertLensRestrictsForParentMutation` (runtime RESTRICT pre-check)
- `basisFksOverriddenByDivergentLensFk` (divergent-basis suppression set)

On a gate hit each function's original scan body is unchanged.

## Review findings

Adversarial pass over the implement-stage diff (`1a2a335d`), read before the handoff. Scrutinized for
soundness (never under-reports), invalidation exhaustiveness, byte-for-byte behavior preservation on a
hit, contract equivalence of the early-returns, type safety, and test coverage.

### Soundness — never under-reports (the load-bearing claim): VERIFIED by construction
The gate build (`buildLensBasisFkGate`, `lens-fk-discovery.ts:291`) uses the **identical** matching
predicate as all three consuming paths: `resolveSlotBasisSource(slot)` + lowercased `name`/`schemaName`
match + `findLogicalParentFkRefs(slot).length > 0`. Confirmed line-by-line that the runtime scan bodies
(`foreign-key-actions.ts:534`, `:769`) and `basisFksOverriddenByDivergentLensFk` (`lens-fk-discovery.ts:367`)
each match a slot under exactly the same condition the build keys on. Therefore `gate.has(key)` is true
iff the full scan for that basis parent would find ≥1 actionable slot — no key-mismatch under-report.
The gate key derives from `resolveSlotBasisSource(...).schemaName/name`; the runtime query uses
`basisParentTable.schemaName/name`; these are the same canonical `TableSchema` fields the scan itself
compares, so the gate cannot disagree with the scan it fronts.

### Invalidation exhaustiveness: VERIFIED
Two dependencies, both fully covered:
- **Lens-slot set** — `find_references(.addLensSlot(|.clearLensSlots(|.removeLensSlot()` confirms the
  ONLY slot-mutating sites are `deployLogicalSchema` (clear+add), `removeSchema` (clearLensSlots), and
  `clearAll` (clearLensSlots); there are **zero** `removeLensSlot` call sites in `src/`. All three
  invalidate the gate (`deployLogicalSchema` directly; `removeSchema`/`clearAll` directly).
- **Basis-table catalog** — `resolveSlotBasisSource` → `resolveSingleBasisSource` resolves a bare name
  live via `getSchema(name)?.getTable(name)` (`lens-prover.ts:329`), so the result changes on
  `table_added`/`table_modified`/`table_removed` (constructor listener) and on schema attach/detach/reset
  + silent `importTable`. All wired, mirroring the proven reverse-FK-index discipline on the same listener
  and the same methods.

### Behavior preservation on a gate hit: VERIFIED
Each function gained only a leading O(1) early-return; the scan bodies are byte-for-byte unchanged. The
`basisFksOverriddenByDivergentLensFk` early-return `new Set()` is contract-equivalent — a gate miss ⟺ the
scan returns the empty set, and all callers (`foreign-key-builder.ts`, `foreign-key-actions.ts`) use only
`.has(fk)` / `.size`, both valid on an empty `Set`.

### Tests: extended (minor — fixed inline)
The implementer's 5 cases pin gate miss (two shapes), a gate-hit **cascade**, the deploy under-report
regression, and redeploy invalidation. They did **not** pin the gate's **action-agnostic** claim on the
RESTRICT path (a slot referenced only by a RESTRICT logical FK must be a hit, and the RESTRICT pre-check
must still abort). Added `gate hit — action-agnostic: a RESTRICT-only logical FK is a hit and the
RESTRICT pre-check still aborts` to close it. Suite now 6 cases.

### Out-of-scope touch flagged by implementer: ACCEPTED
`clearAll` now also nulls `reverseFkIndex` (previously nulled neither cache). A stale-after-`clearAll`
reverse-FK index would only over-report (harmless), but the reset is correct and symmetric; full suite
green confirms nothing relied on the old behavior. No action needed.

### Gaps assessed and intentionally NOT closed (no major findings → no new tickets)
- **table_added / silent `importTable` late-basis-creation vector — untested, judged acceptable.** A lens
  slot cannot deploy unless its basis already exists, and `deployLogicalSchema` always invalidates the
  gate; the only post-deploy basis-catalog change (drop-then-recreate a basis under a live lens) fires
  `table_removed`/`table_added`, which the constructor listener catches. The vector is thus hard to reach
  in valid SQL and is masked by deploy-invalidation, so a dedicated test would be brittle and low-signal.
  The invalidation is wired on the exact same listener + methods as the reverse-FK index, which already
  carries the analogous silent-import regression. Belt-and-suspenders only.
- **Cross-schema (third-schema basis parent) — not added.** The mechanism is schema-agnostic and keys
  identically; the existing cascade/divergent suites are already two-schema (basis `y`, logical `x`), so
  the basis-schema-vs-logical-schema split is exercised. A third-schema variant is low value.
- **Doc-link form divergence — accepted house style.** `foreign-key-actions.ts` references the gate as a
  backticked `SchemaManager.basisTableBacksLogicalParentFk` (the type is not imported there);
  `lens-fk-discovery.ts` uses `{@link …}` (it imports the type). Consistent with the rest of the codebase.
- **Pre-existing unused param `parentTable` in `executeSingleFKAction` — out of scope, untouched, not
  eslint-flagged.** Not addressed (correctly).

### Docs: VERIFIED
`docs/schema.md` § Lens basis-FK gate accurately describes the build predicate, both invalidation
dependencies, every invalidation point, and the sharper-than-the-index soundness invariant. Matches the
code as landed.

### Validation
- `yarn workspace @quereus/quereus run lint` — exit 0 (eslint clean + `tsc -p tsconfig.test.json` clean,
  including the new spec call site).
- `yarn workspace @quereus/quereus test` — **6138 passing, 9 pending, exit 0** (was 6137; +1 the new
  RESTRICT gate-hit case). The pre-existing cascade/RESTRICT/divergent suites stayed green.

**Disposition:** No major findings. One minor gap (missing RESTRICT-path gate-hit test) fixed inline.
Implementation is sound and ready.
