description: Support RETURNING through a non-preserved-side (outer-join null-extended) UPDATE. Currently rejects `returning-through-view` because the post-mutation re-query identifies rows by the captured non-preserved-side PK, which a freshly materialized null-extended row no longer matches (captured NULL vs the minted key). Re-key the re-query off the stable preserved-side identity so both matched and materialized rows surface.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/view-updateability.md, packages/quereus/test/property.spec.ts
----

## Problem

`view-write-outer-join-nonpreserved-update` shipped the per-row matched-update / null-extended-insert materialization for a LEFT-join non-preserved column. RETURNING through that update is **rejected** (`returning-through-view`, guarded in `decomposeUpdate`'s `nullExtended` branch) because it cannot be made correct under the current re-query scheme:

- `buildMultiSourceUpdateReturning` restricts the post-mutation join body to the captured identities via `exists (select 1 from __vmupd_keys k where k.k<side>_<j> = <side>.pk<j> …)` for **every** side × PK column.
- A null-extended row's non-preserved-side PK is captured **NULL** (it had no join partner pre-mutation). After the materialization insert the row now carries a **real** minted PK, so the identity equality `NULL = <minted pk>` never holds — the row is silently dropped from the RETURNING image.
- Verified during review: `update npv set pv = 6 where cc = 2 returning cc, pv` wrote correctly (parent materialized, view reads back joined) but RETURNING returned `[]`. Matched rows return correctly; the result would be a silent **partial** set, so the whole shape is rejected at plan time (data-independent — we can't know which rows null-extend).

## Expected behavior

RETURNING through a non-preserved-side update returns the post-mutation view image of **every** affected row — both matched rows and materialized null-extended rows.

## Direction (for the planning/implement stage to evaluate)

A LEFT join's **preserved-side** PK is stable across the mutation and uniquely identifies each view row (that is the premise that makes the non-preserved column updatable at all). Re-keying the RETURNING re-query's identity `exists` to correlate on the **preserved** side(s) only — rather than all sides — would match both matched and materialized rows. Open questions to resolve when planning:

- **Fan-out.** A LEFT join can fan one preserved row to many non-preserved rows; correlating on the preserved PK alone could over-match. Confirm whether the non-preserved update shape permits fan-out, and if so how to scope identity to the captured row set (e.g. keep the non-preserved key correlation for matched rows, fall back to preserved-only for the null-extended partition — a `(np pk = captured) or (np pk captured-null and preserved pk = captured)` disjunction).
- **Inner-join parity.** For an inner join every side is preserved, so an all-preserved correlation is identical to today's all-sides correlation — verify no regression.
- The capture already projects every side's PK for an UPDATE with RETURNING (`buildIdentityCapture`, `hasReturning` branch), so the preserved-side keys are already available; this is a re-query predicate change, not a capture change.

## Acceptance

- `update <leftjoinview> set <nonpreserved> = … returning …` returns matched + materialized rows with their correct post-mutation image.
- The plan-time `returning-through-view` reject in `decomposeUpdate`'s `nullExtended` branch is removed (or narrowed to only the genuinely-unrecoverable shapes, e.g. FULL).
- Property + sqllogic coverage: matched-only, null-extended-only, and mixed batches; `returning *`; idempotent GetPut alongside the returned image.
