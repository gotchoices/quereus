description: A logical UNIQUE/PK proved by bijection transport silently drops a declared `on conflict replace`/`ignore` — the basis key's action governs the write-through, not the logical key's. Mirror `rejectRowTimeConflictAction` on the proved-transport arm so the mismatch reds `lens.unenforceable-conflict-action` at deploy.
files:
  - packages/quereus/src/schema/lens-prover.ts                        # classifyKeyConstraint transport arm; rejectRowTimeConflictAction; proveKeyByBijectionTransport; effectiveKeyDefaultConflict
  - packages/quereus/src/schema/table.ts                              # columnsFormDeclaredKey, resolvePkDefaultConflict, UniqueConstraintSchema
  - packages/quereus/test/logic/55.5-lens-authored-inverse.sqllogic   # scenario 23 is the commit-time analog; add proved-transport scenarios after it
  - packages/quereus/test/lens-enforcement.spec.ts                    # classification pins (transport pins at ~970-1017)
  - packages/quereus/docs/lens.md                                     # § Constraint Attachment — conflict-action enforceability
difficulty: medium

# Proved-by-transport key silently drops a declared conflict action

## Reproduced

Confirmed against `view-updates-lens` HEAD via a throwaway spec (deleted after): the
bare-rename transport case below **deploys clean** today — no `lens.unenforceable-
conflict-action`, no advisory — so the declared `replace` is silently dropped and a
duplicate ABORTs via the basis UNIQUE's action.

```sql
declare schema y { table t (id integer primary key, code integer not null unique check (code in (1,2,3))) }
apply schema y;
declare logical schema x {
  table t (id integer primary key, grp integer not null check (grp in (1,2,3)),
           unique (grp) on conflict replace)
}
declare lens for x over y { view t as select id, code as grp from y.t }
apply schema x;   -- deploys CLEAN (the defect); declared `replace` dropped, basis UNIQUE ABORTs
```

## Root cause

`classifyKeyConstraint` (`lens-prover.ts:1459`) returns `proved` from the
bijection-transport arm **before** any conflict-action check:

```ts
if (proveKeyByBijectionTransport(ctx, logicalColumns, bijectiveAuthored)) {
    return { constraint, kind: 'proved' };          // lens-prover.ts:1515 — no conflict check
}
```

A transport-proved key is enforced by the **basis** key, never by the logical key.
The basis key resolves a duplicate as `statement-OR ?? basis-key.defaultConflict ??
ABORT` — the logical key's own `defaultConflict` is never consulted. This is exactly
the hazard the two sibling paths already guard:

- **row-time** — `rejectRowTimeConflictAction` (`lens-prover.ts:1589`) rejects a
  logical REPLACE/IGNORE that differs from `covering.uc.defaultConflict`.
- **commit-time** — the block at `lens-prover.ts:1543` rejects REPLACE/IGNORE with
  `lens.unenforceable-conflict-action` (sqllogic scenario 23 pins this).

The transport arm is the third path and has no such guard.

`proveKeyByBijectionTransport` (`lens-prover.ts:1746`) returns only a boolean
(`columnsFormDeclaredKey(basis, basisCols)`), so the matched basis key — whose
`defaultConflict` actually governs — is not surfaced to the caller. The fix needs it
to return *which* basis key it matched (PK or a specific UNIQUE), the way the
row-time path already has `BasisCovering.uc.defaultConflict`.

## Design

### 1. Surface the matched basis key (`table.ts`)

`columnsFormDeclaredKey` (`table.ts:794`) already walks the basis PK + non-partial
UNIQUEs and returns a boolean. Extract the match itself so callers can read its
action, keeping `columnsFormDeclaredKey` as a thin wrapper (its other caller,
`lens-compiler.ts validatePrimaryAdvertisement`, only needs the boolean and stays
untouched):

```ts
export type DeclaredKeyMatch =
    | { kind: 'primaryKey' }
    | { kind: 'unique'; constraint: UniqueConstraintSchema };

export function findDeclaredKey(table: TableSchema, indices: readonly number[]): DeclaredKeyMatch | undefined {
    const want = new Set(indices);
    const eq = (cols: readonly number[]) => cols.length === want.size && cols.every(c => want.has(c));
    const pk = table.primaryKeyDefinition.map(p => p.index);
    if (pk.length > 0 && eq(pk)) return { kind: 'primaryKey' };
    for (const uc of table.uniqueConstraints ?? []) {
        if (uc.predicate !== undefined) continue; // partial UNIQUE is not a whole-table key
        if (eq(uc.columns)) return { kind: 'unique', constraint: uc };
    }
    return undefined;
}

export function columnsFormDeclaredKey(table: TableSchema, indices: readonly number[]): boolean {
    return findDeclaredKey(table, indices) !== undefined;
}
```

