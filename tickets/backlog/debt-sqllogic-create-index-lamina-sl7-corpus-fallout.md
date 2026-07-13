---
description: |
  Several conformance test files in this repo's SQL-logic corpus set up their scenarios with "create unique
  index …". The lamina project runs this same corpus against its own backend, which deliberately retired
  standalone index creation (covering materialized views replace it), so those files fail there on the setup
  line before their actual subject runs. Either migrate the setup to a covering-MV form, or give downstream
  backends a capability gate they can read so they can skip these files cleanly.
files:
  - packages/quereus/test/logic/47.3-upsert-conflict-target-collation.sqllogic  # § 6 setup uses create unique index (subject: upsert-conflict collation, §§1-5 pass on lamina)
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic              # §§1,2,4,6,7 take create unique index as subject; §§3,5 add-constraint-unique semantics also diverge
  - packages/quereus/test/logic.spec.ts                                         # MEMORY_ONLY_FILES — spec-file-local exclusion the lamina harness cannot read
difficulty: low
---

# SQL-logic corpus `create [unique] index` setup trips lamina's SL-7 (index creation retired)

## Context

Lamina consumes this repo's `.sqllogic` corpus directory verbatim (its harness `readdirSync`s it), so any
corpus file lands in lamina's conformance run with zero lamina change. Lamina deliberately retired
first-class `create [unique] index` under its lens model — covering materialized views replace indexes — so
its `LaminaModule` implements no `createIndex` callback and `SchemaManager.createIndex` hard-rejects
("Virtual table module 'lamina' … does not support CREATE INDEX"). Files that use `create unique index`
therefore fail on lamina, and lamina holds them green on its own `known-failures.ts` allow-list (pinning the
exact error fingerprint; self-retiring when the file starts passing).

Two files currently blocked lamina-side on this:

- **`47.3-upsert-conflict-target-collation.sqllogic`** — §§1–5 (the file's actual subject: collation-variant
  upsert-conflict matching) now **pass** on lamina after `bug-upsert-conflict-target-collation-match` landed.
  Only § 6's `create unique index idx_tag_nc on idx_coll (tag collate nocase)` — incidental setup for an
  index-derived-UNIQUE-collation scenario — trips SL-7.
- **`10.1.2-ddl-in-transaction.sqllogic`** — §§1,2,4,6,7 take `create unique index` as their *subject*; this
  repo already excludes it from non-memory backends via `MEMORY_ONLY_FILES` (`logic.spec.ts`) pending
  `isolation-ddl-validation-ignores-overlay-rows`. §§3,5 additionally expect `add constraint … unique` to
  re-validate existing rows and abort atomically — lamina makes that structurally total (grandfathers
  duplicates, forward-enforces), a separate permanent divergence.

## Why this is a quereus-side item

The corpus lives here. Two ways to unblock the incidental (non-subject) trips without lamina reversing SL-7:

- **Migrate the setup** — where `create unique index` is incidental scaffolding (47.3 § 6), re-express it as
  a covering MV (or an inline UNIQUE constraint) so the section's real subject runs on any backend. Where it
  is the subject (10.1.2), it stays memory-relevant; the lever there is the capability gate below.
- **Expose a backend capability gate the downstream harness can read** — replace the spec-file-local
  `MEMORY_ONLY_FILES` constant with a machine-readable capability tag on the file (e.g. a directive the
  corpus consumer can honor) so backends without standalone-index-creation skip these files cleanly, rather
  than each downstream maintaining its own exclusion list.

## Priority

Low. Lamina holds these green via fingerprint-pinned known-failures that self-retire the moment a file
starts passing, so nothing is red downstream today. This is corpus hygiene / cross-backend portability, not
a correctness bug. Bundle with any broader corpus-portability pass.

## On landing

Lamina removes the affected entries from its `known-failures.ts` (its harness fails if a registered file
starts passing) and drops the ledger lines — no lamina source change needed.
