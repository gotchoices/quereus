# Release Process

## Overview

Quereus uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v1.0.0`).

## Release notes

Curate release notes during the cycle in an **untracked** `.release-notes.pending.md`
at the repo root (gitignored). When `yarn gh-release` runs, it uses that file as the
GitHub release body and then consumes (deletes) it. If the file is absent, the release
falls back to GitHub's auto-generated notes — so the file is entirely optional. There is
no committed `CHANGELOG.md`; the published GitHub releases are the canonical history.

## Prerequisites

- `yarn build` succeeds
- `yarn check` passes
- Clean working tree (`git status` shows no uncommitted changes)

## Quick Release

```bash
yarn release
```

This first runs `scripts/release-guard.js` — an interactive gate that prints a banner and requires you to type `yes` to confirm `yarn check` passed on this commit (it aborts on a non-interactive terminal). Only then does it run `yarn bump` (interactive version prompt, commits, tags, pushes), `yarn pub` (clean + build + publish each package), `yarn await-published` (waits until npm serves every package at its new version — see [When the release is finished](#when-the-release-is-finished)), and `yarn gh-release`.

### When the release is finished

`yarn pub` returns once npm has accepted every publish, but npm starts serving each new version at its own moment, sometimes a minute or more apart. A downstream upgrade run in that gap resolves new versions of some packages beside old versions of others. So `yarn release` runs `yarn await-published` (`scripts/await-published.mjs`) before `yarn gh-release`. It takes the packages to wait for from the `pub` chain in the root `package.json` — the same derivation `scripts/check-docs.mjs` uses (`scripts/published-packages.mjs`), not the workspace list, which also holds public workspaces `pub` does not publish — and asks npm about each every 5 s until all are served.

"Served" means two things, checked in order. `npm view <name>@<version>` must list the version, and the version's tarball — the file `npm install` downloads, at the `dist.tarball` URL npm gives — must answer a `HEAD` request with 200. The registry makes the tarball available separately from the version listing, and later: for sereus 1.8.0 every version was listed while three tarballs still answered 404 several minutes afterwards, so an install run on the listing alone would have failed.

The script's last line is the one to wait for:

```
all 14 packages published and visible on npm at 4.19.4
```

**Upgrade downstream repositories only after that line.** Before it, an upgrade can resolve a mix of versions, or fail to download one. The GitHub release is created only after it, too.

If ten minutes pass first (`QUEREUS_PUBLISH_WAIT_SECONDS` changes the deadline), it lists each package still missing, with the reason — not listed yet, listed but its tarball not downloadable yet, or the error npm or the tarball request reported — and exits non-zero, so `yarn gh-release` does not run. npm has already accepted the publish at that point: **do not re-run `yarn release`** (it would bump to yet another version). Once the registry catches up, run `yarn await-published` again, then `yarn gh-release`. The script can be run on its own at any time and reports on the versions currently in the manifests. Its decision logic is tested by `yarn test:scripts` (part of `yarn test`), without the network.

## Step by Step

### 1. Ensure a clean working tree

```bash
git status          # no uncommitted changes
git pull origin main
```

### 2. Bump, commit, tag, and push

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump

# Or specify the release type directly
yarn bump --release patch
yarn bump --release minor
yarn bump --release major
```

`bumpp` will:
1. Update `version` in all `package.json` files (recursive)
2. Commit the changes
3. Create an annotated tag: `v{version}`
4. Push the commit and tag to `origin`

### 3. Publish to npm, and wait until npm serves it

```bash
# Publish all public packages (clean + build + publish each)
yarn pub

# Wait until npm serves every one of them at the new version
yarn await-published
```

See [When the release is finished](#when-the-release-is-finished) for what the wait's last line means.

Or publish individually:

```bash
yarn pub:quereus
yarn pub:store
yarn pub:sync
# etc.
```

### 4. Create a GitHub release

```bash
yarn gh-release
```

Uses `.release-notes.pending.md` as the body if present (then deletes it), otherwise
falls back to `gh release create v{version} --generate-notes`.

## Prerelease / RC

```bash
yarn bump --release prerelease --preid rc    # e.g. 1.1.0-rc.0
yarn bump --release prerelease --preid beta  # e.g. 1.1.0-beta.0
```

Publish prereleases with a dist-tag so they don't become `latest`:

```bash
# Manually publish each package with --tag next
```

## Hotfix

1. Branch from the release tag: `git checkout -b hotfix/v1.0.1 v1.0.0`
2. Apply the fix, commit
3. Bump: `yarn bump --release patch`
4. Publish: `yarn pub`, then `yarn await-published`
5. Merge back into `main`

## Version Alignment

All packages in the monorepo share the same version number. The `--recursive` flag in the bump script ensures this stays in sync. Do not manually edit version numbers in individual `package.json` files.

### The sync wire version is not the package version

`PROTOCOL_VERSION` (`packages/quereus-sync/src/sync/wire.ts`) moves independently of the version every package shares. Two peers on different releases interoperate for as long as that integer is unchanged; the moment it changes, **every deployed peer and coordinator on the previous value is refused at handshake** — with a named error, not silent corruption (see [sync-protocol.md § Protocol version](sync-protocol.md#protocol-version)).

Nothing in semver signals that. So a release whose diff touches `PROTOCOL_VERSION` **must say so in the release notes**, and must say that clients and coordinator have to be upgraded together. Check it as part of curating `.release-notes.pending.md`:

```bash
git diff <last-tag>..HEAD -- packages/quereus-sync/src/sync/wire.ts | grep PROTOCOL_VERSION
```

This is a disclosure rule, not a compatibility promise — sync is Experimental and the wire version may be bumped in any release type. See [stability.md](stability.md).

## Checklist

- [ ] `yarn check` passes (there is no CI — this local run is the only pre-publish safety net)
- [ ] `yarn build` succeeds
- [ ] `yarn test` passes
- [ ] Clean working tree
- [ ] `.release-notes.pending.md` curated (optional — omit for auto-generated notes)
- [ ] If `PROTOCOL_VERSION` changed, the notes say so and say to upgrade peers together (see *The sync wire version is not the package version*)
- [ ] `yarn release` (or `yarn bump` + `yarn pub` + `yarn await-published` separately), ending with `all N packages published and visible on npm at {version}`
- [ ] Only then: tell downstream repositories to upgrade
- [ ] GitHub release created (`yarn gh-release`)
