description: GitHub reported 86 known vulnerabilities in the third-party packages this project locks, including the web framework the sync server runs on. Those packages were moved to patched versions, except two where the only fix is a new major version; the web app's editor still runs an older sanitizer that no package update can reach, which is harmless today and documented in the code.
files:
  - yarn.lock
  - package.json
  - packages/sync-coordinator/package.json
  - packages/sync-coordinator/src/server/routes.ts
  - packages/quoomb-web/src/components/EditorPanel.tsx
----

## What landed

Locked packages were refreshed with `yarn up -R`. The change is in commit `857431de1` ("Dependency bumps"), made under the repo's git user during the implement run; `` `ticket(implement): debt-refresh-vulnerable-dependencies` `` holds only the ticket move.

- Main moves: fastify 5.8.5 to 5.12.8, find-my-way 9.4.0 to 9.10.0, vite 8.0.16 to 8.3.5 (rolldown 1.0.3 to 1.2.16), vitest and `@vitest/*` 4.1.9 to 4.1.12, zod 4.3.6 to 4.6.7, tar 7.5.16 to 7.5.22, qs 6.15.2 to 6.17.1.
- Two existing root `resolutions` floors were raised, none added: `dompurify` to `^3.4.17` (monaco-editor pins 3.2.7 exactly) and `serialize-javascript` to `^7.1.3` (mocha is the only parent).
- Review raised `@quereus/sync-coordinator`'s `fastify` floor from `^5.8.5` to `^5.12.5`.

## Alerts left open (2 of 86)

Open because the only patched version is a new major. Project code imports neither package, and neither is declared directly.

- **glob, GHSA-3g3m-2fjr-6pw4 (medium).** Fixed only in 14.0.2; locked at 10.5.0 and 13.0.6. Parents are dev and build tools.
- **minimatch, GHSA-g3hv-75wg-m249 (medium).** Fixed only in 11.0.1; locked at 3.1.5, 9.0.9 and 10.2.6. Parents are dev tools plus `vscode-languageclient` in the VS Code extension, where the patterns come only from the extension and its bundled language server, so no untrusted pattern reaches it.

The open alert count cannot be confirmed until the lockfile reaches GitHub; the expected result is 2.

## Coordinator behaviour changes from fastify 5.12

Measured on the built coordinator with `app.inject`, plus the implementer's comparison against bare fastify 5.8.5:

| Request | 5.8.5 | 5.12.8 |
| --- | --- | --- |
| Malformed URL, method with no route | 404 | 400 `FST_ERR_BAD_URL` |
| Path param over 100 characters | 404 | 414 `FST_ERR_MAX_PARAM_LENGTH`, no CORS header |
| Path param of exactly 100 characters | handled | handled |

Numeric `trustProxy` is disabled from 5.12.1. The coordinator does not set `trustProxy`, and `CoordinatorServerOptions` does not expose Fastify options, so this has no effect today. If it is added for a reverse-proxy deployment, as `docs/sync-coordinator.md` recommends for TLS, it must use the IP or CIDR form.

## Review findings

Read `git show 857431de1` before the handoff, then ran the checks below.

**Validation.** `yarn build`, `yarn lint`, `yarn typecheck`, `yarn docs:check`, `yarn install --immutable` and `yarn test` all exit 0 with the commit's lockfile (sync-coordinator 138 passing, no failures in any package). After the review's edits, re-ran `yarn install`, `yarn install --immutable`, `yarn lint`, sync-coordinator's typecheck and tests (138 passing) and quoomb-web's typecheck, all exit 0. The full suite was not re-run after them: the edits are one manifest floor, one lock key and two comments. `yarn test:store`, `yarn bench:gate` and the strict suites in `yarn check` were not run; nothing here targets them.

**Lock comparison, reproduced independently.** A new script checked all 327 pairs of lock version and vulnerable range across the 86 advisories, re-run after the floor raise. It reports the same 5 vulnerable entries the handoff listed (glob and minimatch) and nothing else.

**Major: the `dompurify` resolution does not change what the browser runs (handoff claim corrected).** The handoff said dompurify is used by Monaco's rendering at runtime and that the resolution locks 3.4.17. The lock is right, but the app calls `loader.init()` with no `loader.config()`, so `@monaco-editor/loader` fetches Monaco from jsDelivr at 0.55.1 (confirmed in the browser's network log), and the `monaco-editor` package is only imported as types. That Monaco release embeds DOMPurify 3.2.7 in its own code, not through the npm dependency. So 22 advisories in GitHub's database that list 3.2.7 as affected still apply to the running copy, including general cross-site-scripting ones such as GHSA-v2wj-7wpq-c8vv and GHSA-h8r8-wccr-v5f2. The alert list understated this because it reflected the previous 3.4.11 lock.

