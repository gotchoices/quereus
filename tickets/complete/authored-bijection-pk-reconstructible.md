description: COMPLETE — a PK over a proven-bijective authored (`with inverse`) column is now key-reconstructible and deploys WRITABLE, classifying `proved` by bijection transport onto a declared basis key. Non-injective (lossy) and no-basis-key cases stay read-only / commit-time. Reviewed: implementation sound (incl. the NOT NULL soundness gate the implementer added), composite-key path verified and pinned, 4 stale function-name references fixed inline, store text-PK NOCASE divergence filed to backlog. Build + lint + full memory suite (6237 passing) green.
files:
  - packages/quereus/src/schema/lens-prover.ts            # analyzeRoundTrip/bijectiveAuthoredColumns/emitRoundTrip split; emitAuthoredInverseDiagnostics; checkKeyReconstructibility(bijectiveAuthored); proveKeyByBijectionTransport + authoredPutTargetBasisColumn
  - packages/quereus/src/schema/table.ts                  # columnsFormDeclaredKey shared helper (doc ref fixed)
  - packages/quereus/src/schema/lens-compiler.ts          # indicesFormDeclaredUnique removed → columnsFormDeclaredKey
  - packages/quereus/src/planner/analysis/view-complement.ts  # stale proveRoundTrip doc ref fixed
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic  # scenarios 18 (proved/writable) + 19 (commit-time/no-basis-key)
  - packages/quereus/test/lens-prover.spec.ts             # 3 implementer pins + NEW composite-PK transport pin
  - packages/quereus/test/lens-fd-contribution.spec.ts    # 2 pins (unconditional FD vs none)
  - packages/quereus/test/lens-put-fanout.spec.ts         # stale indicesFormDeclaredUnique comment fixed
  - packages/quereus/test/property.spec.ts                # stale proveRoundTrip comment fixed
  - docs/lens.md, docs/view-updateability.md              # reconstructibility + bijection-transport notes; stale ref fixed

# COMPLETE: PK over a proven-bijective authored inverse → writable

## What shipped

A logical PK column written through an authored (`with inverse`) put is a *computed*
projection (`upper(code) as grp`) that previously failed the bare-column
reconstructibility test, deploying the table **read-only**. Now, when the round-trip
enumeration has already proved the forward/inverse pair a **bijection** (the same
`{kind:'proved', injective:true}` verdict that suppresses `lens.getput-lossy`), that
PK column is **key-reconstructible** and the table deploys **writable**. The key
classifies **`proved`** (zero runtime enforcement, unconditional key FD) by
**bijection transport** — each key column maps to its single put-target basis column,
and those basis columns must exactly form a declared basis key.

Mechanically: `proveLens` runs the round-trip enumeration once up front
(`analyzeRoundTrip`), `bijectiveAuthoredColumns` derives the proved-bijective set,
and both `checkKeyReconstructibility` and `proveKeyByBijectionTransport` consume it.
`emitRoundTrip`/`emitAuthoredInverseDiagnostics` were split out as the diagnostic
half over the cached enumeration. `columnsFormDeclaredKey` was lifted to
`schema/table.ts` as the single source for "do these columns form a declared
whole-table key", shared with the decomposition compiler.

The non-injective (lossy) authored PK and the computed/opaque PK stay read-only,
unchanged; a bijective authored key whose put-target is not a basis key stays
writable but enforces **commit-time** (`lens.no-backing-index`), not proved.

## Review findings

Reviewed the full implement diff (883b3aa4) with fresh eyes, then the handoff, across
SPP/DRY/modularity/soundness/type-safety/resource-cleanup/docs/test-coverage.

