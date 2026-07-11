description: There is no test that checks whether two copies of the project's packages at slightly different versions can still talk to each other. This asks whether that kind of cross-version testing is worth building now, and if so, the smallest useful form of it.
files:
  - packages/quereus-sync (sync protocol — the serialization most exposed to version skew)
  - packages/quereus-sync-client / packages/sync-coordinator (client/coordinator codec pair that has drifted before)
----

## What this is

"Version-skew testing" means: pin package X at version N and package Y at version
N-1 (or N+1) and assert they still interoperate — the check that catches a wire-format
or serialization change that breaks an older peer.

## Why it is parked, not built now (the plan's decision)

- `AGENTS.md` explicitly states **"Backwards compat: don't worry yet."** While that
  stance holds, spending effort to prove old/new versions interoperate is testing a
  guarantee the project has deliberately not made yet. It would earn its keep only once
  backwards/forward compatibility becomes a product commitment.
- The nearest real risk it would guard — client/coordinator protocol drift — is being
  addressed more directly by the sync-protocol shared-module + migrate/version work
  (see `tickets/complete/`) and by the new end-to-end coordinator round-trip test
  (`sync-coordinator-e2e-roundtrip`), which catches *current* skew without a
  multi-version harness.

## When to promote this

Promote to `plan/` (or straight to a `debt-` implement ticket) when **either**:

- the project decides to support mixed-version sync deployments (a coordinator serving
  clients that upgrade at different times), **or**
- the sync protocol gains an explicit version negotiation / migration boundary that
  needs its compatibility window tested across real version pairs.

## Minimal form (if/when built)

Smallest useful version: a single test that serializes a changeset with the current
codec, then decodes it with a **pinned prior codec snapshot** (a committed golden
fixture of the older wire format) and asserts it still applies — no need to actually
install two npm versions. Golden-fixture round-trip beats a full dual-install matrix
for the first iteration.
