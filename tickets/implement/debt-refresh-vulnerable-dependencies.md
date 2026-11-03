description: GitHub reports 86 known vulnerabilities in the third-party packages this project locks, including in the web framework the sync server runs on. Move those packages to their patched versions without changing what the project does.
files:
  - yarn.lock
  - package.json
  - packages/sync-coordinator/package.json # fastify ^5.8.5, locked at 5.8.5, patched at 5.12.5
  - packages/quoomb-web/package.json # monaco-editor brings dompurify; vite
----

All 86 open Dependabot alerts are against `yarn.lock`. Fetch the current list with:

```
gh api 'repos/{owner}/{repo}/dependabot/alerts?state=open&per_page=100' --paginate --jq '.[] | [.security_advisory.severity, .dependency.package.name, .security_advisory.ghsa_id, (.security_vulnerability.first_patched_version.identifier // "none")] | @tsv'
```

Most entries are the same package under several advisories, so the work is per package: dompurify (via monaco-editor), tar (via node-gyp), fastify and find-my-way (sync-coordinator), fast-uri, brace-expansion, js-yaml, markdown-it, linkify-it, nanoid, postcss, postcss-selector-parser, source-map-js, ip-address, browserslist, baseline-browser-mapping, vite, vitest, @vitest/mocker, zod, qs, glob, minimatch, serialize-javascript, @humanfs/node.

The fastify move is the one with runtime reach: it spans several minor versions on a real server, and the advisories cover schema validation, not-found handlers and `trustProxy`. Read how `packages/sync-coordinator` uses those and run its tests rather than trusting the version bump.

Prefer refreshing within the declared range (`yarn up -R <pkg>`). Raise a direct dependency's declared range where the patched version needs it. Use a root `resolutions` entry only when a parent pins an old range, and say which in the handoff. Don't take a new major version; if one is the only patched version, leave that package and list it. Don't add or remove dependencies.

## Edge cases & interactions

- yarn keeps a separate lock entry per range, so one package can remain vulnerable under another range after a refresh. Verify by comparing every entry in `yarn.lock` to the first patched versions in the list above, by inspection of that comparison's output.
- The alerts can't close until the lockfile reaches GitHub, so this ticket cannot confirm the count dropped. Don't push to find out.

## TODO

- Refresh the packages above and regenerate `yarn.lock` with `yarn install`
- Run `yarn build`, `yarn typecheck` and `yarn test`, and fix any breakage from the upgrades
- Record in the handoff: any alert left open and why, and any resolutions added
