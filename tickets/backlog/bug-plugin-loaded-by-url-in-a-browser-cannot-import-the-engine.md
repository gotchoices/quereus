description: The documentation tells plugin authors to import the engine's building blocks by package name and to leave the engine out of their own bundle. A plugin built that way cannot be loaded by web address in the web playground, because a browser has no way to turn the package name into a file, and nothing in the playground supplies one.
architecture: docs/plugins.md#authoring-a-plugin
files:
  - packages/plugin-loader/src/plugin-loader.ts  # dynamicLoadModule / resolveImportSpecifier: the URL goes straight to import()
  - packages/quoomb-web/src/worker/quereus.worker.ts  # loadModule
  - packages/quoomb-web/index.html  # no import map
  - packages/sample-plugins/  # built output imports '@quereus/quereus' by name
  - docs/plugins.md  # "package.json requirements", "Runtime module contract", "Web UI", "API Reference"
  - packages/quoomb-web/README.md  # "Plugin Development"
repro: static
severity: edge-case
likelihood: normal-use
tradeoffs: A plugin author can work around it today by bundling a private copy of the engine or by serving the plugin through a CDN that rewrites imports, and any real fix means choosing how a host hands its engine to a plugin, which is a plugin-contract decision a maintainer may not want to make for the playground alone.
----

Filed from the Sereus repository while documenting how to load `@serfab/quereus-plugin-sereus` in Quoomb Web. Read from the code and the built sample plugins; not run in a browser. To confirm: serve `packages/sample-plugins/dist/json-table/index.js` over https and add it in the Plugins window.

On `severity:`: the effect is a visible load error and no wrong data, and the scale has no value for "this path cannot be used", so the lower of the two nearest values is given. `likelihood:` is `normal-use` because it applies to any plugin written the documented way, including the samples.

## What the documentation tells an author to do

- `docs/plugins.md` → "package.json requirements": declare `"peerDependencies": { "@quereus/quereus": … }` and expose a browser build at `exports['./plugin'].browser`. A peer dependency is one the plugin does not bundle.
- `docs/plugins.md` → "API Reference": "All types and utilities are exported from the main `@quereus/quereus` package for external plugin development." The virtual-table and function examples import values from it (`VirtualTable`, `createScalarFunction`, `FunctionFlags`, the type constants), not only types.
- `docs/plugins.md` → "Web UI" and `packages/quoomb-web/README.md` → "Plugin Development": host the plugin at a URL and give that URL to the Plugin Manager.

The sample plugins follow this. Their built files keep the import by name, for example `packages/sample-plugins/dist/json-table/index.js`: `import { VirtualTable } from '@quereus/quereus';`.

## What the web host does

`loadModule` in `packages/quoomb-web/src/worker/quereus.worker.ts` calls `dynamicLoadModule(url, db, config)`. In a browser or worker, `resolveImportSpecifier` returns the URL unchanged and the loader runs `import(specifier)`.

A module fetched by URL that contains `import … from '@quereus/quereus'` asks the browser to resolve a bare package name. A browser does that only through an import map. `packages/quoomb-web/index.html` declares none, neither `docs/plugins.md` nor the loader's README mentions import maps or says how a browser plugin reaches the engine, and the import here runs inside a worker. The import therefore fails while the module is being linked, before the plugin's registration function is called. This is inferred from how browsers resolve module specifiers, not observed.

Under Node none of this arises: the same specifier resolves through `node_modules`, which is why the sample plugins and every plugin test pass.

## Why it matters beyond the error

The two workarounds each give the plugin a second copy of the engine:

- bundling `@quereus/quereus` into the plugin;
- serving the plugin through a CDN that rewrites package names to its own URLs. Of the three CDNs `toCdnUrl` knows, only `esm.sh` is of that kind; `jsdelivr`, the default for `loadPlugin(..., { allowCdn: true })`, and `unpkg` serve the published file as it is (general knowledge of those services, not checked here), so a plugin fetched from them would have the same unresolved import.

A plugin then builds its tables and errors from classes the host's engine did not define. Whether that works depends on whether the engine anywhere compares class identity (`instanceof QuereusError`, a `VirtualTable` check) or keeps module-level state such as the type registry, which `Database.registerType` documents as process-wide. That was not investigated here. The Sereus plugin leaves the engine out of its browser bundle for exactly this reason and, as a result, cannot be loaded by URL.

## Expected behaviour

There is one documented way for a plugin loaded by URL in a browser to use the host's engine, the web host provides it, and the sample plugins use it. `docs/plugins.md` says which imports a browser build may make. If the answer is "a browser plugin must bundle its own engine", the docs say so, and say what must then not be shared across the two copies.

## Related

`feat-browser-plugin-hash-verification` proposes a fetch-then-evaluate path for the same browser branch of the loader. A path that fetches the module text before evaluating it is also a place where a package name could be resolved, so the two should be designed together.
