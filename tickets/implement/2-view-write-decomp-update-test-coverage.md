description: Close two test gaps in the shipped decomposition optional/EAV UPDATE materialization — a surrogate-keyed optional-member UPDATE (matched / absent-materialize / all-null-delete) and a GetPut over the optional value column (view-image idempotence across materialize / delete / lingering-all-null). Corners #2 and #3 of the view-write-decomposition-optional-update review hardening. Test-only; no production code changes.
prereq: view-write-decomp-stitch-key-unique-guard
files: packages/quereus/test/lens-put-fanout.spec.ts (surrogate optional fixture + UPDATE tests), packages/quereus/test/property.spec.ts (decomposition fan-out describe — GetPut over c), packages/quereus/src/planner/mutation/decomposition.ts (buildOptionalMaterializeInsert / singleKeyColumn — reference only, no edits)
----

## Context

`view-write-decomposition-optional-update` ships the optional/EAV value-write materialization
(matched UPDATE / `on conflict do nothing` materialize INSERT / all-null DELETE). The view-image
soundness is backed by the PutGet property tests (columnar numRuns 100, EAV numRuns 80) and the
deterministic branch pins in `lens-put-fanout.spec.ts`. Two paths the existing suite does not
exercise, both pure test additions (no production change):

This ticket is `prereq`-chained after `view-write-decomp-stitch-key-unique-guard` only because
both edit `lens-put-fanout.spec.ts` — the chain serializes the edits. There is no behavioral
dependency.

### Corner #2 — surrogate-keyed optional-member UPDATE (test gap)

