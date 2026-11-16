import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Mocha runs from the repo root, which has no tsconfig.json; without these ts-node
// compiles against its default lib and rejects ES2022 APIs such as Error's `cause`.
process.env.TS_NODE_PROJECT = './packages/quereus-bundle/tsconfig.test.json';
process.env.TS_NODE_ESM = 'true';

register('ts-node/esm', pathToFileURL('./'));
