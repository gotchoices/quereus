description: Extend the host-conditional replicable-derivation gate to custom collations. A custom collation that governs derived bytes (comparison / ORDER BY / GROUP BY / DISTINCT / backing key) can fold or sort differently across peers' platforms and diverge derived bytes, yet the shipped function-only gate does not see it. Add a `replicable` flag to collation registration (built-ins auto-qualify, custom collations opt in), reuse the existing `requiresReplicableDerivations` host capability, and reject a non-replicable custom collation in a derivation body at create. Inert by default; exercised via the existing test host.
prereq: replicable-determinism-class
files:
  - packages/quereus/src/core/database-materialized-views.ts      # add findNonReplicableCollation + nonReplicableCollationDerivationError; wire into the existing host-conditional block in buildMaintenancePlan
  - packages/quereus/src/core/database.ts                         # collations Map entry gains `replicable?`; registerCollation options; registerDefaultCollations stamps builtins; new _isCollationReplicable
  - packages/quereus/src/util/comparison.ts                       # normalizeCollationName / builtin names (BINARY/NOCASE/RTRIM) — reference only
  - packages/quereus/src/common/datatype.ts                       # ScalarType.collationName / collationSource — the per-scalar-node carrier the walk reads
  - packages/quereus/src/schema/table.ts                          # ColumnSchema.collation (+ collationExplicit); UniqueConstraintSchema column collations — backing-key second source
  - packages/quereus/src/vtab/backing-host.ts                     # requiresReplicableDerivations doc: now governs collations too (reused, no new flag)
  - packages/quereus/test/materialized-view-replicable.spec.ts    # extend with collation cases (reuse ReplBackingModule/demandReplicable host)
  - docs/migration.md                                             # § Determinism requirements — note collations now covered
  - docs/materialized-views.md                                    # create-time gate — note the replicable-collation reject
difficulty: medium
----

# Replicable collation class

The shipped `replicable-determinism-class` validates that every **function** in a
derivation body is REPLICABLE (bit-identical across peers/platforms/app-versions) when the
resolved backing host declares `requiresReplicableDerivations`. Custom **collations** are a
parallel divergence surface the function gate does not cover: an embedder-registered
collation (e.g. a locale-aware ordering) whose sort/fold governs derived bytes can produce
different bytes on different peers' platforms — exactly the hazard the replicable class
exists to prevent — and the function-only walk never sees it.

This ticket closes that blind spot with a **second gate of the same shape**, under the
**same host capability**, **inert by default** (no in-tree host sets the flag; exercised via
the existing `ReplBackingModule` test host). Built-in collations (`BINARY`, `NOCASE`,
`RTRIM`) auto-qualify — they are pure JS string operations (`<`/`>`, locale-independent
`toLowerCase()`, ASCII-space trim), bit-identical across peers' JS engines, exactly
parallel to why built-in functions auto-qualify. A custom collation opts in with
`replicable: true` at registration. Orthogonal to the determinism gate — **not** lifted by
`pragma nondeterministic_schema`.

## Why a collation is a divergence surface

Derived bytes = the set of rows stored in the backing plus their values. A custom collation
changes derived bytes only through an operation that **folds or orders** by it:

- **membership** — a comparison (`=`, `<`, `IN`, `BETWEEN`) in WHERE / ON / HAVING, or
  DISTINCT / set-op dedup, under the collation;
- **key identity / merge** — GROUP BY under the collation, or the backing PK / secondary
  UNIQUE folding two source identities (`'Bob'`/`'bob'`) onto one key (last-writer-win — the
  coarsened-key collision surface);
- **observable order** — ORDER BY + LIMIT, or window framing, under the collation.

A custom collation that diverges across peers at any of these sites diverges the stored
bytes. (A bare value passthrough copies bytes verbatim and is byte-safe; see the soundness
note below for why the gate still flags it — deliberately conservative.)

## Where the collation name lives, and how the walk finds it

Unlike functions — which carry a single `functionSchema` on exactly the function-bearing
node kinds, walked by `findNonReplicableFunction` (`database-materialized-views.ts`) — a
collation has **no single node**. The collation name that governs an operation always rides
on a scalar node's resolved type as `ScalarType.collationName` (`common/datatype.ts`),
because every fold/order/key site resolves through some scalar:

- an explicit `COLLATE name` produces a `CollateNode` whose `getType().collationName` is the
  name, `collationSource: 'explicit'` (`planner/nodes/scalar.ts`);
- a column declared `COLLATE name` propagates the name on every column-reference type,
  `collationSource: 'declared'` (or `'default'` for the session `default_collation`);
- a comparison's *effective* collation is resolved from operand types via the lattice
  (`planner/analysis/comparison-collation.ts`); ORDER BY / GROUP BY / DISTINCT keys are
  scalar expressions whose types carry the collation. In every case the name is present on
  some scalar node's type.

