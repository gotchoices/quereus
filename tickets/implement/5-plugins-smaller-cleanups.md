description: A grab-bag of small cleanliness problems across the plugin loader, command-line tool, and web UI — mostly dead code and copy-paste duplication, but two are real bugs where a user's setting is silently thrown away and where a table name is spliced straight into SQL text; tidy the cleanup items and fix the two real bugs.
files:
  - packages/plugin-loader/src (dynamicLoadModule + protocol allowlist; config channel object→JSON flattening; shared plugin-load loop)
  - packages/quereus-plugin-indexeddb/src (config casts JSON strings back to objects)
  - packages/quoomb-cli/src (dead REPL methods; pervasive any; PRAGMA table_info(${tableName}) interpolation; dead readline dep)
  - packages/quoomb-cli/package.json (readline dependency)
  - packages/quoomb-web/src (five copy-paste fetch* actions)
  - packages/shared-ui/src (exported string constant)
----

## Problem

A review of the plugins-and-UI layer collected a set of low-severity cleanliness
items. Two of them are **real bugs**, not just tidiness — those are called out
first and must be fixed, not merely noted. The rest are dead-code / duplication
cleanups. Do the cleanups; where a "cleanup" would balloon into a real refactor,
leave a `NOTE:` and move on rather than gold-plating.

## Real bugs (fix these)

### Bug 1 — user cache config is silently ignored

The plugin config channel in `plugin-loader` flattens configuration **objects** to
JSON **strings** when passing them across the channel. The IndexedDB plugin then
casts the received value back to an object — but it receives a *string*, not the
object it expects, so a user-supplied cache configuration is silently dropped: the
setting appears to be accepted and has no effect. Fix the round-trip so a config
object supplied by the user actually reaches the plugin as an object (either stop
flattening to a JSON string, or parse it back on the receiving side — pick one and
make the channel's encode/decode symmetric). Add a test that a non-trivial cache
config set by the user is observably applied.

### Bug 2 — raw identifier interpolated into SQL text

`quoomb-cli` builds `PRAGMA table_info(${tableName})` by interpolating a raw
identifier straight into the SQL string. That is an injection-shaped defect: a
table name with the wrong characters breaks or subverts the query. Quote/escape the
identifier properly (use the engine's identifier-quoting path, or a parameter/quote
helper — not bare string interpolation). Audit the file for sibling cases of raw
identifier interpolation while there.

## Cleanups (tidy; NOTE-and-skip if any balloons)

- **plugin-loader — allowlist placement**: the protocol allowlist sits *beside*
  `dynamicLoadModule` rather than *inside* it; move it in so the allowlist can't be
  bypassed by a future caller that reaches the loader another way.
- **plugin-loader / web / CLI — duplicated plugin-load loop**: the web app, the CLI,
  and the loader each re-implement the same plugin-loading loop. Extract one shared
  implementation and have all three call it. (If extraction crosses package
  boundaries awkwardly, note the shared home and scope it — don't force a bad
  dependency edge.)
- **quoomb-cli — dead code**: ~70 lines of dead REPL methods and scaffold remnants;
  remove them. Remove the unused npm `readline` dependency from its `package.json`.
- **quoomb-cli — pervasive `any`**: the file leans on `any` throughout (against the
  project's no-`any` rule); type it properly where the change is local. If fully
  typing it is a large job, tighten what's cheap and leave a `NOTE:` on the rest.
- **quoomb-web — five copy-paste `fetch*` actions**: five near-identical `fetch*`
  actions that differ only in endpoint/shape; collapse to one parameterized helper.
- **shared-ui — orphan string constant**: `shared-ui` exports a lone string
  constant that nothing meaningfully consumes — either implement the thing it was a
  placeholder for or drop the export.

## Expected outcome

The two real bugs are fixed and covered by tests (user cache config takes effect;
identifiers are safely quoted). The dead REPL code, dead `readline` dep, and orphan
constant are gone. The plugin-load loop and the `fetch*` actions are de-duplicated.
Any deliberately-deferred `any`-typing or extraction is marked with a greppable
`NOTE:` rather than silently left.

## TODO

- Fix Bug 1: make the plugin config channel's object encode/decode symmetric; add a test that a user cache config is applied.
- Fix Bug 2: quote/escape the identifier in `PRAGMA table_info(...)`; audit for sibling raw-interpolation.
- Move the protocol allowlist inside `dynamicLoadModule`.
- Extract the shared plugin-load loop; wire web + CLI + loader to it.
- Delete dead REPL methods / scaffold remnants in quoomb-cli; remove the `readline` dependency.
- Replace local `any` in quoomb-cli with real types; `NOTE:` anything deferred.
- Collapse the five quoomb-web `fetch*` actions into one parameterized helper.
- Resolve the shared-ui orphan string constant (implement or delete).
