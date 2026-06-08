---
description: Fix mutex leak in Statement.all() and ensure iterator cleanup
prereq: none

---

# Fix Statement Iterator Cleanup

## Problem

`Statement.all()` acquires a mutex but if iteration is abandoned (consumer breaks out early), the mutex is never released until garbage collection. This can cause deadlocks or starvation.

```typescript
// statement.ts:453-476
async *all(params?: SqlParameters | SqlValue[]): AsyncIterable<Record<string, SqlValue>> {
	const releaseMutex = await this.db._acquireExecMutex();
	// ... if consumer breaks here, releaseMutex never called ...
	try {
		for await (const row of this._iterateRowsRaw(params)) {
			yield rowToObject(row, names);
		}
	} finally {
		// This finally only runs if iteration completes or throws
		releaseMutex();
	}
}
```

`Database.eval()` correctly handles this with a wrapper that intercepts `return()` and `throw()`, but `Statement.all()` lacks this protection.

## Solution

Add iterator wrapper to `Statement.all()` similar to `Database.eval()`.

### Key Files

- `packages/quereus/src/core/statement.ts` - Statement class

## TODO

### Phase 1: Extract Wrapper Utility
- [ ] Create `wrapAsyncIterator<T>()` utility function in `src/core/` or `src/util/`
- [ ] Utility should intercept `return()` and `throw()` to run cleanup callbacks
- [ ] Utility should handle both normal completion and early exit

### Phase 2: Apply to Statement.all()
- [ ] Wrap the async generator in `all()` with cleanup that releases mutex
- [ ] Wrap with cleanup that finalizes implicit transaction
- [ ] Ensure `return()` commits transaction, `throw()` rolls back

### Phase 3: Audit Other Iterators
- [ ] Review `Statement.iterateRows()` for same issue
- [ ] Review any other async generators that hold resources
- [ ] Ensure consistent cleanup pattern across all iterators

### Phase 4: Testing
- [ ] Test early exit from `all()` releases mutex
- [ ] Test throwing during `all()` iteration releases mutex
- [ ] Test early exit commits implicit transaction
- [ ] Test error during iteration rolls back implicit transaction
- [ ] Test multiple early exits don't cause double-release
