---
description: UPSERT implementation (ON CONFLICT DO UPDATE/DO NOTHING) - COMPLETED
prereq: VTab API, DML executor

---

## Status: COMPLETE ✅

Full UPSERT support with column-level updates and result-based constraint signaling.

**Completed Phases:**
- Phase 1: UpdateResult Type & VTab API Refactor ✅
- Phase 2: AST & Parser ✅
- Phase 3: Planner ✅
- Phase 4: Runtime/Emitter ✅
- Phase 5: Testing ✅

**Core modules updated:**
- quereus-store ✅
- quereus-isolation ✅

**External plugins pending (external repos):**
- plugin-leveldb
- plugin-indexeddb
- plugin-react-native-leveldb
- plugin-nativescript-sqlite

