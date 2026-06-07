description: A logical-layer read-only / generated *intent* signal for lens columns, so the engine can distinguish an intentional derived (read-only) column from a column an author meant to be writable but whose `put` is non-invertible — enabling the stronger deploy-time hard-block of an opaque column in a name-matched (would-be-writable) position.
files: packages/quereus/src/schema/lens-prover.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/planner/analysis/scalar-invertibility.ts, docs/lens.md
----

## Why

The lens round-trip prover (`proveRoundTrip`, ticket `2-lens-roundtrip-deploy-time-proving`)
emits `lens.non-invertible` **only** for a column the lens *presents as writable*
(a `base` `UpdateSite`). A `computed`/opaque output column (e.g. `upper(who) as
label`) is treated as an **intentional read-only / derived column** — the
conservative, sound reading mandated by the prover's soundness-over-completeness
principle and the no-over-block requirement: hard-blocking it at deploy would break
the documented, sound derived-column pattern (`docs/lens.md` § Computed and
Generated Columns).

That leaves one case the model **cannot** distinguish today: an author who *meant*
a name-matched column to be writable but wrote a non-invertible body for it. Under
the current model that column is silently accepted as read-only (its write reds
`no-inverse` only later, at mutation time) — indistinguishable from a deliberately
derived column, because **the logical layer carries no read-only / generated
*intent* signal**. There is no `generated as` construct at the logical layer; a
column is "generated" precisely when its lens body computes it and no `put` inverse
exists.

## What a solution would add

A way for a logical column declaration to state intent — read-only/derived
("I know this is computed") vs. writable ("this must have a faithful write path") —
so the prover can:

- **hard-block at deploy** an opaque column declared/positioned as *writable*
  (the stronger reading of the round-trip law: a writable-intent column whose
  `get` is non-invertible is an authoring error, not a derived column), while
- **continue to admit** an opaque column declared read-only/derived as today
  (no over-block).

This is the missing third state between "writable and faithful" and "writable but
unfaithful" that the current binary `base`/`computed` lineage cannot express.

## Specification notes / open questions

- **Where the signal lives.** A per-column logical-spec flag (a reserved tag, a
  column attribute, or a dedicated `read only` / `generated` modifier) on the
  logical `create table` — version-controlled, visible in review, consistent with
  the lens layer's "intent in the declaration" stance.
- **Default.** Absent the signal, preserve today's conservative behaviour (opaque
  ⇒ intentional read-only, no deploy error) so existing schemas do not start
  failing.
- **Prover wiring.** `proveRoundTrip` already computes the per-column writable /
  faithful verdict off `viewComplement`; it would additionally consult the intent
  signal to decide whether a non-faithful *intended-writable* column is a deploy
  error vs. an admitted read-only column. The firing rule and the computed
  GetPut/PutGet predicate are unchanged — only the classification of "opaque in a
  name-matched position" gains an intent input.
- **Interaction with the invertibility registry.** As the registry grows
  (`scalar-invertibility.ts`), more bodies become genuinely writable; the intent
  signal is orthogonal — it governs the *opaque* remainder.

## Out of scope (its origin ticket)

`2-lens-roundtrip-deploy-time-proving` deliberately treats every opaque column as
intentional read-only (the sound reading) and does **not** introduce this signal.
This backlog item captures the stronger reading for if/when real demand surfaces.
