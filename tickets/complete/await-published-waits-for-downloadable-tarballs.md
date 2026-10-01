description: The release step that waits for new packages to appear on npm now counts a package as published only once its download file can actually be fetched, not just once npm lists the version.
architecture: docs/releasing.md#when-the-release-is-finished
files: scripts/published-visibility.mjs, scripts/await-published.mjs, scripts/published-visibility.test.mjs, docs/releasing.md
----
# Complete: `yarn await-published` waits for each package's tarball

Port of optimystic's fix of the same name (its commits d403aa41 and 30cf0b08) to Quereus's copy of
the post-publish wait.

## What landed

`yarn await-published` used to count a package as published once `npm view <name>@<version> version`
echoed the version back. That reads the registry's metadata; the tarball `npm install` downloads is
served separately and later (sereus 1.8.0: every version listed while three tarballs answered 404 for
minutes). Now a package counts only when both hold:

1. `npm view --json <spec> version dist.tarball` lists the version with an http(s) `dist.tarball`, and
2. a `HEAD` of that URL, sent with `cache-control: no-cache`, answers 200.

Pure half, `scripts/published-visibility.mjs`: `readViewAnswer` returns `{ listed, tarball | reason }`
(typedef `ViewAnswer`); `readListing` accepts the object npm prints for two fields and the bare
version string it prints when `dist.tarball` is absent (listed, no tarball → not visible);
`isHttpUrl` refuses non-http(s) URLs, since `fetch` answers a `data:` URL with 200 without asking
anyone; `readTarballAnswer(status)` gives the verdict (200 visible, 404 `TARBALL_NOT_YET_DOWNLOADABLE`,
else `tarball answered HTTP <n>`). The wait's probe now returns `Visibility`. Impure half,
`scripts/await-published.mjs`: `probe` runs `npm view`, then `probeTarball` only when listed; a
rejected fetch becomes a printed reason, never a throw. Three `NOTE:` tripwires as in optimystic: CDN
edges may ignore `no-cache` (at `REVALIDATE`), no npm credentials on the fetch, and no
`dist-tags.latest` check (both at `probeTarball`). `docs/releasing.md` § When the release is finished
explains both checks and the new reasons.

## Testing

- `yarn test:scripts`: 13/13. New cases: listed with tarball URL, bare version (no tarball) not
  listed, `data:` tarball not listed, `readTarballAnswer` 200/404/503; existing cases moved to the
  `listed` shape.
- `npm view --json @quereus/quereus@4.20.0 version dist.tarball` (npm 11.3.0) prints
  `{ "version": …, "dist.tarball": … }`, the key the code reads.
- `yarn await-published` against the live registry at 4.20.0 → `all 14 packages published and visible
  on npm at 4.20.0`.
- `yarn docs:check` clean.
