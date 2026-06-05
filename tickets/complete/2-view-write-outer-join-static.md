description: Outer-join (LEFT) write-through admission into the multi-source substrate for the statically-expressible cases — preserved-side update passthrough, delete-to-preserved, and insert routing (both-side / preserved-only / presence-gated non-preserved member). Non-preserved UPDATE defers (`unsupported-outer-join-update`); non-preserved-only insert rejects (`null-extended-create-conflict`); FULL is rejected wholesale. Static `view_info`/`column_info` relaxed to per-side. RIGHT excluded at review (runtime cannot execute it).
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/mutation-diagnostic.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/func/builtins/schema.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/06.3.4-view-info.sqllogic, packages/quereus/test/logic/06.3.5-column-info.sqllogic, docs/view-updateability.md
----

## What landed (implement stage — commit a6878d22)

`collectInnerJoinSources` → `collectJoinSources`: outer-join bodies admitted at recognition, sides tagged preserved/non-preserved (+ enclosing ON `guard`). Output columns carry `nullExtended`. Per-op routing:

- **UPDATE** — preserved-side column → ordinary base update; non-preserved (`nullExtended`) base column → reject `unsupported-outer-join-update` (before the generic `no-inverse`).
- **DELETE** — candidate set defaults to `preservedSideIndices` (inner = all-preserved ⇒ unchanged); FULL (no preserved side) → reject.
- **INSERT** — active sides = preserved ∪ non-preserved-with-supplied-columns; non-preserved active side presence-gated per row (`buildPresenceGate`); shared key minted/threaded only when ≥2 active sides; new rejects `null-extended-create-conflict` (non-preserved-only) and `unsupported-join` (FULL).
- **Static surfaces** — `baseSiteOf` reports `nullExtended`; per-column updatability (preserved YES / non-preserved NO); deletability + insertability over preserved targets only; no-preserved-target body → conservative.

Two diagnostic reasons added (`mutation-diagnostic.ts`). Tests: property.spec LEFT-join round-trip + flipped `reject-do-not-widen`; `93.4` outer-join end-to-end; `06.3.4`/`06.3.5` Divergence-2 rewrite.

## Review findings

