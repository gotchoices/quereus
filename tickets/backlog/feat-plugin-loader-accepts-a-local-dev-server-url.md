description: A plugin author cannot try a plugin they are building in the web playground without first publishing it to a secure web address, because the loader refuses plain web addresses on the author's own machine. Allow the local machine as a source.
architecture: docs/plugins.md#installation--loading
files:
  - packages/plugin-loader/src/plugin-loader.ts  # ALLOWED_PLUGIN_PROTOCOLS; dynamicLoadModule; resolveImportSpecifier (the `localhost` cache-bust branch); validatePluginUrl
  - packages/quoomb-web/src/stores/session/plugins.ts  # installPlugin's error text
  - packages/quoomb-web/README.md  # "Development Workflow"
  - docs/plugins.md
tradeoffs: The protocol list is a deliberate security boundary ("only allow secure protocols"), and a loopback exception is one more rule in it that has to be exactly right; an author can already serve a build over https with a local certificate, so a maintainer may prefer to document that instead.
----

Filed from the Sereus repository while documenting how to load `@serfab/quereus-plugin-sereus` in Quoomb Web. Read from the code; not run in a browser.

## What the code does

`ALLOWED_PLUGIN_PROTOCOLS` in `packages/plugin-loader/src/plugin-loader.ts` is `['https:', 'file:']`. `dynamicLoadModule` throws "Unsupported plugin URL protocol" for anything else, and `validatePluginUrl`, which Quoomb Web calls before loading, returns false. So `http://localhost:5173/plugin.js` is refused twice.

The same file expects a local development server. The browser branch of `resolveImportSpecifier` ends:

```ts
// Browser or worker: `import('https://…')` is native. Cache-bust a local dev
// server so a rebuilt plugin is picked up without a hard reload.
return moduleUrl.hostname === 'localhost' ? withCacheBuster(moduleUrl) : moduleUrl.toString();
```

Only an `https:` URL reaches that line, so the branch serves `https://localhost` and nothing else. A development server speaks plain http unless the author sets up a certificate.

## What an author is left with in a browser

- `file:` is on the list, but a page served over http or https cannot import a `file:` module, so in Quoomb Web that entry does nothing. It is for Node hosts.
- `http://localhost` is refused.
- That leaves a real `https:` host. `packages/quoomb-web/README.md` → "Development Workflow" says as much: "Host plugin on a publicly accessible URL". Each change to the plugin is then a publish.

Quoomb Web's own development server is at `http://localhost:3000` (same README), so the page a developer is most likely to be testing from is itself plain http on the local machine.

## Expected behaviour

A plugin served by a development server on the author's own machine can be loaded in Quoomb Web, and the existing cache-busting applies to it, so a rebuilt plugin is picked up on reload. Remote plain-http addresses stay refused.

What "the author's own machine" means has to be decided and written down: the `localhost` name only, as the cache-bust branch tests today, or the loopback addresses as well (`127.0.0.1`, `[::1]`). Browsers treat those as trustworthy origins for the purpose of loading from a secure page; that is general browser behaviour, not something checked here. Whether the Node hosts (the CLI, with its download-and-hash resolver in `node-remote.ts`) get the same exception or keep `https:` only is part of the decision.

## Related

`feat-browser-plugin-hash-verification` touches the same browser branch of `resolveImportSpecifier`. If the browser gains a fetch-then-evaluate path for hashing, the loopback rule belongs in that path's URL check too.
