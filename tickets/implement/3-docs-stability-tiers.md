description: The project ships a mix of rock-solid features and experimental research features, but nothing tells a user which is which, so someone can build on an experimental feature thinking it is stable; publish a page defining what each stability label promises, and label every user-facing feature area with one.
files:
  - docs/stability.md (NEW — canonical tier definitions + per-area assignment table)
  - docs/.stability.json (NEW — machine-readable doc→tier map, consumed by the gate in the follow-on ticket)
  - packages/quereus/README.md (§ Current Status — compact tier summary; § Documentation — index entry)
  - docs/.doc-budget.json (six ratcheted docs grow by one banner line — see "The ratchet" below)
  - docs/doc-conventions.md (§ new: the stability banner convention)
  - docs/*.md (one banner line under the H1 of each user-facing doc)
  - scripts/check-docs.mjs (read-only here — run it; it is *edited* by the follow-on ticket)
difficulty: medium
----

## What this is

Quereus is at version 4.3.1 and publishes sixteen packages, spanning a
battle-tested SQL core and several research tracks that are nowhere near settled.
Nothing published says which is which. A user can adopt lenses believing they carry
the same compatibility promise as `select`, and a maintainer has no declared
boundary to point at when deciding how much a change to a research track is allowed
to break.

This ticket publishes four **stability tiers** — Stable, Beta, Experimental,
Internal — defines exactly what each promises, and assigns every user-facing feature
area to one.

This is a labeling and documentation change. **No feature's behavior changes.**

The originating recommendation (`docs/review.html`, strategic recommendation #6,
a frozen review artifact — do not edit it) reads:

> Declare stability tiers. Core SQL + vtab + views: stable. Materialized views:
> beta. Lenses / migration / parallel runtime: experimental. Contains the blast
> radius of the research tracks; consider freezing the parallel track until a
> federated consumer pays its rent.

Whether to actually *freeze* the parallel track is a product call for a human. It is
deliberately **not** filed as a ticket here, and declaring the tier does not force
the call. Leave it alone.

## The load-bearing distinction: tiers are about compatibility, not correctness

State this once, at the top of `docs/stability.md`, because without it the tiers
read as a contradiction.

A tier says **how much a future release may break you**. It says nothing about
whether the feature computes the right answer today. A wrong answer is a bug at
every tier, including Experimental.

This matters concretely. Two optimizer rules from the Experimental parallel track —
`rule-fanout-lookup-join.ts` and `rule-async-gather-zip-by-key.ts` — are registered
in `planner/optimizer.ts` and fire on ordinary user queries. A user running plain
`select` cannot opt in or out of them. If "Experimental" meant "may return wrong
rows", the Stable tier would be a lie. It does not. For the parallel track,
Experimental covers the plan-node shapes, the runtime primitives, and their
TypeScript APIs — not the correctness of the rows your query returns. An
experimental optimizer rule that changes a result set is a bug, not an exercise of
its tier.

## The four tiers

Definitions go in `docs/stability.md` under a `## Tiers` heading, one `###` heading
per tier (the follow-on gate derives the valid tier names from those headings, so
the heading text is exactly the tier word).

Quereus follows semver with all packages sharing one version, so the promises are
phrased against release types (`docs/releasing.md`).

| | **Stable** | **Beta** | **Experimental** | **Internal** |
| --- | --- | --- | --- | --- |
| A breaking change may land in | a major release only | a minor release | **any** release, incl. a patch | any release |
| Deprecation notice before removal | yes, one major cycle | called out in the release notes | none | none |
| Stored / on-the-wire format | stable across majors, with a documented upgrade path | may change, with a documented upgrade path | may change with no upgrade path; a stored artifact may be unreadable by the next version | n/a |
| Bug priority | a regression blocks a release | fixed, behind Stable | logged; a fix competes with the track's own roadmap | report the user-visible symptom instead |
| Build on it? | yes | yes, and read the release notes | prototype on it, and tell us what broke | no — it has no user-facing contract |

Prose to accompany the table, one short paragraph each:

- **Stable** — SQL accepted today keeps its meaning; the exported TypeScript surface
  keeps its shape. Correcting behavior that violates the documented semantics is a
  bug fix, not a breaking change, and may land in a minor or patch release.
- **Beta** — complete, tested, and used in earnest, but the surface is still being
  shaped.
- **Experimental** — a research track. It exists to be learned from. Anything may
  change or disappear without notice.
- **Internal** — engine internals, documented so contributors can work on the
  engine, not so consumers can depend on them. Some are reachable from SQL (the
  `query_plan()`, `scheduler_program()`, and `execution_trace()` functions) — they
  are debugging aids and their output shape is not a contract.

## The assignment

Every `docs/*.md` is either **tiered** (a user-facing feature doc, carries a banner)
or **untiered** (a contributor/process/design-note doc, no banner). Nothing is
left unclassified — the follow-on ticket makes that mechanical.

**Stable** — `sql.md`, `types.md`, `functions.md`, `datetime.md`, `usage.md`,
`errors.md`, `memory-table.md`, `module-authoring.md`, `plugins.md`,
`window-functions.md`.

Covers: core SQL (queries, DML, joins, aggregates, window functions, subqueries,
CTEs, set operations, `diff`, `returning`); the type system; the built-in function
library; constraints and assertions (`not null` / `check` / foreign keys /
`create assertion`, the `committed.` pseudo-schema, conflict resolution);
transactions and savepoints; the virtual-table framework (`VirtualTableModule`,
async cursors, `getBestAccessPlan`); read-only views; `MemoryTable`; the core
`Database` / `Statement` API and parameter binding; the plugin system
(`registerPlugin`, custom functions, collations, custom types) and
`@quereus/plugin-loader`; error types and status codes.

**Beta** — `materialized-views.md`, `mv-maintenance.md`, `mv-constraints.md`,
`mv-ingestion.md`, `mv-schema-change.md`, `mv-backing-host.md`,
`view-updateability.md`, `change-scope.md`, `schema.md`, `store.md`.

Covers: materialized views; view updateability (write-through for views, CTEs, and
subqueries-in-`from`); declarative schema (`declare schema` / `apply schema` — a
section of the otherwise-Stable `sql.md`, so it takes a section banner); change-scope
introspection and `Database.watch`; the database event hooks (`onDataChange`,
`onSchemaChange`); the `SchemaManager` API and DDL generation; the persistent store
(`@quereus/store` and the LevelDB / IndexedDB / React-Native-LevelDB /
NativeScript-SQLite plugins) — its on-disk key encoding is **not** frozen; the
isolation layer (`@quereus/isolation`), which provides read-committed plus
read-your-own-writes and **not** snapshot isolation, and performs no write-write
conflict detection — say so in `store.md`, do not leave a reader to infer it; and
the `quoomb-cli` / `quoomb-web` / VS Code tools.

**Experimental** — `lens.md`, `migration.md`, `sync.md`, `sync-coordinator.md`,
`coordinator.md`.

Covers: lenses and layered schemas; schema migration in a synced database (a design
plus the partial lens machinery under `src/schema/lens-*.ts`); the parallel-runtime
track (`ParallelDriver`, `EagerPrefetchNode`, `AsyncGatherNode`,
`FanOutLookupJoinNode`, and `VirtualTableModule.concurrencyMode`); and sync
(`@quereus/sync`, `@quereus/sync-client`, `sync-coordinator`) — whose wire protocol
carries no version handshake and may change without notice.

**Internal** — `runtime.md`, `incremental-maintenance.md`, `optimizer.md`,
`optimizer-assertions.md`, `optimizer-const.md`, `optimizer-conventions.md`,
`optimizer-fd.md`, `optimizer-joins.md`, `optimizer-parallel.md`,
`optimizer-retrieve.md`, `optimizer-rules.md`, `optimizer-streaming.md`.

Covers: the optimizer (rules, cost model, passes, framework); the
functional-dependency and equivalence-class framework; the plan-node tree,
`PlanNodeType`, the emitters, and the `Instruction` / `Scheduler` runtime; the
`DeltaExecutor` incremental-maintenance kernel; and the `query_plan()` /
`scheduler_program()` / `execution_trace()` introspection functions.

**Untiered** (no banner) — `architecture.md`, `doc-conventions.md`, `invariants.md`,
`releasing.md`, `todo.md`, `stability.md` itself, `design-isolation-layer.md`,
`progressive-optimizer.md`, `promo-ideas.md`, `quickpick-design.md`,
`sqlite-test-crosscheck.md`, `sqlite-test-crosscheck-process.md`, `zero-bug-plan.md`.

`docs/review.md` and `docs/review.html` are frozen review artifacts, already exempt
from every check in `scripts/check-docs.mjs` (its `EXEMPT` set) and reached by no
doc walk. They need no classification.

### The three edge calls, and why they land where they do

**Views split in two.** Read-only views are Stable. **View updateability** — the
write-through path — is Beta, and gets its own row. Calling it Stable would promise
semantics for multi-source write routing that only just landed, and its
acceptance boundary (which view bodies are writeable) is still widening. Materialized
views, lenses, and migration all sit on it, so a Beta base under a Beta feature (MVs)
and an Experimental one (lenses) is coherent; a Stable base would not have been.

**Declarative schema is Beta, not Stable**, even though it is documented inside the
Stable `sql.md`. It carries a real equivalence harness
(`test/declarative-equivalence.spec.ts` plus a property suite), but that harness was
shaped *against three found round-trip defects* (issues #21, #22, #23), and the
`declare schema` grammar is still growing (seeds, imports, versioning, hashing). It
takes a **section banner** inside `sql.md` rather than changing that doc's
header banner.

**The functional-dependency framework is Internal, not a user tier.** It has no
public API and is surfaced only through `query_plan()` properties, which is itself
Internal. Its *soundness* is guarded by the Key Soundness property tests — that is a
correctness guarantee, and correctness is not what a tier measures. Say this
explicitly in `stability.md`; it is the clearest illustration of the
compatibility-vs-correctness split above.

## Where it lives, and how a doc points at it

**Canonical home: `docs/stability.md`.** It holds the tier definitions (`## Tiers`)
and the full per-area assignment table. Target well under 1,000 words; it must come
in under the 12,000-word cap for an unratcheted doc.

**Every tiered doc carries one banner line**, immediately after its `#` H1 and before
the intro paragraph, in exactly this form:

```markdown
> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).
```

This deliberately mirrors the existing one-line invariant back-link convention in
`docs/doc-conventions.md` § The invariant register: the doc *states* its tier and
*links* the definitions rather than restating them. Add a short `## The stability
banner` section to `doc-conventions.md` recording the convention and the exact form.

**A section may override its doc's tier** with the same banner line placed under that
section's heading — this is how `declare schema` gets Beta inside a Stable `sql.md`,
how `VirtualTableModule.concurrencyMode` gets Experimental inside a Stable
`module-authoring.md`, how the parallel primitives get Experimental inside an Internal
`runtime.md`, and how change-scope gets Beta inside a Stable `usage.md`. The header
banner states the doc's predominant tier; section banners are exceptions.

**`packages/quereus/README.md`** gets a `### Stability` subsection at the top of
`## Current Status`, holding the compact four-row tier table (the "may break in"
column plus a one-line gloss) and a link to `../../docs/stability.md` for the
per-area assignment. Add `[Stability Tiers](../../docs/stability.md)` to the
`## Documentation` index. Mark the existing `## Current Status` capability bullets:
materialized views `(Beta)`, logical schemas and lenses `(Experimental)`, updatable
views `(Beta)`.

**`docs/.stability.json`** is the machine-readable map — a sibling of the existing
`docs/.doc-budget.json`, same shape of idea:

```json
{
  "note": "Tier assignment per doc. A new docs/*.md must appear in `docs` or `untiered` or the docs gate fails. Definitions and the per-area table live in docs/stability.md.",
  "tiers": ["Stable", "Beta", "Experimental", "Internal"],
  "docs": {
    "docs/sql.md": "Stable",
    "docs/lens.md": "Experimental"
  },
  "untiered": ["docs/architecture.md"]
}
```

This ticket **writes** the file and keeps it consistent by hand. The follow-on ticket
`docs-stability-tier-gate` teaches `scripts/check-docs.mjs` to enforce it. Splitting
them keeps this diff pure-docs and gives the gate a settled target to be written
against.

## The ratchet — the one thing that will bite you

`scripts/check-docs.mjs` Check C refuses to let a doc grow past its recorded size in
`docs/.doc-budget.json`. Six of the docs taking a banner are ratcheted:
`lens.md` (17927), `runtime.md` (13018), `schema.md` (15683), `sql.md` (28643),
`sync.md` (14314), `view-updateability.md` (28014). A banner is ~13 words, so each
will fail Check C.

This is precisely the case `docs/doc-conventions.md` § The size ratchet anticipates
("say a convention adds a header line to every topic doc"): the sanctioned path is
`node scripts/check-docs.mjs --update-ratchet --force`, and **the commit message must
carry a line saying why**. Do not work around Check C any other way, and do not edit
the checker to exempt the banner.

`--force` raises *every* doc that grew, not only the ones you touched. So:

1. **Before** editing anything, run `node scripts/check-docs.mjs`. It must print
   `Docs OK`. If it does not, you have a dirty baseline — stop and report it.
2. Make the doc edits.
3. Run `node scripts/check-docs.mjs --update-ratchet --force` and **read the printed
   `RAISED` lines**. Expect exactly six, one per ratcheted doc above, each a delta of
   roughly 13–30 words (`sql.md` and `runtime.md` take a section banner too, so they
   run higher). Any other `RAISED` line, or a delta far outside that range, is
   somebody else's growth riding along — restore that entry's original number by hand
   rather than letting it through.
4. Re-run `node scripts/check-docs.mjs`; it must print `Docs OK`.

Because the runner writes the commit, put the ratchet-raise justification in the
review handoff verbatim, so it can be lifted into the commit body:

> Raised the doc ratchet for six docs: the stability-banner convention adds one
> header line to every user-facing topic doc. See docs/doc-conventions.md § The size
> ratchet.

## Edge cases & interactions

- **Dirty ratchet baseline.** `--force` will happily raise a doc that grew for an
  unrelated reason in the working tree, silently spending the ratchet. The
  before/after procedure above is the guard; the step-1 clean run is not optional.
- **Anchor `#tiers` must exist.** Every banner links `stability.md#tiers`. Check A
  resolves anchors against real headings, so `## Tiers` must be spelled exactly that.
  If you rename it, ~30 banners break at once.
- **README link depth.** From `packages/quereus/README.md` the link is
  `../../docs/stability.md`, not `docs/stability.md`; from a `docs/*.md` it is the
  bare `stability.md`. Check A resolves both, relative to the referrer.
- **Bare `docs/*.md` refs.** Check A also scans `packages/*/src/**/*.ts` and
  `packages/*/test/**/*.ts` for bare `docs/stability.md` references. Writing the file
  first means any such reference resolves; do not reference it from source before it
  exists.
- **`stability.md` is untiered.** The definitions doc must not carry a banner —
  it would be circular, and the follow-on gate will reject a banner on an untiered doc.
- **Section banner vs. header banner.** A tiered doc has exactly one banner in the
  window right below its H1. Section banners live under a lower heading. Do not put
  two banners in the header window; the follow-on gate pins this.
- **Docs whose tier disagrees with a sibling.** `mv-*.md` deep dives are all Beta,
  matching their `materialized-views.md` hub; `optimizer-*.md` are all Internal,
  matching `optimizer.md`. If you find one you think differs, it does not — a deep
  dive inherits its hub's tier, and a genuine difference is a section banner.
- **Do not touch `docs/review.md` / `docs/review.html`.** They are frozen artifacts,
  exempt from every check, and must not be "corrected" — including by adding a banner.
- **`yarn check` runs `test:full`**, which is well past the ten-minute idle window and
  is not agent-runnable. This is a docs-only change: `node scripts/check-docs.mjs` is
  the test that matters. Run `yarn lint` as well if you touch anything under
  `packages/`; you should not need to.

## Expected outputs

- `node scripts/check-docs.mjs` → `Docs OK: links resolve, invariants well-formed, sizes within ratchet.`
- `docs/.stability.json` `docs` + `untiered` keys together name **every** `docs/*.md`
  except `review.md` and `review.html`. Verify by hand this pass:
  `node -e "…"` comparing `readdirSync('docs')` against the JSON — the follow-on
  ticket turns this into a real check.
- Every doc named in `docs/.stability.json`'s `docs` map has its banner tier equal to
  its JSON value.
- `packages/quereus/README.md` renders a four-row tier table linking to
  `../../docs/stability.md`.

## TODO

### Phase 1 — the canonical doc

- Run `node scripts/check-docs.mjs`, confirm `Docs OK`. Stop if not.
- Write `docs/stability.md`: the compatibility-vs-correctness statement, `## Tiers`
  with one `###` per tier and the promise table, then the per-area assignment table
  (feature area → tier → doc link → note), then the three edge calls as short
  rationale bullets. Include the parallel-rules-are-result-preserving paragraph.
- Write `docs/.stability.json` covering every `docs/*.md` except the two frozen
  review artifacts.

### Phase 2 — the banners

- Add the header banner under the H1 of each doc in the `docs` map.
- Add section banners: `sql.md` (declarative schema → Beta), `module-authoring.md`
  (`concurrencyMode` → Experimental), `runtime.md` (the parallel primitives →
  Experimental), `usage.md` (change-scope → Beta).
- Add the isolation-layer honesty sentence to `store.md`: read-committed plus
  read-your-own-writes, not snapshot isolation, no write-write conflict detection.
- Add `## The stability banner` to `docs/doc-conventions.md` recording the exact
  banner form and that a section may override its doc's tier.

### Phase 3 — the README

- Add `### Stability` at the top of `## Current Status` with the compact tier table.
- Add the `[Stability Tiers](../../docs/stability.md)` index entry.
- Tag the three capability bullets: materialized views `(Beta)`, updatable views
  `(Beta)`, logical schemas and lenses `(Experimental)`.

### Phase 4 — the ratchet, then verify

- `node scripts/check-docs.mjs --update-ratchet --force`; read the `RAISED` lines and
  reject any that are not one of the six expected docs.
- `node scripts/check-docs.mjs` → `Docs OK`.
- Hand-verify the `.stability.json` ↔ `docs/*.md` ↔ banner-tier three-way agreement.
- Write the review handoff, quoting the ratchet-raise justification verbatim so the
  runner can lift it into the commit body.