`buildOptionalMaterializeInsert` threads `singleKeyColumn(anchor)` (the anchor's stitch column)
into the materialize INSERT's projection and `singleKeyColumn(member)` as the INSERT target key
column. Under a **surrogate** shared key those two are spelled **differently** (e.g.
`sid` / `meta_sid`), and the optional-member UPDATE/delete path has only ever been exercised under
a **logical-tuple** key (same spelling) — every surrogate fixture today uses **mandatory** members
only. The materialize INSERT for an optional member of an **existing** logical row reads the
**existing** anchor key (`select <anchor>.sid …`) — it does **not** re-evaluate the surrogate
default (that only happens for a brand-new logical row at INSERT) — and threads it into the
member's distinctly-spelled key column. Pin that the surrogate anchor key threads correctly.

### Corner #3 — GetPut over the optional value column (oracle floor)

The columnar GetPut property (`property.spec.ts`, `deployColumnar`) writes back only the mandatory
writable columns `a, b`; it never re-puts `c`, so the materialize / delete branches are not under a
GetPut idempotence check. Re-putting `c` must be **observationally idempotent on the view image** —
crucially including the **lingering-all-null** representational collapse: a multi-value optional
member left all-null-but-present (via a partial null update) reads identically to absence, and
writing those read-back nulls back **deletes** the component row. A strict per-member base-multiset
GetPut would (correctly) report a diff there; the sound check is **view-image** idempotence
(re-reading the view after writing read values back yields the identical image). This hardens the
floor against a representational divergence the single-op deterministic tests cannot catch.

## Design

### Corner #2 (lens-put-fanout.spec.ts)

Add a surrogate fixture with an **optional** member alongside a mandatory one, surrogate spelled
distinctly across all three relations:

- anchor `Doc_core(sid integer primary key default (coalesce((select max(sid) from Doc_core), 0)
  + mutation_ordinal()), doc_key text, title text)` — maps `docKey`→`doc_key`, `title`→`title`.
- mandatory `Doc_body(doc_sid integer primary key, body text)` — maps `body`→`body`.
- **optional** `Doc_meta(meta_sid integer primary key, note text)` — maps `note`→`note`,
  `presence: 'optional'`.
- `sharedKey: surrogate`, `keyColumnsByRelation = { Doc_core:['sid'], Doc_body:['doc_sid'],
  Doc_meta:['meta_sid'] }`.
- logical `Doc { docKey text primary key, title text, body text, note text }`.

Seed: `Doc_core` (100,'k1','First'),(101,'k2','Second'); `Doc_body` both; `Doc_meta` **only**
(100,'m1') — so row k1 has the optional component, k2 does not.

The predicate `where docKey = 'k1'` filters on an anchor identity column (anchor-resolvable), so
the anchor subquery resolves the matched `sid`.

Tests (each verifies base `Doc_meta` and the `x.Doc` view image):
- **matched UPDATE**: `update x.Doc set note = 'm1b' where docKey = 'k1'` → `Doc_meta` row
  (meta_sid 100) updated to 'm1b'; no new row. View `note` for k1 = 'm1b'.
- **absent → materialize INSERT** (the headline thread-through): `update x.Doc set note = 'm2'
  where docKey = 'k2'` → a new `Doc_meta` row materializes with **meta_sid = 101** (the existing
  anchor `sid` for k2, threaded into the distinctly-spelled member key — NOT a freshly minted
  surrogate). Assert `select meta_sid, note from main.Doc_meta where note = 'm2'` = `{ meta_sid:
  101, note: 'm2' }`, and the view `note` for k2 = 'm2'.
- **all-null DELETE**: `update x.Doc set note = null where docKey = 'k1'` → `Doc_meta` row
  (meta_sid 100) removed (`note` is the member's only value column); view `note` for k1 = null.
- **null write to an already-absent optional component is a no-op**: after the delete above,
  `update x.Doc set note = null where docKey = 'k1'` leaves `Doc_meta` unchanged.

### Corner #3 (property.spec.ts, `decomposition fan-out` describe)

(a) **Property: GetPut over c is observationally idempotent on the view image** — reuse
`deployColumnar` (anchor `T_core(id,a)`, mandatory `T_b(id,b)`, optional `T_c(id,c)`). Seed a
random row set (some with `c`, some without — `colRowArb` already produces `c: option`). Read the
full view image `select id, a, b, c from x.T`. For each visible row, write **every** column back:
`update x.T set a = <a>, b = <b>, c = <c|null> where id = <id>`. Re-read the view and assert it
equals the pre-write image. (Writing a present row's own `c` back is a same-value UPDATE; an absent
row reads `c = null` and writing `c = null` is a no-op — both leave the image stable.) Guard with a
counter that at least one row carried a non-null `c` and at least one was absent, so the materialize
and no-op arms are both walked. `numRuns: 40`.

(b) **Deterministic: materialize / delete / lingering-all-null re-put sequence** — pins the
view-image idempotence across the three transitions, including the representational collapse a
property run is unlikely to hit deterministically.

- Single-column `T_c` (deployColumnar): seed id=1 (a,b,c=1000), id=2 (a,b, no c).
  - materialize: `update x.T set c = 7 where id = 2`; read view → c=7; GetPut `update x.T set c = 7
    where id = 2`; re-read view = unchanged.
  - delete: `update x.T set c = null where id = 1` (T_c(1) removed); read view → c=null; GetPut
    `update x.T set c = null where id = 1` (no-op, absent); re-read view = unchanged.
- Multi-value optional member for the **lingering-all-null** collapse. Add a small deploy in the
  test (mirror `deployColumnar`'s tag style) for an optional member with **two** value columns,
  e.g. `T2_opt(id integer primary key, c1 integer null, c2 integer null)` under logical
  `T2 { id pk, a, c1, c2 }` with anchor `T2_core(id, a)`:
  - seed id=1 with c1=5, c2=6 (present).
  - `update x.T2 set c2 = null where id = 1` (partial) → row present, c1=5, c2=null.
  - `update x.T2 set c1 = null where id = 1` (partial; only c1 assigned, so NOT all-value-columns)
    → row **present**, c1=null, c2=null — the **lingering all-null** row.
  - read view id=1 → c1=null, c2=null.
  - GetPut: `update x.T2 set c1 = null, c2 = null where id = 1` → both value columns assigned and
    all null → **DELETE** the component row.
  - re-read view id=1 → c1=null, c2=null — **view image identical** (observationally idempotent)
    even though the base representation changed (present-all-null → absent). Assert the view image
    equality, and additionally assert `main.T2_opt` has no row for id=1 to document the intended
    representational collapse.

## Edge cases & interactions

- **Surrogate default not re-evaluated on UPDATE-materialize** — the materialize INSERT for an
  existing logical row reads the existing anchor `sid` (not the default). The absent→materialize
  test must assert `meta_sid = 101` (the existing anchor surrogate), proving the thread and that no
  fresh surrogate is minted. (Contrast the INSERT path, which evaluates the default per new row.)
- **Distinct stitch spellings** — `sid` (anchor) vs `meta_sid` (member): the materialize
  projection sources `<anchor>.sid` and targets `meta_sid`. A regression that used the member
  spelling on both sides would either error (unknown column on the anchor) or silently misthread —
  the `meta_sid = 101` assertion catches it.
- **View-image vs base-diff oracle** — corner #3 MUST assert view-image idempotence, NOT
  per-member base-multiset equality, or the lingering-all-null delete will (correctly) trip a
  base-diff assertion. Make the oracle choice explicit in a comment so a future edit does not
  "tighten" it into a base-diff check and reintroduce a false failure.
- **Partial-null does NOT delete** — `set c1 = null` alone (c2 unassigned) must leave the row
  present (the lingering state); only assigning **every** value column to null deletes. The
  sequence depends on this; it is already pinned in `lens-put-fanout.spec.ts`'s multi-value
  describe but is load-bearing here.
- **Stitch-key uniqueness guard interaction (prereq)** — all fixtures here use PK stitch keys
  (`sid`/`doc_sid`/`meta_sid`, `id`), so they deploy cleanly under the new deploy-time guard from
  the prereq ticket. Keep them that way.
- **Counters / no-degenerate-run guards** — follow the existing decomposition property tests'
  pattern (`expect(mutated, …).to.be.greaterThan(0)` etc.) so a GetPut that never exercised the
  materialize/absent arms fails loudly rather than passing vacuously.

## Expected outcome

- The surrogate + optional-member UPDATE path (matched / absent-materialize / all-null-delete) is
  pinned, including the anchor-surrogate-into-member-key thread.
- A GetPut over `c` confirms view-image idempotence across materialize, delete, and the
  lingering-all-null → absence representational collapse.

## TODO

- Add the surrogate-optional fixture + the four UPDATE tests to `lens-put-fanout.spec.ts`.
- Add the GetPut-over-c property test and the deterministic materialize/delete/lingering-all-null
  sequence (with the second multi-value `T2` deploy) to the `decomposition fan-out` describe in
  `property.spec.ts`.
- Run the specs (stream output), e.g.
  `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/lensB.log; tail -n 60 /tmp/lensB.log`,
  and lint the package.
