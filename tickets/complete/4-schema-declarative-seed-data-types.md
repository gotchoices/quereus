description: Fix APPLY SCHEMA seed data to handle boolean and Uint8Array values
prereq: none
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Summary

Fixed `emitApplySchema` seed data value interpolation which silently mapped `boolean` and `Uint8Array` values to `'NULL'` via the fallthrough default case.

## Changes

**schema-declarative.ts:**
- Added `uint8ArrayToHex()` cross-platform helper (no Node `Buffer` dependency)
- Added `typeof v === 'boolean'` branch — booleans map to SQL integers `1`/`0`
- Added `v instanceof Uint8Array` branch — blobs map to `X'hex'` literals

## Testing

**50-declarative-schema.sqllogic Step 53:**
- Declares schema with `true`/`false` boolean and `X'cafebabe'`/`X'deadbeef'` blob seed values
- Verifies booleans are stored as 1/0 integers (not NULL)
- Verifies blobs are preserved with correct type (`blob`) and length (4 bytes each)

## Validation
- Build passes
- 1013 tests passing, 2 pending, 0 failures
