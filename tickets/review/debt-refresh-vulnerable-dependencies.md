description: GitHub reported 86 known vulnerabilities in the third-party packages this project locks, including the web framework the sync server runs on. Those packages have been moved to patched versions, except two where the only fix is a new major version; review that the move changed nothing the project relies on.
files:
  - yarn.lock
  - package.json
  - packages/sync-coordinator/src/server/server.ts
  - packages/sync-coordinator/src/server/routes.ts
  - packages/sync-coordinator/src/server/websocket.ts
----

## What changed

Only `yarn.lock` and the root `package.json`. No source, no workspace manifest, no declared dependency added or removed. Every declared range already admitted its patched version, so none was raised.

**Where to find the diff:** these two files are already in commit `857431de1` ("Dependency bumps"), made under the repo's git user while this ticket's test run was in progress; this agent did not make that commit. So the ticket's own commit holds only the ticket move; review `857431de1` for the change. Both files at HEAD match what was on disk for the final checks (`git diff HEAD` is empty), and the lock comparison, `yarn lint` and `yarn install --immutable` ran after that commit. `yarn build` and `yarn typecheck` ran before it and `yarn test` straddled it, all on the same file contents as far as this run can tell: nothing here edited them after `yarn up`.

Packages were refreshed with `yarn up -R`. Two existing root `resolutions` had their floors raised, and no new one was added:

- `dompurify` `^3.4.11` to `^3.4.17`: monaco-editor 0.55.1 pins `dompurify` 3.2.7 exactly. Now locked at 3.4.17.
- `serialize-javascript` `^7.0.5` to `^7.1.3`: mocha 11.7.6 is the only parent. Now locked at 7.1.4.

Main moves: fastify 5.8.5 to 5.12.8, find-my-way 9.4.0 to 9.10.0, vite 8.0.16 to 8.3.5 (rolldown 1.0.3 to 1.2.16), vitest and `@vitest/*` 4.1.9 to 4.1.12, zod 4.3.6 to 4.6.7, tar 7.5.16 to 7.5.22, qs 6.15.2 to 6.17.1.

Side effects in the lockfile, all from parents' own declared ranges:

- fastify 5.12.8 depends on `fast-json-stringify` `^7`, which depends on `fast-uri` `^4`. So a 7.x and a 6.x of the former, and a 4.x and a 3.x of the latter, are now locked. No advisory range in the alert list covers `fast-uri` 4.2.3 or either `fast-json-stringify`.
- Rolldown no longer pulls its wasm fallback: `@rolldown/binding-wasm32-wasi`, `@napi-rs/wasm-runtime`, `@emnapi/*` and `@tybys/wasm-util` left the lock. Added: `@rolldown/binding-android-arm-eabi`, `@humanfs/types`.

## Alerts left open (2 of 86)

Both are left because the only patched version is a new major, per the ticket. Neither package is imported by project code or declared directly.

- **glob, GHSA-3g3m-2fjr-6pw4 (medium).** Fixed only in 14.0.2; locked at 10.5.0 and 13.0.6, the newest in their majors. An aborted async walk keeps reading directories in the background. Parents are dev and build tools: mocha, rimraf, test-exclude, cacache (through make-fetch-happen), the docgen vite plugin.
- **minimatch, GHSA-g3hv-75wg-m249 (medium).** Fixed only in 11.0.1; locked at 3.1.5, 9.0.9 and 10.2.6, the newest in their majors. Attacker-controlled patterns can cause quadratic processing. Most parents are dev tools (eslint, typescript-eslint, typedoc, mocha, stryker). The exception is `vscode-languageclient`, a dependency of the VS Code extension client (`^10.2.5`, so 10.2.6). Whether untrusted patterns can reach it there was not checked.

## How fastify was checked

Read `server.ts`, `routes.ts` and `websocket.ts` against each advisory. The coordinator's Fastify options set only `logger`, and a search of its `src`, `test`, README and `docs/` found no `trustProxy`, schema compilers, `setNotFoundHandler`, `setErrorHandler`, HTTP/2 or trailers. `request.ip` appears once, in a log line. So:

- Fastify 5.12.1 disabling numeric `trustProxy` has no effect here. If the coordinator ever sits behind a proxy and sets it, it must use the IP or CIDR form.
- The schema-validation and trailer fixes touch code paths the coordinator does not use.
- The not-found and malformed-URL fix does change responses. Measured with a throwaway script running the same route shape on bare fastify 5.8.5 and 5.12.8:

| Request | 5.8.5 | 5.12.8 |
| --- | --- | --- |
| Malformed URL, method with no route (`DELETE /sync/%E0%A4%A/changes`) | 404 | 400 `FST_ERR_BAD_URL` |
| Param over 100 characters, GET or POST | 404 | 414 `FST_ERR_MAX_PARAM_LENGTH` |
| Param of exactly 100 characters | 200 | 200 |
| Malformed URL, GET or POST | 400 | 400 |
| Unknown route | 404 | 404 |

The 100-character limit itself is unchanged and those requests are still rejected; only the status code moved. `defaultIsValidDatabaseId` has no length limit, so an id over 100 characters was already refused by the REST routes while the WebSocket path, which carries the id in a message, is not subject to this limit. A search of `quereus-sync-client/src` found no handling of 404 or 414.

The built coordinator on 5.12.8 was also driven over real HTTP with a one-off script: status, metrics, unknown route, malformed URLs, over-long ids, get and apply changes, invalid and non-JSON bodies, primitive JSON body, snapshot NDJSON, CORS preflight, and spoofed `X-Forwarded-*` headers. All responses were as expected, and no process warnings were emitted.

## Validation run

- `yarn build`, `yarn typecheck`, `yarn lint`, `yarn test`, `yarn install --immutable`: all exit 0.
- `yarn test` had no failures, including sync-coordinator's 138 (HTTP, WebSocket, round-trip).
- Lock comparison: every `yarn.lock` entry for the 25 alerted packages was checked with `semver.satisfies` against every npm vulnerable range of all 86 advisories, including ranges for other major lines. Output, inspected: 5 vulnerable entries, all glob and minimatch as listed above. Everything else reports ok, including multi-range entries such as `brace-expansion` 1.1.21, 2.1.7 and 5.0.12.

To reproduce the comparison, fetch `.security_advisory.vulnerabilities[]` from the alerts endpoint and run that check; the script was scratch and is not in the repo.

## Known gaps

- quoomb-web was built and unit-tested but **not opened in a browser**. That matters more than usual here: vite 8.0 to 8.3 is a bundler jump, and dompurify is used by Monaco's rendering at runtime. Worth a manual look at the editor and worker startup.
- The VS Code extension was built but not launched.
- `yarn test:store` and the strict suites in `yarn check` were not run; nothing in this change targets the store path.
- Open alert count was not confirmed, as the ticket says: alerts close only once the lockfile reaches GitHub. Expected result is 2 open.
- `fastify` stays declared as `^5.8.5` because the range admits the patched version. `@quereus/sync-coordinator` is published, so a consumer with an existing lockfile could still hold a vulnerable fastify. Raising the floor to `^5.12.5` is a one-line change if wanted; it was left out because the ticket asks to raise a range only where the patched version needs it.

## Tests

None added. This is a version refresh with no logic change, and existing suites cover the behaviour; the 404-to-414 change is framework behaviour on a request the coordinator already refuses.
