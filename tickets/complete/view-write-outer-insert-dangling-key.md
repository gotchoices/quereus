description: A both-side outer-join INSERT through a view threaded the minted shared key into the preserved (FK-child) side's join column unconditionally; for a row whose presence-gated non-preserved (FK-parent) partner is absent, this left a dangling FK (CHECK failure under `pragma foreign_keys = on`, latent spooky-join otherwise). Fixed by a per-row conditional key thread (`keyGate`): the FK-child's minted-key column projects `null` for rows whose referenced presence-gated partner is absent.
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/test/property.spec.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
----

## Outcome

The implement-stage fix (per-row conditional `keyGate` nulling an FK-child's **minted**
shared-key column when its presence-gated FK-parent partner is absent) is correct for the
2-side minted-key case it targeted. Review found and fixed one mainstream correctness bug
inline, and filed one exotic-shape correctness gap as a backlog ticket. Build, lint, and
the full quereus suite are green.

## Review findings

### Checked

- **Implement diff, fresh eyes** — `multi-source.ts` (`MsInsertSide.keyGate`, the populate
  loop), `view-mutation-builder.ts` (`envelopeColumnScope`, `presencePredicateSql`,
  `buildGatedKeyProjection`, the gated projection swap), the sqllogic + property tests, the
  doc note.
- **Envelope index alignment** — `keyGate.groups` reuse the partner's `presenceGateIndices`
  (indices into `supplied`), resolved through the same `envelopeColumnScope` /
  `envelopeAttrs` the already-shipped `buildPresenceGate` uses; `keyTargetIndex: 0` matches
  the key being pushed first under `needsSharedKey`. Consistent — low risk.
- **2-side routing** — the four acceptance cases (FK-on null-partner drop, happy-path
  thread, multi-row mix, parent-preserved anchor shape) re-confirmed via the shipped tests
  and direct probes.
- **n-way reachability** — confirmed the >2-side path is reachable (the decomposition is
  genuinely n-way), and that the two-distinct-FK-column star is rejected at plan time
  (`composite shared key`), so the only shape reaching `groups.length === 2` is a single
  shared-key column spanning two optional parents.

### Found + fixed inline (minor → fixed this pass)

- **Supplied key was wrongly gated (data loss + orphan).** A view exposing its join key as
  a writable column: `insert into v (cc, k, cv, pv) values (7, 42, 99, null)` points the
  child at a **pre-existing** parent `pp=42`, leaving `pv` null (the parent already exists).
  The `keyGate` fired (partner `pv` absent) and **nulled the user-supplied key** → child
  `pr = null`, view read `{k:null, pv:null}` — the explicit `k=42` silently discarded and
  the child orphaned. **Fix:** guard the `keyGate` populate loop on `suppliedKeyIndex < 0`
  so only the engine-**minted** key is gated; a supplied key is threaded verbatim (it may
  reference a pre-existing parent, and FK enforcement is the correct validator of a
  genuinely dangling supplied reference). Regression added to `93.4-view-mutation.sqllogic`
  (the FK-on block, `skp`/`skc`/`skv`); doc note in `view-updateability.md` clarified to
  "minted key only". Post-fix the supplied key is preserved and the child joins the
  pre-existing parent (`{cc:7, k:42, cv:99, pv:4242}`).

### Found + filed (major → new ticket)

- **n-way single-shared-key / two-optional-parents: orphan + silent data loss.** A child
  with one FK column referencing two optional parents (`pr references p1(pp) references
  p2(qq)`, joined to both on `pr`). Supplying one parent but not the other ANDs both
  presence predicates → the whole key is nulled → the child references neither parent, yet
  the supplied parent still materializes (its own presence gate) as an unreferenced orphan,
  and the supplied value is invisible through the view. A single shared-key column cannot
  reference one parent but not the other, so the right behavior is a semantics decision
  (reject partial supply / all-or-none drop / per-parent key columns) — filed as
  **`view-write-outer-insert-shared-key-multi-parent-orphan`** (backlog) with repro and
  options. Not auto-fixed because it requires the basis author's intent.

### Checked + benign (no action)

- **Minted key still evaluated for dropped rows** — the envelope always appends
  `__shared_key`, so `max()+mutation_ordinal()` is computed even when the row's `pr` ends up
  null. Harmless (value unused); `mutation_ordinal()` advancing for those rows is the
  documented per-row envelope behavior, not a defect.
- **`sideDeclaresFkOnto` triggers on the declared FK while the column nulled is the join
  key** — for every decomposable shared-key view the join key *is* the FK column, so they
  coincide and nulling the join key is exactly the "no partner" marker. The FK-on-a-
  different-column shape would null the join key (still a correct join marker) and is benign
  for the dangling-FK concern.
- **NOT NULL minted-key join column** — a LEFT-joined FK-child whose join key is NOT NULL is
  a contradictory shape (a NOT NULL FK forces a match, i.e. inner-join semantics); it fails
  on either the pre-fix dangling-FK path or the post-fix NOT NULL path, so the gate
  introduces no new hazard.
- **Pre-existing TS language-server hints** in `property.spec.ts` (~lines 210/249/1457) are
  outside this diff and do not fail build/lint/test (lint is clean) — not a `.pre-existing-
  error.md`-worthy failure.

### Validation

- `yarn workspace @quereus/quereus run build` → clean (exit 0).
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- `yarn workspace @quereus/quereus run test` → **4814 passing, 9 pending**, exit 0 (with the
  inline fix and the new supplied-key sqllogic regression).