So **one scalar walk reading `getType().collationName`** uniformly reaches every body site —
no per-operation enumeration. This mirrors `findNonReplicableFunction`'s `getChildren()`
recursion (covering nested calls, subqueries/CTEs, MV-over-MV bodies whose source columns
carry the producing backing's published collation).

### The one site the body walk cannot reach — backing key collations

A custom collation can govern the **backing key merge** without appearing on any *body*
scalar type — a maintained table declared with an explicit `UNIQUE (... COLLATE custom)`
or PK collation that the SELECT body does not itself name (MV-sugar backings declare no
constraints, but a `create table … ` maintained table can). The gate therefore has a
**second source**: the maintained table's own PK column collations + declared secondary
UNIQUE constraint column collations, read from `mv` (`schema/table.ts`:
`ColumnSchema.collation`, `UniqueConstraintSchema`). (The coarsened-key output collation
originates from a body column's declared collation, so it is already covered by source 1,
but checking the declared key collations directly is the robust closure.)

## Soundness vs. precision — deliberate conservatism

This is a **convergence-safety** gate: a false negative (missing a real divergence) is
catastrophic — silent peer divergence, the exact hazard. A false positive (rejecting a body
that references a custom collation it never actually folds by — e.g. a bare passthrough of a
custom-collation column whose backing column is not in any key) is a create-time
inconvenience with a clear, documented fix: declare the collation `replicable: true`, or use
`COLLATE BINARY`. The gate therefore biases hard toward soundness: **any** non-builtin
collation name present on **any** body scalar type (or on a backing key column) rejects —
exactly the all-or-nothing stance of the function gate (`schema.replicable !== true`
anywhere rejects). Document this tradeoff in the error/diagnostic and the spec comment so a
future precision pass (gate only fold/order/key positions) is a known, scoped enhancement,
not a surprise.

## Registration surface

The per-database collation registry (`database.ts`) stores
`Map<string, { comparator: CollationFunction; normalizer?: (s:string)=>string }>`. Add an
optional `replicable?: boolean` to that entry.

`registerCollation(name, func, normalizer?)` is positional. Add the flag without an ugly
4th positional by accepting an **options object** in the third slot as an alternative to the
bare normalizer:

```ts
registerCollation(
  name: string,
  func: CollationFunction,
  optionsOrNormalizer?: ((s: string) => string) | { normalizer?: (s: string) => string; replicable?: boolean },
): void
```

- third arg is a function ⇒ legacy normalizer-only (existing call sites unchanged,
  `replicable` defaults to `false` — the conservative default for a custom collation);
- third arg is an object ⇒ read `normalizer` / `replicable` from it.

`registerDefaultCollations` stamps `replicable: true` on the three built-in entries
(`BINARY`, `NOCASE`, `RTRIM`) — the single seam that *knows* a collation is a builtin, exactly
parallel to `registerBuiltinFunctions` stamping `replicable: true` on builtins.

New `@internal _isCollationReplicable(name: string): boolean`:
`this.collations.get(name.toUpperCase())?.replicable === true`. An unknown collation
(should be impossible — an unknown collation in a body errors earlier at create) returns
`false` defensively.

## Gate wiring

In `buildMaintenancePlan` (`database-materialized-views.ts`), inside the **existing**
`if (host.requiresReplicableDerivations)` block, **after** the function check:

```ts
const offendingFn = findNonReplicableFunction(analyzed);
if (offendingFn) throw nonReplicableDerivationError(mv.name, offendingFn);
const offendingCollation = findNonReplicableCollation(analyzed, mv, db);
if (offendingCollation) throw nonReplicableCollationDerivationError(mv.name, offendingCollation);
```

No new host flag — `requiresReplicableDerivations` now governs functions **and** collations
(update its doc in `vtab/backing-host.ts` and the header section accordingly: a host whose
backing replicates demands bit-identity of every function *and* collation in the body).

`findNonReplicableCollation(analyzed, mv, db)`:
- walk the plan (`getChildren()` recursion, same shape as `findNonReplicableFunction`); for
  each scalar node read `getType().collationName`; if present, normalize
  (`normalizeCollationName`) and — when it is **not** a built-in — require
  `db._isCollationReplicable(name)`; first failure returns the name;
- then check the maintained table's PK column collations + declared secondary UNIQUE
  constraint column collations (`mv` schema); first non-builtin non-replicable name returns;
- return `undefined` when every collation qualifies.

(Built-ins short-circuit to OK regardless of `collationSource`, so the walk needs no rank
reasoning — a `default` BINARY and an `explicit` NOCASE both pass; only a custom name is
ever subjected to `_isCollationReplicable`.)

`nonReplicableCollationDerivationError(mvName, collationName)` — a dedicated
`StatusCode.UNSUPPORTED` error, parallel to `nonReplicableDerivationError`: it names the
collation, says this host requires every collation in the body be bit-identical across
peers, steers to declaring the collation `replicable: true` at registration (built-ins
qualify automatically), and does **not** steer to a plain view (the body is fine — it just
folds under a collation the host requires be replicable).

## Edge cases & interactions

- **Explicit `COLLATE custom`** in WHERE / ON / HAVING / ORDER BY / GROUP BY / DISTINCT /
  projection → rejected, error names the collation. (Each rides a `CollateNode` type.)
- **Declared custom collation on a source column** that backs the MV key → rejected.
- **Declared custom collation on a passed-through non-key column** → rejected (deliberate
  conservative over-reject; documented above — fix: declare replicable or COLLATE BINARY).
- **Backing PK / secondary UNIQUE under a custom collation not named in the SELECT body**
  → rejected by the second source (the body walk alone would miss it).
- **Coarsened-key output collation custom** → rejected (covered by source 1; second source
  is the robustness closure).
- **Built-in collations** (`BINARY`/`NOCASE`/`RTRIM`) anywhere → accepted (auto-qualify).
- **`pragma default_collation = <custom>`** so body columns resolve to it with
  `collationSource: 'default'` → still rejected if custom & non-replicable (the walk collects
  any name; only builtins short-circuit, regardless of source rank).
- **Custom collation declared `replicable: true`** → accepted.
- **Nested COLLATE** (a COLLATE inside an expression inside a comparison) and **collation
  used only in a subquery / CTE / set-op leg** within the body → reached by the
  `getChildren()` recursion.
- **MV-over-MV body** (reads another MV's backing) → the source columns carry the producing
  backing's published collation on their resolved types → covered.
- **Inert by default** — memory / store host leaves `requiresReplicableDerivations` undefined
  ⇒ the whole block is skipped ⇒ zero behavior change for an ordinary `using memory` / store
  MV. (No new per-row work; this is a create-time-only walk.)
- **Re-register / catalog import idempotence** — same body ⇒ same verdict, so a tampered
  catalog cannot smuggle a non-replicable-collation body past a demanding host (parallels the
  function-gate note). The gate runs on every `registerMaterializedView`.
- **Orthogonal to `pragma nondeterministic_schema`** — NOT lifted by it; a replicating host's
  bit-identity requirement cannot be locally waived without breaking convergence (same stance
  as functions).
- **Legacy `registerCollation(name, func, normalizerFn)` call sites** — unchanged; the
  function-typed third arg routes to the normalizer-only path, `replicable` defaults to
  `false`. Verify no in-tree call site passes a custom collation a synced MV would need (the
  sample `custom-collations` plugin is for ORDER BY, not synced derivation — no change).
- **Comparator-only custom collation** (no normalizer — cannot back a compound index, ORDER
  BY only) → if it governs the body it is still flagged; the `replicable` flag is independent
  of the normalizer.

## Tests (extend `test/materialized-view-replicable.spec.ts`)

Reuse the existing `demandReplicable` / `ReplBackingModule` harness (the memory host with
`requiresReplicableDerivations` flipped on). `db.registerCollation` is available on the test
`Database`. Key cases and expected outcomes:

- `order by c collate MYLOCALE` (MYLOCALE registered non-replicable) over the repl host →
  **rejected**, error message contains `MYLOCALE`.
- `where c = :x collate MYLOCALE` → **rejected**.
- source column declared `COLLATE MYLOCALE` projected into the MV backing key → **rejected**.
- the same body with `MYLOCALE` registered `replicable: true` → **accepted** (no throw).
- `COLLATE NOCASE` (built-in) anywhere in the body → **accepted**.
- a custom-collation body over a **plain memory host** (flag off) → **accepted** (inert by
  default — pins zero behavior change).
- maintained table with a declared `UNIQUE (… COLLATE MYLOCALE)` not named in the SELECT →
  **rejected** (pins the second source).
- negative control: the existing replicable-**function** cases still pass unchanged (no
  regression of the function gate from the shared block edit).

## Validation

- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`).
- `yarn test` — full quereus suite green, including the extended focused spec; every other
  workspace green. Run the focused spec explicitly to confirm the new collation cases.
- `yarn test:store` is **not** required (the gate is create-time, memory-exercised, and the
  store host leaves the flag undefined) — but note in the handoff that the store backing
  host's create-time path is not exercised by `yarn test`, the same caveat the function gate
  carried.

## TODO

- [ ] `database.ts`: add `replicable?` to the `collations` Map entry type; widen
  `registerCollation`'s third parameter to `normalizer | { normalizer?, replicable? }` and
  branch on its type; stamp `replicable: true` on the three builtins in
  `registerDefaultCollations`; add `_isCollationReplicable(name)`.
- [ ] `database-materialized-views.ts`: add `findNonReplicableCollation(analyzed, mv, db)`
  (scalar-type walk + backing-key second source) and `nonReplicableCollationDerivationError`;
  wire both into the existing `requiresReplicableDerivations` block after the function check.
- [ ] `vtab/backing-host.ts`: update the `requiresReplicableDerivations` doc + the
  "Replicable-determinism requirement" header section to state it now governs collations too.
- [ ] `test/materialized-view-replicable.spec.ts`: add the collation cases above (reuse the
  existing host harness).
- [ ] `docs/migration.md` (§ Determinism requirements) and `docs/materialized-views.md`
  (create-time gate): note custom collations are now covered alongside functions.
- [ ] `yarn lint` + `yarn test` green; run the focused spec explicitly.