Disposition: tripwire, not a ticket. Exposure needs markdown reaching Monaco's renderer, and a search of `quoomb-web/src` and `shared-ui/src` found no hover, completion, signature, code lens or inlay provider, no `hoverMessage`, and no markers; only tokenizing is registered. No new Monaco fixes it either: 0.57.0, the latest, embeds DOMPurify 3.4.15, still below 3.4.17. Parked as a `NOTE:` at `packages/quoomb-web/src/components/EditorPanel.tsx`. The `dompurify` alerts will close while this remains true, so a closed alert there does not mean a patched browser copy.

**Minor, fixed: the coordinator's published fastify floor admitted vulnerable versions.** A script over every workspace's runtime and peer ranges found `@quereus/sync-coordinator` to be the only published package whose floor sits inside an advisory range (`^5.8.5`, fixes at 5.12.1, 5.12.2 and 5.12.5). A consumer with an existing lockfile would stay on a vulnerable fastify after upgrading the coordinator. Raised to `^5.12.5`; the lock changes only that key, still 5.12.8. The implement ticket preferred not raising ranges, and the handoff flagged this as optional. Raising it here is a judgement call that is easy to reverse.

**Tripwire: database IDs over 100 characters.** Confirmed with the real coordinator: REST answers 414 with no CORS header, so a browser client sees an opaque failure rather than a status. Unknown routes and a 100-character ID do carry the CORS header. CORS on the old 404 was not measured. The WebSocket handshake has no such limit (read, not run), so REST and WebSocket disagree on which IDs are usable, as they did before this change. Parked as a `NOTE:` at `validateDatabaseId` in `packages/sync-coordinator/src/server/routes.ts`. A search of `docs/sync-coordinator.md` found no ID-length rule or per-status documentation, so no doc needed changing.

**Handoff gaps closed.**

- quoomb-web: drove the production build under `vite preview` in headless Chromium. Monaco rendered, workers started, `select 1 + 41 as answer` returned 42, and there were no console errors, warnings, page errors or failed requests. Monaco's markdown renderer itself was not exercised, since nothing in the app feeds it.
- `vscode-languageclient` and minimatch: traced as described under the open alerts.

**Gaps that remain.** The VS Code extension was built but not launched. The browser run covered one query in the memory store, not the store or sync modes.

**Checked, nothing to do.**

- Fastify usage: `server.ts`, `routes.ts` and `websocket.ts` read; only `logger` is set, and `@fastify/cors` and `@fastify/websocket` both worked in the coordinator tests and in the requests above.
- Engines: vite and rolldown 8.3 need Node `^20.19.0 || >=22.12.0`, find-my-way needs `>=20`. The coordinator declares no engines, its docs state no Node version, and the repo has no CI workflow pinning one.
- Lockfile side effects: `fast-json-stringify` 7 and `fast-uri` 4 sit beside the older majors as their parents' ranges require, and neither falls in an advisory range. The rolldown wasm fallback left the lock, which matters only on platforms without a native binding; none are targeted here.
- Install warnings are peer-dependency notices that this change does not touch.
- Docs: none refer to the moved versions, and `yarn docs:check` passes.

**Noticed, no action.**

- `yarn npm audit --all --recursive` also reports `diff` 7.0.0 under mocha (GHSA-73rr-hh4g-fpgx, low), which is not among the 86 alerts and is a dev tool only. It also reports deprecations for `@smithy/core`, `eslint` 9 and `prebuild-install`, which are not advisories.
- vite 8.3.5 prints a build warning that `__dirname` in `quoomb-web/vite.config.ts` will be unsupported by a future default config loader. It announces itself in every build, so no note was added.
- Loading Monaco from a third-party CDN at runtime, with no integrity check, predates this change and is outside this ticket; the `NOTE:` in `EditorPanel.tsx` records the load path.

**Tests.** None added or cut. This is a version refresh; the existing suites cover the behaviour, and the status-code change is framework behaviour on requests the coordinator already refused.

**Tickets filed.** None. Both concerns above are conditional and recorded as tripwires.
