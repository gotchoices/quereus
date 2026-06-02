description: Review the extension of the View Round-Trip Law property harness (`test/property.spec.ts`) from single-source Tier A to Family B (multi-source key-preserving inner join) and Family C (n-way decomposition fan-out, advertisement-driven via `quereus.lens.decomp.*` tags). This is the acceptance gate the derived-backward-walk migration is checked against. Verify the laws genuinely red on backward-walk bugs (not just on oracle mismatches), and probe the gaps flagged below.
files: packages/quereus/test/property.spec.ts, docs/view-updateability.md, docs/lens.md, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/mapping-advertisement-tags.ts
----

## What shipped

All work is in the existing `describe('View Round-Trip Laws')` block of
`packages/quereus/test/property.spec.ts`. The three laws (PutGet / GetPut /
forward-backward lineage agreement) are now asserted across three families, each with
a pure law core reused from Tier A (`assertRowsEqual`, `assertLineageAgreement`,
`assertPlanLineageAgreement`) plus a per-family negative self-test. A new describe-level
helper `expectMutationReject(sql, reason)` asserts the *structured* diagnostic fires.

**Family B — multi-source inner join** (`describe('multi-source inner join')`, extended):
- Existing PutGet property extended with an **`update-both`** op (child `cv` + parent `pv`
  in one statement — the both-sides identity-capture path).
- New `it`s: **insert with the shared key supplied directly** (no mint, threaded to both
  bases — property, 40 runs); **`delete_via=parent`** routing (deterministic); **reject-
  don't-widen + lineage agreement** (outer-join insert / self-join / `select *` /
  composite-PK → `unsupported-join`; cross-source `set` → `cross-source-assignment`; plus
  the static plan-lineage dual over the accepted inner join); **negative self-test**.

**Family C — decomposition fan-out** (`describe('decomposition fan-out')`, new). Fixtures
built purely from `quereus.lens.decomp.*` tags via `buildAdvertisementsFromTags` (no
custom module) + `declare logical schema … apply schema`:
- **PutGet (columnar + optional member)** — INSERT (anchor-first, one-per-member, optional
  per-row presence gate), UPDATE routed to the backing member (anchor `a`, mandatory `b`,
  both), anchor-last DELETE; cross-checks every member base image + the join view image.
- **GetPut (columnar)** — writes back the mandatory columns, asserts every member diff empty.
- **PutGet (EAV pivot)** — INSERT emits one triple per non-null attribute; DELETE clears the
  entity; cross-checks `E_core`, the `E_eav` triple store, and the view image.
- **PutGet (surrogate)** — asserts the minted `sid = max(anchor)+1` is threaded identically
  into every member's key (`Doc_core.sid == Doc_body.doc_sid`) and surfaces through the view.
- **Lineage agreement** — the resolved advertisement member map reconstructs every forward
  key of `select * from x.T` (forward key `id` is base-backed and equals the anchor shared key).
- **Reject-don't-widen** — `unsupported-decomposition-predicate` (non-anchor WHERE),
  `unsupported-decomposition-update` (optional / EAV / shared-key write), `no-default`
  (uuid7 surrogate), `unsupported-decomposition-key` (composite shared key).
- **Negative self-test**.

`checkedNodes`-style guards (`mutated`/`inserted`/`checked`/`opsSeen`) assert each family
exercised real work, mirroring Key Soundness Tier 2.

Docs updated: `docs/view-updateability.md` "Landed (Tier A)" → "Tier A + multi-source +
decomposition" with per-family detail; `docs/lens.md` write-path section points to Family C.

## Validation performed
- `node test-runner.mjs --grep "View Round-Trip Laws"` → **27 passing** (13 new).
- Full `node test-runner.mjs` → **4273 passing, 9 pending, exit 0** (no pre-existing failures).
- `eslint test/property.spec.ts` → clean.
- Diagnostic reason codes for every reject case were confirmed empirically against the engine
  (a throwaway scratch spec, since removed) before being pinned in the assertions.

## Known gaps / where the reviewer should push (tests are a floor, not a finish line)

1. **Negative self-tests prove the *comparison core* reds, not that a real backward-walk bug
   is caught end-to-end.** They feed a wrong oracle into `assertRowsEqual` and assert it throws
   (the Tier A discipline). They do *not* mutate the `decomposition.ts` / `multi-source.ts` `put`
   code and observe the law fail. A stronger pass would inject a deliberate fault into a fan-out
   arm (e.g. thread the wrong member key) and confirm a *PutGet* run reds. Worth a manual probe.
2. **Family C PutGet predicates are only on the logical PK `id`** (unique). Anchor *non-key*
   column predicates (`where a = K`) and the inner-join-hides-a-row case (a `T_core` row with no
   `T_b` row) are modeled by the oracle but **never generated** by the seeding (T_b is seeded for
   every T_core id). The "mandatory member missing ⇒ logical row invisible & untouched" path is
   therefore not dynamically exercised here.
3. **GetPut for Family C covers only mandatory columns** (anchor `a` + member `b`). Optional `c`
   and EAV columns are read-only through the decomposition (writes are deferred by design), so
   their write-back round-trip is necessarily out of scope — confirm that's acceptable.
4. **`delete_via` and the directly-supplied-key insert** are single-scenario (delete_via is
   deterministic; directly-supplied insert always inserts a fresh disjoint key). Neither fuzzes
   the collision/overlap edges.
5. **Surrogate PutGet inserts one logical row per run.** Multi-row per-row-distinct minting
   through the *decomposition* path is not exercised (the multi-source-join insert test does cover
   multi-row minting on its own path).
6. **Family C lineage agreement runs only over the columnar advertisement**, not the EAV/surrogate
   advertisements (those are covered behaviorally by PutGet, not by the structural lineage check).
7. **Both-sides Family B update is predicated on the child PK only.** The predicate-clash variant
   (predicate on a parent column) is covered by its own dedicated ticket/test, not re-fuzzed here.

## Out of scope (per ticket)
Voigtländer-style auto-derivation of `put` from `get` — the deferred north-star. This harness is
the soundness net that makes that later refactor safe; it does not implement it.