### 2. Return the match from the transport proof (`lens-prover.ts`)

Change `proveKeyByBijectionTransport` to return the matched key (basis + descriptor)
or `undefined` instead of a boolean, so the caller can derive the basis action:

```ts
interface TransportProof {
    readonly basis: TableSchema;
    readonly match: DeclaredKeyMatch;
}
function proveKeyByBijectionTransport(...): TransportProof | undefined {
    ...
    const match = findDeclaredKey(basis, basisCols);
    return match ? { basis, match } : undefined;
}
```

The basis key's governing action (mirroring `effectiveKeyDefaultConflict`'s two arms
exactly — PK uses `resolvePkDefaultConflict`, which also folds in column-level
`defaultConflict`; UNIQUE uses `constraint.defaultConflict`):

```ts
function basisKeyDefaultConflict(p: TransportProof): ConflictResolution | undefined {
    return p.match.kind === 'primaryKey'
        ? resolvePkDefaultConflict(p.basis)
        : p.match.constraint.defaultConflict;
}
```

A human-readable label for the diagnostic (the row-time message names
`covering.ref.name`; here there is no MV, so name the basis key itself):
`primaryKey` → `` basis primary key on '<basis.name>' ``; `unique` →
`` basis unique '<uc.name>' `` (fall back to the column list when `uc.name` is
unset, e.g. `` basis unique (code) ``).

### 3. Gate the transport arm before returning `proved` (`lens-prover.ts:1515`)

```ts
const transport = proveKeyByBijectionTransport(ctx, logicalColumns, bijectiveAuthored);
if (transport) {
    rejectTransportConflictAction(ctx, constraint, transport, label, columnNames, readOnly, errors);
    return { constraint, kind: 'proved' };
}
```

Still classify `proved` — the basis key *does* enforce uniqueness; we only push an
error onto `errors` for the dropped action, exactly as the row-time arm pushes
through `rejectRowTimeConflictAction` while still returning its obligation. A
populated `errors` array blocks the deploy regardless of the obligation kind
(confirm via how `errors` is consumed — same channel the row-time/commit-time
rejecters already use).

### 4. DRY the rejecter

`rejectRowTimeConflictAction` and the new transport rejecter differ only in *where
the basis action + label come from*. Extract a shared core taking primitives so both
funnel into one diagnostic (per AGENTS.md § Stay DRY):

```ts
function rejectBasisGovernedConflictAction(
    ctx, constraint, label, columnNames, readOnly, errors,
    basis: { conflict: ConflictResolution | undefined; label: string },
): void {
    if (readOnly) return;
    const eff = effectiveKeyDefaultConflict(ctx, constraint);
    if (eff !== ConflictResolution.REPLACE && eff !== ConflictResolution.IGNORE) return;
    if (eff === basis.conflict) return; // basis key honors it for free — the documented remediation
    errors.push({ code: 'lens.unenforceable-conflict-action', severity: 'error',
        site: { table: ctx.table.name, constraint: label },
        message: `lens: ${label} on '${ctx.table.name}' (${columnNames.map(c => `'${c}'`).join(', ')}) declares 'on conflict ${conflictActionName(eff)}', but its backing ${basis.label} resolves a duplicate to '${conflictActionName(basis.conflict)}' — the write path honors the basis key's action, not the logical key's, so the declared action would be silently dropped. Declare the matching 'on conflict ${conflictActionName(eff)}' on the basis key, or drop the logical conflict action.` });
}
```

`rejectRowTimeConflictAction` calls it with `{ conflict: covering.uc.defaultConflict,
label: \`covering structure '${covering.ref.name}'\` }`; the transport rejecter calls
it with `{ conflict: basisKeyDefaultConflict(transport), label: <basis-key label> }`.
Keep the wording close to the existing row-time message so the two diagnostics read
consistently.

### Semantics to preserve

- **Only the transport sub-case.** Body-proved keys (`proveEffectiveKeyUnique`, the
  arm at `lens-prover.ts:1505`) are intrinsically unique with no basis key behind
  them — their `on conflict` is vacuous and must keep deploying clean. Do **not** add
  the check to that arm.
