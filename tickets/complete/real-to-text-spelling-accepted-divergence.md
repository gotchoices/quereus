description: Recorded why Quereus keeps JavaScript's spelling (`1`, `Infinity`) instead of SQLite's (`1.0`, `Inf`) when turning a number into text, as an accepted divergence in code comments and docs.
architecture: docs/types.md
files:
  - packages/quereus/src/util/value-text.ts
  - packages/quereus/test/util/value-text.spec.ts
  - docs/types.md
difficulty: easy
---

# Number-to-text spelling recorded as an accepted divergence

Comment and documentation only; no behaviour change (`ticket(implement): real-to-text-spelling-accepted-divergence`).

- `src/util/value-text.ts`: `valueToText` JSDoc states the decision and its two reasons; accepted-tradeoff `NOTE:` on the `case 'number'` arm with revisit condition "REAL/INTEGER get distinct runtime forms".
- `test/util/value-text.spec.ts`: comment on the `1.0` / `Infinity` / `NaN` assertions points at the NOTE. Assertions unchanged.
- `docs/types.md`: paragraph rewritten as decided behaviour with reasons and revisit condition.

## Review findings

- **Correctness of the stated reasons** — checked by running the built engine: `cast(1.0 as text)` → `1`, `cast('Infinity' as real)` → Infinity, `cast('Inf' as real)` → `0`, and `Infinity` round-trips through text and back. `REAL_TYPE.parse` (`types/builtin-types.ts`) uses `parseFloat`, which accepts `'Infinity'` and rejects `'Inf'`. Rules R1/R2 cited in the docs exist in `docs/types.md`. Claims hold. The docs do not claim NaN round-trips (it does not: `parseFloat('NaN')` is NaN and `parse` throws), so nothing misleading there.
- **Stale references** — grepped src, test, docs and open ticket stages for the old slug `bug-real-to-text-formatting-differs-from-sqlite` and "tracked separately"-style pointers to it; none remain. `test/logic/03.6.2-value-to-text.sqllogic` has no comments about the divergence that need updating.
- **Docs formatting** — the rewritten `docs/types.md` paragraph is one unwrapped line while neighbours are hard-wrapped; consistent with the project's no-hard-wrap rule, left as is.
- **Duplication** — the JSDoc paragraph and the `NOTE:` say overlapping things; acceptable, since the NOTE is the greppable decision record and the JSDoc is the API description. No change.
- **Tests** — none added or cut; the existing spec already pins the spellings. Nothing to add for a comment-only change.
- **Out of scope (unchanged)** — NaN admission into the value domain (SQLite stores NULL) remains outside this ticket; related backlog item is `bug-sliding-window-sum-poisoned-by-non-finite-real`.
- **Major findings / tripwires** — none; no tickets filed.
- **Validation** — `yarn workspace @quereus/quereus run lint` clean. Full test suite not re-run in review: the diff only touches comments and docs; the implement pass ran it (11181 passing, 0 failing).
