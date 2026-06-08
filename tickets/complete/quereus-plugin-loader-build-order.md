description: Fix Yarn `-At` topological build order by declaring runtime/build-time workspace deps in `dependencies` (was peer/dev-only) across plugin-loader + 7 sibling packages, plus sync-client (found in review)
files: packages/plugin-loader/package.json, packages/quereus-isolation/package.json, packages/quereus-store/package.json, packages/quereus-sync/package.json, packages/quereus-sync-client/package.json, packages/quereus-plugin-leveldb/package.json, packages/quereus-plugin-indexeddb/package.json, packages/quereus-plugin-react-native-leveldb/package.json, packages/quereus-plugin-nativescript-sqlite/package.json, yarn.lock

# plugin-loader (and siblings) build-order fix — completed

## What the bug was

`yarn workspaces foreach -At ... run build` (`-At` = `--all --topological`) only follows
`dependencies` edges when ordering workspaces. Several `@quereus/*` packages imported sibling
workspaces (`@quereus/quereus`, `@quereus/store`, `@quereus/isolation`, `@quereus/sync`) at
build time but declared them **only** in `peerDependencies` + `devDependencies`. Yarn treated
them as leaves, scheduled them before the producer's `dist/` existed, and `tsc` failed with
`TS2307: Cannot find module …`. `plugin-loader` was the first leaf attempted, aborting the
batch in <1s. The repo's own `yarn build` never hit this because it hand-orders packages.

## What changed

Promoted every build-time cross-workspace import into `dependencies` (keeping
`peerDependencies` intact so the host-provides-the-engine publish contract still advertises;
removed the now-redundant `"*"` `devDependencies` entries). Packages touched:

| Package | Added to `dependencies` |
| --- | --- |
| `@quereus/plugin-loader` | `@quereus/quereus` |
| `@quereus/isolation` | `@quereus/quereus` |
| `@quereus/store` | `@quereus/quereus`, `@quereus/isolation` |
| `@quereus/sync` | `@quereus/quereus`, `@quereus/store` |
| `@quereus/plugin-leveldb` | `@quereus/quereus`, `@quereus/store` |
| `@quereus/plugin-indexeddb` | `@quereus/quereus`, `@quereus/store` |
| `@quereus/plugin-react-native-leveldb` | `@quereus/quereus`, `@quereus/store` |
| `@quereus/plugin-nativescript-sqlite` | `@quereus/quereus`, `@quereus/store` |
| `@quereus/sync-client` | `@quereus/sync` *(added during review — see findings)* |

`yarn.lock` refreshed. `@quereus/isolation` correctly left out of the plugins' and sync's
`dependencies` — verified none of them import it in `src/` (it's a peer for the runtime
isolation contract only, exercised via tests).

## Review findings

### What was checked
- Full implement diff (8 package.json + yarn.lock) read first, with fresh eyes.
- Verified each package's **actual `src/` imports** match its declared deps:
  `@quereus/store` is a value import (runtime) everywhere it's declared; `@quereus/quereus`
  is type-only in the plugins/sync (in `dependencies` solely so `tsc` resolves its `.d.ts`
  during the topo build — no TS project-references/`paths` mapping exists, confirmed); the
  plugins and `sync` do **not** import `@quereus/isolation` in `src/`, so leaving it out of
  their `dependencies` is correct.
- Lock-file consistency: `yarn install --immutable` → exit 0 (only the documented
  pre-existing `YN0002` peer warnings).
- **The actual repro**: `yarn clean` then `yarn workspaces foreach -At --jobs 1` over the
  engine + loader + isolation + store + 4 plugins + sync + sync-client + sync-coordinator +
  cli → **exit 0**, `dist/` produced for all. (foreach aborts non-zero on any failure, so
  exit 0 under `--jobs 1` proves correct ordering.)
- Lint (`yarn lint`) → exit 0. Full test suite (`yarn test`) → **0 failing**, 9 pending,
  ~4600 passing across 12 workspaces, "Done in 2m 2s".

### Major — filed as new ticket
- **`fix/workspace-build-tool-and-ordering-gaps`**: `quereus-vscode` and `sample-plugins`
  still cannot build under `foreach`/`-At` — they invoke bare `esbuild`/`tsc` they don't
  declare (rely on root hoisting, which isn't on a child workspace's script PATH under Yarn
  4), and both also lack the `@quereus/quereus` `dependencies` edge despite build-time value
  imports. Pre-existing (fail identically at HEAD via the standard build path) and a distinct
  bug class from dependency ordering, so split out rather than expanded into this ticket.
  Ticket also captures a related clean-build quirk: `yarn clean` leaves package-root
  `*.tsbuildinfo`, so `tsc --incremental` skips emit (observed: `quoomb-cli` produced no
  `dist/` until its buildinfo was deleted).

### Minor — fixed inline (this ticket)
- **`quereus-sync-client`** had the *same* latent `-At` bug the ticket set out to fix:
  `src/serialization.ts` / `src/sync-client.ts` import **values** (`decodeSqlValue`,
  `compareHLC`) from `@quereus/sync`, yet it declared `@quereus/sync` only in
  `peerDependencies` + `devDependencies` (`"*"`). The implement handoff incorrectly claimed
  sync-client "already declared these in dependencies" — only `@quereus/quereus` was. Promoted
  `@quereus/sync` to `dependencies` (kept peer, dropped the redundant dev `"*"`), mirroring
  the established pattern; confirmed it now builds after `@quereus/sync` under `-At --jobs 1`.

### Verified clean / no action
- `quoomb-web`, `quoomb-cli`, `sync-coordinator` already declare their engine deps in
  `dependencies` — correct, untouched.
- Pre-existing `YN0002` peer warnings (under-declared `@quereus/isolation` peer surfaced via
  `sync` consumers, `@types/node`/`ts-node`, `storybook`) are untouched — separate cleanup.

### Scope note
The implementer's broader-than-literal scope (all 8 affected packages, not just
plugin-loader) was the right call and is accepted: fixing only plugin-loader leaves `-At`
failing on the next leaf. The sync-client addition extends that same reasoning to the one
library leaf the implementer missed; vscode/sample-plugins go further into a separate
tooling-gap class and were therefore split into their own ticket rather than piled on here.
