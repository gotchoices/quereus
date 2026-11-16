# @quereus/bundle

> **Stability: Experimental** — the bundle format and this API may change in any release,
> including a patch; the format version in each file detects a mismatch but is not a
> compatibility promise. See [Stability Tiers](../../docs/stability.md#tiers).

Save a [Quereus](https://github.com/gotchoices/quereus) database's schema and data as one `bundle.yaml` file: the schema as `declare schema` text, the rows in compact batches. The format is described in [docs/bundle.md](../../docs/bundle.md).

The package uses no platform API: an export is an `AsyncIterable<string>`, and the caller decides where the text goes.

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

Not implemented yet.
