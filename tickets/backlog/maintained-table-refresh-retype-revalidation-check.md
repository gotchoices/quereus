description: Characterize (and document, mirroring the collation case) the analogous reshape-arm limitation for a `retype` op — a physical type conversion is, like `recollate`, a POST-reconcile data-validating op that runs AFTER `rebuildBacking`'s constraint scan has already validated + committed the rows in their PRE-convert physical form. A declared CHECK whose truth flips under the retype may therefore pass the bulk scan, commit, and be converted into a violating state. Determine whether this corner is reachable, pin the actual behavior if so, and either document it as a sibling known-limitation or close the gap if the analysis shows it does not actually arise.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts        # rebuildBacking constraint-bearing branch (validates+commits pre-convert); reshapeBackingInPlace post-reconcile loop (retype op runs here); classifyBackingReshape / ReshapePlan postReconcileOps
  - packages/quereus/test/maintained-table-refresh-revalidation.spec.ts   # sibling describe 'reshape arm: collation-sensitive CHECK (documented limitation)' is the template to mirror
  - docs/materialized-views.md                                            # REFRESH section "Known limitation — collation-sensitive CHECK on the reshape arm" is the sibling note to mirror/extend
difficulty: medium
----

# Reshape arm: does a `retype`-flips-CHECK corner exist (analogous to the recollate one)?

## Background

The `maintained-table-refresh-revalidation-collation-check` ticket characterized and
documented one corner of the `refresh materialized view` reshape arm: a
**collation-sensitive** declared CHECK can pass `rebuildBacking`'s constraint scan
and commit, then be **recollated** into a violating state, because `recollate` is a
*post-reconcile* data-validating op (`reshapeBackingInPlace`) that runs AFTER the
scan has validated + committed the rows in their pre-recollate physical form.

`retype` is sequenced in the **same** `postReconcileOps` batch as `recollate`
(`materialized-view-helpers.ts`, the `reshapeBackingInPlace` post-reconcile loop and
the attach-reshape mirror around line ~1089). So the same pre-validate / post-convert
window exists structurally. The question this ticket exists to answer: **is a
CHECK's truth actually flippable by a `retype` in that window, the way it is by a
recollate?**

## Why it may (or may not) arise — to be determined, not assumed

A `retype` converts the column's physical representation. Candidate flip shapes to
probe:

- A CHECK that compares the column against a literal whose interpretation depends on
  the column's physical type (e.g. a `text`→`integer` retype where a CHECK like
  `v <> '01'` reads as a string compare pre-convert but a numeric compare — `01` ==
  `1` — post-convert).
- A CHECK over a function whose result depends on physical type (`length(v)`,
  `typeof(v)`, numeric vs lexicographic ordering).
- A widening/narrowing convert that changes a value's truth under a range/equality
  CHECK.

It is **possible** the analysis concludes the corner does NOT arise — e.g. the bulk
scan resolves CHECK comparisons against the *logical* (already-new-typed) value, or
a retype that would change a CHECK's truth is rejected earlier by
`classifyBackingReshape` as inexpressible, or values that flip are themselves
rejected by the retype's own convert scan before the CHECK matters. The first task is
to establish which, with a throwaway probe, before writing any test.

## Expected output

- A determination (with the probe evidence) of whether a `retype`-during-reshape can
  leave a committed row violating a declared CHECK under the final column type.
- If reachable: a sibling characterization test in the existing
  `reshape arm: …` describe block (mirror the recollate core/control/next-maintenance
  trio — pin the ACTUAL behavior, including the next-maintenance blast radius: is the
  frozen row likewise re-rejected on any genuine re-derivation under the new type?),
  plus a sibling "Known limitation — type-sensitive CHECK on the reshape arm" note in
  `docs/materialized-views.md` cross-referenced from the same code comments.
- If NOT reachable: a short note (in the docs, next to the collation limitation, or in
  the spec's describe-block comment) stating that the retype analog was checked and
  does not arise, with the one-line reason — so the next reader does not re-derive it.

## Notes

- This is a **characterization / documentation** task like its sibling, not a known
  bug — scope it to pinning reality and recording it honestly. Only escalate to a
  behavior fix if the probe surfaces something materially worse than the bounded,
  non-propagating limitation the recollate case carries.
- Memory backing is sufficient for the engine-level corner (the sibling ticket made
  the same call); store parity is tracked separately by
  `maintained-table-refresh-revalidation-store-parity`.
