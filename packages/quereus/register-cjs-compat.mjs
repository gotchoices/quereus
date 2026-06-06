import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

process.env.TS_NODE_PROJECT = './tsconfig.test.json';
process.env.TS_NODE_ESM = 'true';

register('ts-node/esm', pathToFileURL('./'));
