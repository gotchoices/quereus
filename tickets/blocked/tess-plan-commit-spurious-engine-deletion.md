description: A plan-stage tess commit (1cf7326c on `view-updates-lens`) spuriously deleted the entire `packages/quereus` engine (901 files, 250,548 deletions) instead of only moving ticket files. The implement commit 18e21a1f already restored the engine and all 4911 tests pass at HEAD, so the symptom is recovered — but the root cause lives in the tess runner's commit step (likely a `git add -A` over a transiently-empty working tree) and could recur on any branch/run. This ticket captures the incident for a runner-side fix; there is no quereus engine code change to make.
files:
  - tess/scripts                                   # tess runner / ticket-transition + commit orchestration (suspect: stages all changes incl. spurious deletions)
  - packages/quereus                               # the package that was deleted and restored (affected area; no code change needed here)
----

**BLOCKED — human sign-off (infrastructure).** The tess-runner transition commit step (likely `git add -A`) can capture spurious whole-tree deletions — it deleted the entire engine package once (recovered at HEAD). The body notes "runner internals are outside this repo," so a human must decide whether/where to fix it and which of the three suggested directions. *Not auto-worked:* unsupervised self-modification of the runner's own commit machinery is too high blast-radius.

# Plan-stage runner produced a 250k-line deletion of the engine package

## Symptom (as originally observed)

While starting the implement ticket `1-view-write-decomp-stitch-key-unique-guard`,
its target files (`packages/quereus/src/schema/lens-compiler.ts`, etc.) had
vanished. The immediately-preceding **plan-stage** commit:

```
1cf7326c ticket(plan): view-write-decomposition-optional-update-hardening
```

— which should only move/create ticket files under `tickets/` — also deleted the
entire `packages/quereus` SQL-engine package, leaving it empty at that commit.
Any build or test run at `1cf7326c` would fail outright (no engine to compile).

## Current status at HEAD: RECOVERED (do not re-fix)

The next commit, `18e21a1f` (implement: view-write-decomp-stitch-key-unique-guard),
restored the full package from the pre-deletion parent and layered the ticket's
guard changes on top. Verified at HEAD (`18e21a1f`):

- `git ls-tree -r HEAD -- packages/quereus | wc -l` → `898` (full package present)
- `git diff --stat 3a5a7ef5 HEAD -- packages/quereus` → only the 3 intended guard
  files (`decomposition.ts` +12, `lens-compiler.ts` +69, `lens-put-fanout.spec.ts` +156)
- `yarn test` in `packages/quereus` → **4911 passing, 9 pending**

So the deleted-files failure no longer reproduces. This ticket is NOT a request to
re-restore the engine — it is to address the runner behavior that caused the loss.

## Evidence the deletion was spurious (not a code/content problem)

- `git show --stat 1cf7326c` → `901 files changed, 361 insertions(+), 250548 deletions(-)`,
  deleting `packages/quereus/package.json`, `src/**`, `test/**`, `bench/**`, etc.
- `git ls-tree -r 1cf7326c -- packages/quereus | wc -l` → `0`
- `git ls-tree -r 3a5a7ef5 -- packages/quereus | wc -l` → `898` (parent intact)
- `packages/quereus` is present and intact on `main` and `dev`.

## What was ruled out

- **No other state was lost.** The only non-`packages/quereus` changes in `1cf7326c`
  are the legitimate plan→implement ticket-file moves:
  - `A tickets/implement/1-view-write-decomp-stitch-key-unique-guard.md`
  - `A tickets/implement/2-view-write-decomp-update-test-coverage.md`
  - `D tickets/plan/view-write-decomposition-optional-update-hardening.md`
- **Not an engine bug / not a test bug.** The package contents are byte-identical to
  the known-good parent; the failure was purely the absence of files. With the files
  present, the full suite passes.
- **Not specific to this branch's code.** The package is intact on `main`/`dev`/parent.

## Likely root cause (for the runner-side fix)

A plan-stage transition should commit only `tickets/**` moves. Producing a 250k-line
deletion suggests the runner staged the whole tree (e.g. `git add -A` / `git add .`)
at a moment when the working tree was transiently empty or `packages/quereus` was
absent (interrupted checkout, clean step, or a cwd/path glitch), then committed the
deletion. Because the runner commits whatever is staged after the agent exits, a
transient empty/partial tree at the wrong instant is captured permanently.

Suggested directions (not verified — runner internals are outside this repo):
1. Plan/transition commits should restrict their pathspec to `tickets/**` rather than
   staging the whole tree, so engine files can never be deleted by a ticket move.
2. Add a guard that aborts the commit if a plan/transition stage would delete files
   outside `tickets/**` (or exceeds a sane deletion threshold).
3. Investigate whether a transient empty working tree can occur between the agent's
   exit and the runner's `add`/`commit`, and serialize/verify the tree first.

## Repro / verification commands

```
git show --stat 1cf7326c | tail -3
git ls-tree -r 1cf7326c -- packages/quereus | wc -l   # 0
git ls-tree -r 3a5a7ef5 -- packages/quereus | wc -l   # 898
git ls-tree -r HEAD     -- packages/quereus | wc -l   # 898 (recovered)
```
