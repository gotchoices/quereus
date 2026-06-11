----
description: Let a proven-bijective authored inverse make its logical column key-reconstructible — PK/UNIQUE over an authored column currently forces read-only / lens.unrealizable-constraint even when the prover has proved the mapping a bijection.
files:
  - packages/quereus/src/schema/lens-prover.ts   # isReconstructibleColumn (bare-column test), checkKeyReconstructibility, classifyCheckConstraint, proveForwardInjective
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic  # scenario 13 pins today's read-only behavior
----

# PK / UNIQUE over an authored-inverse column

## Current behavior

`isReconstructibleColumn` is a bare-column-projection test, so a logical PK
column written through an authored (`with inverse`) put is *not*
reconstructible: the table deploys read-only (`lens.pk-not-reconstructible`),
even when the prover's enumeration has proved the forward/inverse pair a
**bijection** between the basis and logical CHECK domains (the case where the
advisory is suppressed). Similarly a logical `unique` over an authored column
reds `lens.unrealizable-constraint`. Scenario 13 of
`55.5-lens-authored-inverse.sqllogic` pins the read-only outcome.

## Use case / expectation

A renaming/recoding lens whose key column is a bijective authored mapping —
e.g. `upper(code) as grp with inverse (code = lower(new.grp))` over matching
enumerable domains, with `grp` the logical PK. Semantically the key is fully
reconstructible: a written logical key maps to exactly one basis key and back.
The user reasonably expects the table to stay writable, and a logical UNIQUE
over such a column to be enforceable (the bijection transports uniqueness of
the basis column to uniqueness of the image).

For a *non-injective* (lossy) authored mapping the current behavior is correct
and must stay: a collapsed image cannot be a key.

## Specification sketch

- Key reconstructibility: a PK column whose round-trip verdict is authored AND
  whose enumeration proved the pair bijective (the same condition that
  suppresses `lens.getput-lossy`) counts as reconstructible. The verdict must
  be threaded from the round-trip pass to `checkKeyReconstructibility` (today
  they don't communicate; note `proveRoundTrip` runs *after* the read-only
  verdict is computed, so ordering needs rework).
- UNIQUE realizability: a basis UNIQUE on the put-target column plus the proved
  bijection entails the logical UNIQUE; absent the basis structure the usual
  commit-time-scan / `lens.no-backing-index` machinery should apply over the
  forward image.
- Mutation-time key routing (DELETE/UPDATE-by-key through the inverse) must
  evaluate the put to locate the basis row — verify the write path supports
  keyed access through an authored put before flipping the verdict.