Implement diff reviewed fresh (commit a6878d22) before reading the handoff. Validation re-run after review edits: **`yarn workspace @quereus/quereus test` → 4626 passing, 9 pending, 0 failing**; **lint → clean (exit 0)**; **`tsc --noEmit` → clean**. Probed RIGHT-join write-through dynamically (scratch sqllogic, since the implementer flagged it as untested) — that probe surfaced the major finding below. `test:store` not run (planner/mutation + static-introspection only; no storage path touched — consistent with the implementer's rationale).

### MAJOR — RIGHT-join views falsely advertised as writable (FIXED inline + follow-up ticket filed)

The recognition admitted `right` joins, classifying preserved/non-preserved as the mirror of LEFT. But **the Quereus runtime cannot execute a RIGHT join at all** — `runtime/emit/join.ts:47` throws `RIGHT JOIN is not supported yet`, **pinned by `test/logic/90.5-unsupported-join-types.sqllogic`**, and there is no RIGHT→LEFT planner normalization (the commute rule only handles inner/cross). Consequence: `view_info('oj_right')` / `column_info('oj_right')` reported `is_updatable`/`is_insertable_into`/`is_deletable` = YES (and the `06.3.4` test *asserted* this), yet **not even a `select * from oj_right` succeeds** — it throws. The implementer assumed RIGHT worked "by symmetry" and never drove it dynamically.

**Fixed in this pass:** excluded `right` from write-through recognition (`collectJoinSources` + `isDecomposableJoinBody` now accept only `inner`/`left`/`full`; removed the dead `case 'right'` recursion). A RIGHT-join view now reports conservative all-`NO` (via the existing `isJoinBody && !isDecomposableJoinBody` shape gate) and a write through it rejects cleanly at plan time (`unsupported-join`, "cannot write through view") instead of throwing a runtime error. FULL was already correct (no preserved side ⇒ self-conservatizes); left untouched so its precise diagnostics stay live. Reverted the `06.3.4` `oj_right` row to conservative and added a dynamic RIGHT-write reject assertion. Updated all "inner/left/right/full" scope comments in `multi-source.ts` + `schema.ts` and the `docs/view-updateability.md` § Outer Joins / § Current limitations notes to state RIGHT is excluded pending runtime support.

**Follow-up filed:** `tickets/backlog/outer-join-right-full-runtime.md` — implement runtime RIGHT/FULL execution (or planner RIGHT→LEFT normalization), then re-admit RIGHT into write-through + flip the static surfaces back to per-side. (Code/test comments reference its slug.)

### MAJOR — dangling minted shared key on a per-row-absent non-preserved INSERT value (ticket filed)

A both-side insert where the non-preserved side is *statically* active (its column is in the insert list) but a *given row's* value is null: the non-preserved side's per-row presence gate drops its insert, while the preserved side **unconditionally** threads the minted shared key into its join (FK) column — leaving a preserved row pointing at a surrogate with no partner row. Masked with FK off (reads back null-extended) but a dangling FK with enforcement on, and a latent spooky-join if that key is later materialized. Reachable by a single-row `values (k, v, null)`, not just multi-row. The implementer documented this as a known gap and explicitly asked the reviewer to decide. Disposition: real data-integrity bug; the fix (per-row conditional key thread, `<joinKey> = case when <present> then <key> else null`) is build-layer work distinct from the runtime-capture substrate of `view-write-optional-member-transitions`, so it is **out of scope for an inline review fix**. Filed `tickets/fix/view-write-outer-insert-dangling-key.md`.

### MINOR — observed, not fixed (low value / by design)

- `chooseDeleteSides`: with the candidate set now defaulting to preserved-only, a `delete_via = 'parent'` (or any tag picking the non-preserved side) on a LEFT-join view raises `tag-conflict` with the message "…but a 'target'/'exclude' tag excludes it" — misleading when no such tag was set (it is the preserved-only default that excludes it). Cosmetic; `delete_via` through an outer join is an untested edge. Left as-is to avoid perturbing the message path shared with inner-join deletes.
- `view_info.is_insertable_into = YES` for a LEFT view reflects **preserved-only** insertability (always works); a *both-side* insert can still fail at runtime if the non-preserved side has an uncovered not-null-without-default column. This is the implementer's documented "gated at runtime" choice and is internally consistent (the view *is* insertable via the preserved-only path).

### Checked and clean (explicit)

- **INSERT analysis ordering** — FULL short-circuit (`hasPreservedSide`) precedes `null-extended-create-conflict` precedes `suppliedKeys.length > 1`; `needsSharedKey` (≥2 active) correctly suppresses key minting for the preserved-only insert; `orderSides(sides).find(isActive)!` is non-null whenever `needsSharedKey` holds. No regression for the inner-join supplied-set change (`writable && !inverse` ≡ the new base-routed filter for non-null-extended bodies).
- **`baseSiteOf` null-extended unwrap** — preserved → trace + YES; non-preserved → NO with null trace (verified against the `06.3.5` assertion); FULL → all columns NO via `unsupportedJoinShape`/null-extended.
- **`buildMultiSourceInsert` presence gate** — reuses `buildPresenceGate`/`FilterNode` exactly as the decomposition fan-out (`buildDecompositionMemberInsert`); fresh `EnvelopeScanNode` per side; gate wraps the scan before projection. DRY, consistent.
- **Cross-source `set` through outer join** now rejects `no-inverse` (a non-preserved partner read is not recoverable from a captured base column) — a more precise reject than the old `unsupported-join`, confirmed intentional.
- **Type safety / resource cleanup / error handling** — no `any` introduced; diagnostics thrown (not swallowed); the static-surface TVFs retain their per-view conservative try/catch fallback. Lint + typecheck clean.
- **Docs** — read every touched file; `docs/view-updateability.md` § Outer Joins + § Current limitations + the diagnostic-reason table reflect the shipped LEFT scope and the RIGHT/FULL runtime gate after this pass.

## Follow-up tickets created

- `tickets/fix/view-write-outer-insert-dangling-key.md` — per-row conditional shared-key thread for the both-side outer insert (data-integrity).
- `tickets/backlog/outer-join-right-full-runtime.md` — runtime RIGHT/FULL execution, then re-admit RIGHT into write-through + surfaces.
