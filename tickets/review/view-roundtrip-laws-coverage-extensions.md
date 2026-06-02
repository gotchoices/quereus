description: Review the four coverage extensions added to the View Round-Trip Law harness (`describe('View Round-Trip Laws')` in `packages/quereus/test/property.spec.ts`). These are TEST-ONLY changes — no engine code was touched. Each extension dynamically walks an already-supported (or already-rejected) put-path arm that the prior seeding modeled in its oracle but never generated, so a `view-mutation-derived-backward-walk` put-path regression on it would have passed the acceptance gate silently. All behaviors were confirmed empirically against the shipped engine before the oracles were written.
files: packages/quereus/test/property.spec.ts
prereq:
----

## What landed

Four coverage extensions, all in `packages/quereus/test/property.spec.ts` under
`describe('View Round-Trip Laws')`. Test-only; `git diff` touches no `src/`. Build
(`yarn typecheck`), lint (`yarn lint`), and the full `property.spec.ts` (84 passing,
0 failing) are all green.

### Family C — `describe('decomposition fan-out')`

1. **`PutGet (columnar, missing member)`** — the invisible-row arm. The existing
   columnar PutGet seeds `T_b` for *every* `T_core` id, so `expView`'s
   `.filter(id => bMap.has(id))` is a no-op and the per-member-independent oracle is
   indistinguishable from the old `if (core.has(K))` oracle. The new test seeds some
   `T_core` rows with **no** `T_b` row (via a `hasB` arb) so the logical row is
   invisible through the inner `core ⋈ b` join, and asserts:
   - a `set b` to the **absent** member never materializes it (the member UPDATE's
     `where id in (...)` matches nothing);
   - the **anchor** is still routed by the bare anchor predicate even for an invisible
     row (decomposition fans out by predicate, not join visibility), so `set a` lands
     on `T_core` — but the row stays invisible, so the view image never widens;
   - the oracle is now **per-member-independent** (each member mutates iff its own row
     is present), which is the behavioral distinction the all-present seeding masked.
   - Also exercises an **anchor non-key column predicate** (`where a = K`, a
     non-unique anchor column), not only the unique logical PK `id`.

2. **`PutGet (surrogate, multi-row)`** — per-row-distinct minting through the
   decomposition fan-out. The single-row surrogate test inserts exactly one logical
   row per run. This inserts 2–4 logical rows in **one** statement (distinct fresh
   `docKey`s via `fc.uniqueArray` with a `selector`) and asserts each row threads the
   **same** surrogate into every member (`Doc_core.sid == Doc_body.doc_sid` per row),
   the per-row surrogates are **pairwise distinct**, and every minted surrogate is
   fresh (`> max(seeded sid)`). Distinctness/threading are asserted rather than the
   exact mint sequence, so the test is robust to the mint algorithm.

3. **lineage agreement over EAV and surrogate advertisements** — the structural
   member-map reconstruction previously ran only over the columnar advertisement.
   Refactored the columnar `it` into a shared helper `assertAdvertisementLineage`
   (anchor-is-a-member, every non-pivot logical column maps to a base column, every
   member carries a shared-key column, every *advertised* forward key is base-backed)
   plus a small `expectLogicalPkForwardKey`, and added an **EAV** `it` and a
   **surrogate** `it`, each on a fresh `beforeEach` db (avoids `declare logical schema
   x` collisions). Keykind-specific tail:
   - columnar / EAV (`logical-tuple`): the logical PK `id` is a forward key whose base
     IS the anchor shared key.
   - surrogate: **see the gotcha below** — the body advertises **no** forward key;
     the test asserts the backward facts (docKey base-backed) + that the substrate
     surrogate (`sid`) threads every member and is distinct from any logical column
     base.

### Family B — `describe('multi-source inner join')`

4. **directly-supplied-insert collision** (`...colliding with an existing base key
   is rejected atomically`) — the existing directly-supplied insert always picks a
   fresh disjoint key. This fuzzes the supplied key against the seed range
   (`min:1,max:12` vs seed `1..9`): on collision the per-base insert is **rejected**
   (anchor base PK violation) and **both** bases are left intact (atomic — a partial
   write would be a broken envelope); on a fresh key both bases gain the row. Both
   arms are guarded as exercised (`collidedSeen`/`freshSeen > 0`).

5. **`delete_via=parent` fuzzed** — the deterministic case removes one fixed parent.
   This fuzzes few-parents/many-children so the routed child's FK-parent is frequently
   **shared** by several children, and asserts deleting that one parent leaves **every**
   child in the base (delete_via=parent never touches the child side) while the inner
   join hides **all** of the removed parent's dependents, not just the named child.
   Guards `routedSeen > 0` and `sharedSeen > 0` (a shared parent was actually removed).

## How each oracle was validated

Before writing any oracle I ran a throwaway probe spec against the shipped engine and
confirmed every behavior end-to-end (then deleted the probe):
- missing member: `set a where id=K` mutates `T_core` even when invisible; `set b` /
  `set a,b` never materialize the absent `T_b`; `where a=K` (non-key) is accepted;
  delete of an invisible row removes only the anchor.
- collision: `UNIQUE constraint failed: dk_a PK`, both bases unchanged (atomic).
- surrogate multi-row: mints distinct sequential sids threaded into the body, all
  visible, no error.
- delete_via=parent shared: only the parent removed; all children survive; only the
  dependents' view rows disappear.

## Gotchas / things for the reviewer to scrutinize

- **Surrogate lineage has NO forward key (intentional).** `keysOf(select * from
  x.Doc)` returns `[]`: the surrogate `sid` is projected away and the logical PK
  `docKey` rides `Doc_core.doc_key`, which carries **no base uniqueness constraint**,
  so the forward FD walk advertises nothing. My first draft wrongly required a forward
  key for *every* keykind and red on surrogate; the helper now does **not** require a
  forward key (it only requires that any key it *does* advertise is base-backed), and
  the surrogate `it` asserts the backward/threading facts instead. Reviewer should
  confirm this is the intended characterization and not masking a real
  forward-key-derivation gap (i.e. that `docKey`'s logical-PK uniqueness genuinely is
  not meant to surface as a base FD here).
- **Anchor-update-of-an-invisible-row is treated as intended, not a widen.** In the
  missing-member test, `update x.T set a=NV where id=K` changes `T_core` even though
  the logical row is invisible through the view. The ticket frames this as the
  decomposition routing by anchor predicate (the prior oracle already modeled the
  anchor mutating regardless of visibility). It is *arguably* a view-widening
  (touching a base row no visible view row represents). I did **not** treat it as a
  violation because the ticket explicitly scopes these as coverage gaps, not
  correctness defects, and the view image never widens. If the reviewer disagrees with
  that semantic call, it's a design question for a separate fix/plan ticket, not an
  inline fix here.
- **`fc.uniqueArray({ selector })`** is relied on for the multi-row surrogate keys —
  confirm the fast-check version in the repo supports `selector` (it ran green here).
- Oracles are floors: the missing-member test fixes `a`'s range to `1..4` and the
  predicate value to `1..6`, so `where a = 5|6` simply matches nothing — intentional,
  but it means the non-key-predicate-with-matches density is modest. The
  `opsSeen`/`invisibleSeen` guards ensure the interesting arms fire, but a reviewer
  wanting more pressure could widen ranges or bump `numRuns`.

## Out of scope (unchanged from the source ticket)

- GetPut write-back of optional `c` / EAV columns (read-only by design — stays
  asserted-as-rejected).
- The both-sides Family B update predicate-clash variant (owned by
  `view-mutation-multisource-both-sides-predicate-clash`).
