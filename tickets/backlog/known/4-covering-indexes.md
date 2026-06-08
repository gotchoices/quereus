---
description: Covering indexes and index-only scans for MemoryTable
prereq: 2-composite-index-advanced-seeks
---

## Problem

All index lookups currently require a follow-up fetch from the primary data BTree to retrieve non-indexed columns. When a query only references columns present in the index, the primary BTree lookup is unnecessary overhead.

Documented in `docs/memory-table.md` under "Future Enhancements" (medium-term).