**Correctness & soundness — checked, no defects.**
- The implementer's headline deviation (the transport `proved` shortcut additionally
  requires every key column be declared **NOT NULL**) is **correct and is the safe
  direction**. A nullable bare column over a NULL-skipping basis UNIQUE is only
  *conditionally* unique; promoting it to an unconditional `proved` FD would let the
  optimizer drop rows in DISTINCT/join-elim. The gate under-claims (PK columns are
  always NOT NULL, so the headline case is unaffected); it does not over-restrict any
  intended case.
- The `proved` → unconditional `key → others` FD contribution
  (`assertedFdForObligation`) is gated strictly on the obligation kind, and the
  bijection-transport `proved` is genuinely intrinsically unique (injective forward +
  basis key forbids collision over a 1:1 single-source projection). Sound.
- `proveForwardInjective` requires a NOT-NULL basis column with an enumerable CHECK
  domain, checks inverse images land inside the basis domain, and bails when the
  basis module `permitsGrandfatheredCheckViolators` — so grandfathered CHECK
  violators cannot witness a false bijection. Sound.
- Degrade-to-safe (out-of-fragment / join body) yields an empty bijection set ⇒
  authored computed PK stays read-only. Intentional gap, preserved.

**Test coverage — one gap found and fixed inline (minor).**
- The implementer's pins covered only **single-column** authored PKs. The
  product-of-injections soundness for a **composite** key (bare passthrough column +
  bijective-authored column → declared basis composite key) was unverified. Added
  `lens prover: … COMPOSITE PK …` to `lens-prover.spec.ts`; it classifies `proved`
  with no advisories, confirming the per-column-injective product transports onto a
  multi-column basis key (also the only spec exercising `columnsFormDeclaredKey` over
  a >1-column set). Passes.

**Stale references — 4 found and fixed inline (minor).** All comment/doc references
to functions this work renamed/removed:
- `src/schema/table.ts` — the new `columnsFormDeclaredKey` doc referenced
  `lens-compiler.ts indicesFormDeclaredUnique`, which **the same commit removed**
  (self-contradicting). → now names `validatePrimaryAdvertisement` /
  `proveKeyByBijectionTransport`.
- `src/planner/analysis/view-complement.ts`, `test/property.spec.ts` — `proveRoundTrip`
  → `analyzeRoundTrip` / `emitRoundTrip`.
- `test/lens-put-fanout.spec.ts` — `indicesFormDeclaredUnique` → `columnsFormDeclaredKey`.
- `docs/view-updateability.md` — `proveRoundTrip` consumer ref updated.

**Docs — checked, accurate.** `docs/lens.md` (§ reconstructibility, § round-trip, §
Constraint Attachment bijection-transport) reflect the new reality. `docs/sql.md`
per-column writability and `docs/view-updateability.md` round-trip law harness remain
correct (no PK-read-only claim to stale).

**Major finding filed to backlog.** The store **single-column TEXT PK → NOCASE
collation default** (memory↔store divergence) the implementer flagged is a genuine
pre-existing inconsistency (root cause of the text authored-PK read-only-under-store
behaviour). Filed `tickets/backlog/store-single-col-text-pk-nocase-default.md` to
confirm/align. Not caused by this work; scenarios 18/19 correctly use INTEGER keys to
stay cross-backend consistent.

**No findings** in: resource cleanup (specs all `try/finally db.close()`), type safety
(no `any`; readonly types throughout), error handling (planner failures degrade to
safe, never crash deploy), DRY (`columnsFormDeclaredKey` extraction is a net
improvement).

## Validation (all green, post-review-edits)
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn lint` (eslint + tsc test typecheck) — exit 0.
- Full memory suite (`node test-runner.mjs`) — **6237 passing**, 9 pending (6236
  prior + the new composite pin).
- 55.5-lens-authored-inverse sqllogic — green under **memory AND
  `QUEREUS_TEST_STORE=true`**.
- Lens prover / FD-contribution / enforcement / round-trip property specs — green.

## Follow-up
- `tickets/backlog/store-single-col-text-pk-nocase-default.md` — confirm/align the
  store text-PK collation default.