- **Reject only REPLACE/IGNORE that differs from the basis action.** ABORT / FAIL /
  ROLLBACK and no-declared-action never reject. A matching action on the basis key
  deploys clean and is honored for free (the documented remediation) — this is the
  positive write-through case to cover in sqllogic.
- **PK and UNIQUE both.** A PK can declare `on conflict` too; the PK transport shape
  (`authored-bijection-pk-reconstructible`) reaches the same arm. `effectiveKeyDefault
  Conflict` already handles the logical PK side via `resolvePkDefaultConflict(ctx.table)`;
  the basis side uses `resolvePkDefaultConflict(p.basis)`.
- **Gate on `!readOnly`.** Consistent with both siblings; a read-only table never
  writes so the action is moot.
- The existing transport pins (`lens-enforcement.spec.ts:970-991`) declare the UNIQUE
  **without** a conflict action — they must keep deploying clean (no REPLACE/IGNORE ⇒
  no rejection). Confirm no regression.

## Tests

### sqllogic — `55.5-lens-authored-inverse.sqllogic` (add after scenario 24)

Scenario 23 is the commit-time analog (no basis key over the put target). Add the
transport analogs — same shapes but **with a basis UNIQUE/PK over the put target** so
they classify `proved`-transport:

- **Bare-reconstructible rename, mismatched action → red.** Basis `code … unique`,
  logical `unique (grp) on conflict replace`, lens `select id, code as grp`. Expect
  `-- error: lens.unenforceable-conflict-action` (this is the headline repro).
- **Authored-bijective +10, mismatched action → red.** Basis `code … unique`, logical
  `unique (grp) on conflict replace`, lens `code + 10 as grp with inverse (code =
  new.grp - 10)`. Expect the same error.
- **Matching action → deploys clean + write honors REPLACE.** Basis `code … unique on
  conflict replace`, logical `unique (grp) on conflict replace`. Deploy clean; then
  `insert (1,1)` / `insert (2,1)` and assert the second **replaces** (basis ends with
  one row `code=1`, the later `id`), proving the action is honored — not ABORTed.
- **PK transport variant.** A logical PK over a bare/bijective column mapping to the
  basis PK, logical PK `on conflict replace` vs a plain-ABORT basis PK → red; matching
  basis PK action → clean. Confirms the PK arm.

### unit — `lens-enforcement.spec.ts`

Alongside the transport pins (~970): add a pin that a transport-proved UNIQUE/PK with
a **mismatched** `on conflict replace` fails `apply schema` with
`lens.unenforceable-conflict-action` (use `expectThrows(..., /unenforceable-conflict-
action/)`), and a pin that a **matching** action still classifies `proved`
(`o.kind === 'proved'`) and deploys clean. Reuse `BIJECTIVE_LENS` and the bare-rename
lens from the existing fixtures.

## Validation

- `cd packages/quereus && yarn test 2>&1 | tee /tmp/t.log; tail -n 60 /tmp/t.log`
  (or scope to the two files via `yarn test:single` while iterating).
- `yarn lint` (single-quote globs on Windows) — also type-checks test call sites after
  the `proveKeyByBijectionTransport` return-type change.
- Update `docs/lens.md` § Constraint Attachment: note the conflict-action enforceability
  rule now covers all three key paths (row-time, commit-time, **and** proved-transport),
  not just the two enforced paths.

## TODO

- Add `DeclaredKeyMatch` + `findDeclaredKey` to `table.ts`; refactor
  `columnsFormDeclaredKey` to delegate.
- Change `proveKeyByBijectionTransport` to return the matched key (`TransportProof`)
  instead of a boolean; add `basisKeyDefaultConflict` + the basis-key label helper.
- Extract `rejectBasisGovernedConflictAction` shared core; rewire
  `rejectRowTimeConflictAction` through it.
- Wire the transport rejecter into the transport arm of `classifyKeyConstraint`
  (still returning `proved`).
- Add the four sqllogic scenarios (bare mismatch, authored mismatch, matching+honored,
  PK variant) after scenario 24 in `55.5-lens-authored-inverse.sqllogic`.
- Add the mismatch-rejects / matching-clean unit pins to `lens-enforcement.spec.ts`.
- Confirm existing transport pins (`:970-991`) still deploy clean.
- Update `docs/lens.md` § Constraint Attachment.
- Run `yarn test` + `yarn lint` green.
