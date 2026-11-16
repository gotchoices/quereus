# @quereus/bundle

> **Stability: Experimental** — the bundle format and this API may change in any release,
> including a patch; the format version in each file detects a mismatch but is not a
> compatibility promise. See [Stability Tiers](../../docs/stability.md#tiers).

Save a [Quereus](https://github.com/gotchoices/quereus) database's schema and data as one `bundle.yaml` file, and load it back: the schema as `declare schema` text, the rows in compact batches. The format is described in [docs/bundle.md](../../docs/bundle.md).

The package uses no platform API: an export is an `AsyncIterable<string>`, an import reads strings, and the caller decides where the text comes from and goes.

## Export

Node, to a file:

```ts
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { exportBundle } from '@quereus/bundle';

const out = createWriteStream('bundle.yaml', 'utf8');
for await (const chunk of exportBundle(db, { schemas: ['main'] })) {
	if (!out.write(chunk)) await once(out, 'drain');
}
out.end();
```

Browser, to a download:

```ts
const parts: string[] = [];
for await (const chunk of exportBundle(db)) parts.push(chunk);
const url = URL.createObjectURL(new Blob(parts, { type: 'application/yaml' }));
```

Schema only, data only, or some tables:

```ts
exportBundle(db, { data: false });                       // declarations only
exportBundle(db, { schema: false, tables: (_s, t) => t !== 'audit_log' });
```

Progress, errors and cancelling:

```ts
const controller = new AbortController();
exportBundle(db, {
	batchSize: 500,
	errorPolicy: 'skip-table',           // keep going past a table that fails to read
	onProgress: p => console.log(p.table, p.rowsDone),
	onError: e => console.warn(e.kind, e.message),
	signal: controller.signal,
});
```

Do not run statements on the same database while consuming an export: the export holds the database's execution lock between chunks, so they would wait on each other.

## Import

`importBundle` takes the whole text or its chunks (`Iterable<string>` or `AsyncIterable<string>`) and resolves to a report. Problems with the bundle never throw: each is a `BundleError` in `report.errors`, also delivered to `onError` as it happens.

Node, from a file:

```ts
import { createReadStream } from 'node:fs';
import { importBundle } from '@quereus/bundle';

const report = await importBundle(db, createReadStream('bundle.yaml', 'utf8'));
if (!report.ok) for (const error of report.errors) console.warn(error.kind, error.message);
```

Browser, from a file input:

```ts
const file = input.files[0];
const report = await importBundle(db, file.stream().pipeThrough(new TextDecoderStream()));
```

Data only into an existing schema, keeping existing rows, and losing only the rows that fail:

```ts
await importBundle(db, text, { schema: 'skip', onConflict: 'skip', errorPolicy: 'skip-row' });
```

Reviewing the schema migration first:

```ts
await importBundle(db, text, {
	allowDestructive: true,             // let the plan drop tables, columns or constraints
	confirmSchemaPlan: plan => plan.destructive.length === 0 || confirm(plan.ddl.join('\n')),
});
```

Each data document is its own transaction, so an import that stops partway keeps the documents already committed; `report.tables[i].rowsApplied` says how many rows each table received. Foreign keys are off while rows load and checked afterwards, and a violation is reported, not rolled back. Do not run statements on the same database while an import runs. See [docs/bundle.md § Import](../../docs/bundle.md#import) for every option and rule.
