description: Let people export and import bundle files directly from the command-line tool and the web playground, instead of only from code.
prereq: bundle-import
files: packages/quoomb-cli/src/commands/dot-commands.ts, packages/quoomb-cli/README.md, packages/quoomb-web/, packages/quereus-bundle/README.md
tradeoffs: The library API already covers programmatic use, and each UI surface adds option plumbing and progress display to maintain, so this can wait until someone actually needs bundles from the tools.
----
Once `@quereus/bundle` exists, the CLI and the web UI are its obvious first consumers.

- **quoomb-cli:** `.bundle export <file> [--schema-only|--data-only] [--schemas a,b] [--batch-size n]` and `.bundle import <file> [--on-conflict abort|skip|update] [--errors abort|skip-batch|skip-row] [--allow-destructive]`. Stream through `fs` streams, show per-table progress from `onProgress`, print the import report's errors with document, row and line positions, and exit non-zero when `report.ok` is false in non-interactive mode. The existing `.import` / `.export` (CSV / JSON) commands stay as they are.
- **quoomb-web:** "Export bundle" / "Import bundle" actions next to the existing CSV import and export. Use `File.stream()` piped through `TextDecoderStream` for import, and a Blob download built from the export chunks. Show a progress bar and an error list, and a confirmation dialog fed by `confirmSchemaPlan` that lists the planned DDL and highlights destructive statements.
