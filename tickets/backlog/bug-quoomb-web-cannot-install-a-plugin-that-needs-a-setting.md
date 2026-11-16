description: In the web playground, adding a plugin always starts it with no settings, and the settings form only appears after a plugin has been added. A plugin that needs a setting to start, such as an address or a key, therefore can never be added through the Plugins window.
architecture: docs/plugins.md#web-ui
files:
  - packages/quoomb-web/src/stores/session/plugins.ts  # installPlugin: loadModule(url, {}), record created only on success
  - packages/quoomb-web/src/components/PluginsModal.tsx  # handleInstallPlugin; renderConfigForm needs an existing record's manifest
  - packages/plugin-loader/src/plugin-loader.ts  # dynamicLoadModule registers first, reads package.json after; validatePluginUrl
  - packages/quereus/src/vtab/manifest.ts  # PluginSetting has no way to mark a setting required
  - docs/plugins.md  # "Web UI", "Plugin Settings"
repro: static
severity: edge-case
likelihood: unusual
tradeoffs: A plugin can avoid this by registering lazily and failing later when a table is used, and a `quoomb.config.json` entry does carry settings, so a maintainer may call it a plugin-authoring convention to document instead of a flow to change.
----

Filed from the Sereus repository while documenting how to load `@serfab/quereus-plugin-sereus` in Quoomb Web. Read from the code; not run in a browser. Loading any plugin whose registration function throws on an empty settings object through the Plugins window would confirm it.

On `severity:`: the effect is a visible error and no wrong data, and the scale has no value for "this path cannot be used", so the lower of the two nearest values is given.

## What the code does

`installPlugin` in `packages/quoomb-web/src/stores/session/plugins.ts`:

1. checks the text with `validatePluginUrl`;
2. calls `api.loadModule(url, {})`, with a literal empty settings object;
3. only if that resolves, creates a `PluginRecord` with `config: {}` and the returned manifest, and stores it.

`loadModule` in the worker calls `dynamicLoadModule`, which imports the module, runs its default export with the settings it was given (`registerPlugin(db, mod.default, config)`), and only afterwards fetches `package.json` beside the module to build the manifest (`tryLoadManifestFromUrl`).

The settings form (`renderConfigForm` in `PluginsModal.tsx`) is drawn from `plugin.manifest.settings` of a stored record, and `updatePluginConfig` looks the record up by id. So settings can be entered only for a plugin that has already registered once with none.

## The defect

A plugin whose registration needs a value cannot get past step 2. Registration throws, `installPlugin` reports "Failed to install plugin: …", no record is stored, and there is nowhere to type the value. The user is told the plugin failed, not that it wants a setting.

The engine's own documentation leads plugin authors into this. `docs/plugins.md` → "package.json requirements" and → "Plugin Settings" both give an `api_key` setting with no default as the example. `PluginSetting` in `packages/quereus/src/vtab/manifest.ts` has `key`, `label`, `type`, `default`, `options` and `help`: nothing lets a plugin declare a setting as required, so a host cannot know to ask before loading.

The case that surfaced it: the Sereus plugin connects to a named shared database when it registers and refuses to register without its `strand_id` setting.

Settings do reach a plugin on the other path: `loadEnabledPlugins` passes `plugins[].config` from `quoomb.config.json` to `loadModule`. That path stores no record, so such a plugin never shows in the Plugins window.

## A second arm at the same function

`docs/plugins.md` → "Web UI" says the Plugin Manager accepts "an npm package spec (e.g. `@acme/quereus-plugin-foo@^1`)" or a direct URL. `installPlugin` passes the text to `validatePluginUrl`, which requires `new URL(text)` to parse with protocol `https:` or `file:` and a path ending `.js` or `.mjs`. A package spec does not parse as a URL, so it is refused with "Invalid plugin URL". Nothing in `quoomb-web/src` calls the loader's `loadPlugin`, which is the function that resolves `npm:` specs. The same message offers `file://`, which a page served over http or https cannot import.

## Expected behaviour

A person can add, through the Plugins window, a plugin that needs settings before it can start, and is asked for those settings instead of being shown a registration error. The manifest is available without running the plugin (it comes from `package.json`, fetched by URL), so the order "read the manifest, collect settings, then register" is possible with what the loader already has. Whether a setting is required should be something the manifest can say.

The Plugins window and `docs/plugins.md` agree on what can be typed into the install field.
