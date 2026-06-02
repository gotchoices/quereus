description: FIX — a lens-level parent-side FK RESTRICT is silently NOT enforced when the basis FK is CASCADE/SET NULL/SET DEFAULT. Deleting (or key-updating) a referenced logical parent succeeds: the basis referential action mutates the children during the statement, so the deferred lens `NOT EXISTS` over the logical child sees no surviving children at commit and passes — the logical RESTRICT the lens promised is dropped.
files: packages/quereus/src/planner/mutation/lens-enforcement.ts, packages/quereus/src/runtime/foreign-key-actions.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/test/lens-enforcement.spec.ts, docs/lens.md
----

# Lens parent-side FK RESTRICT not enforced over a CASCADE/SET-NULL/SET-DEFAULT basis FK

## Symptom (confirmed reproduction)

A lens declares a logical FK whose parent-side action is **RESTRICT** (the
default for a bare `references parent(id)`), over a **basis** child table whose
FK to the same basis parent is **CASCADE** (or SET NULL / SET DEFAULT). The lens
imposes stricter logical semantics than the basis — exactly the case the
parent-side lens FK enforcement exists to cover. The collector
(`collectLensParentSideForeignKeyConstraints`) correctly **retains** a lens-level
deferred `NOT EXISTS` over the logical child for this case (it is *not* elided —
the redundancy detector's action gate refuses to elide a non-`restrict` basis
FK). But retention is insufficient: the check never fires.

Minimal repro (verified during review of `lens-parent-side-fk-basis-redundancy-elision`):

```sql
pragma foreign_keys = true;
declare schema y {
  table parent (id integer primary key, name text);
  table child  (id integer primary key, pid integer null,
                constraint fk foreign key (pid) references parent(id)
                  on delete cascade on update cascade)
}
apply schema y;
declare logical schema x {
  table parent (id integer primary key, name text);
  table child  (id integer primary key, pid integer null,
                constraint fk_pid foreign key (pid) references parent(id))   -- bare ⇒ RESTRICT
}
apply schema x;

insert into x.parent (id, name) values (1, 'a');
insert into x.child (id, pid) values (10, 1);
delete from x.parent where id = 1;
```

**Observed:** the delete **succeeds**; `x.parent` row 1 is gone *and* child 10 was
cascade-deleted (probe result `{aborted:false, parent:[{n:0}], child:[{n:0}]}`).

**Expected (logical RESTRICT semantics):** the delete is **ABORTed** because a
logical child still references the parent; both rows survive.

## Root cause

Timing/interleaving between two enforcement mechanisms on the **same basis parent
write**:

1. The re-planned basis parent DELETE/UPDATE runs the **basis** referential
   action. CASCADE (`runtime/foreign-key-actions.ts`) deletes / nulls the basis
   child rows **during statement execution**.
2. The retained **lens** parent-side check is a `NOT EXISTS(select 1 from
   <logicalChild> where … = OLD.<key>)`. Because it contains an `EXISTS`, the
   constraint pipeline **auto-defers it to commit**. At commit the logical child
   view reflects the **post-cascade** basis — the referencing children are already
   gone — so `NOT EXISTS` is `true` and the check passes.

The deferred lens check is structurally unable to observe the pre-cascade state,
so a deferred `NOT EXISTS` can never enforce RESTRICT against a same-statement
CASCADE. (Note the physical builder's RESTRICT check is **immediate**, not
deferred — `buildParentSideFKChecks` sets `deferrable:false, initiallyDeferred:false`
for `restrict` — and there is also an immediate runtime RESTRICT pre-check,
`assertNoRestrictedChildrenForParentMutation`. The lens path's blanket
auto-deferral via `EXISTS` is what diverges.)

## Scope / provenance

- **Pre-existing**, shipped by `lens-parent-side-fk-enforcement` — *not* introduced
  by the redundancy-elision ticket. The elision change is sound: it only ever
  *elides* the `restrict`-basis case (where the immediate basis RESTRICT check
  fully covers it) and *retains* the cascade case. The retention is correct but
  insufficient; this bug is in the retained path's **timing**, not in the elision
  decision.
- Affects **DELETE** (basis `on delete cascade|set null|set default`) and
  **UPDATE** of a referenced key (basis `on update …`).
- Only reachable when the logical/lens FK action is RESTRICT while the basis FK
  action is non-RESTRICT for the op — a deliberate "lens is stricter than basis"
  configuration. When the basis FK is also RESTRICT the basis immediate check
  enforces it (and the lens check is now elided); when the lens FK is itself
  CASCADE/etc. it is out of scope (no lens parent-side check emitted today).

## Requirements / expected behavior

- Deleting or key-updating a logical parent that is still referenced by a logical
  child **must ABORT** whenever the logical FK action is RESTRICT, regardless of
  the basis FK's action — the lens's stricter semantics win.
- Enforcement must observe the **pre-mutation** child state (the RESTRICT decision
  is about rows that reference the OLD parent key, before any basis cascade runs).
  A deferred-to-commit `NOT EXISTS` over the logical child is the wrong instrument
  for a RESTRICT that races a same-statement cascade; the fix likely needs an
  **immediate** (non-deferred) parent-side existence check on the lens path —
  mirroring the physical RESTRICT timing — or a runtime pre-check analogous to
  `assertNoRestrictedChildrenForParentMutation` keyed off the *logical* FK action
  rather than the basis FK action.
- Decide and document the intended semantics when basis and lens actions diverge
  the other way too (e.g. lens RESTRICT over basis SET NULL: should the parent
  delete ABORT, or null the children? The lens RESTRICT should win ⇒ ABORT).

## Test coverage to add

- Behavioral: the repro above asserts ABORT + both rows survive (DELETE), and the
  UPDATE-of-referenced-key analogue, for each non-restrict basis action
  (`cascade`, `set null`, `set default`) on the op.
- Regression: confirm the existing elision/retention collector-decision tests
  (`lens enforcement: parent-side FK basis-redundancy elision`) still pass — this
  fix changes *timing/firing*, not the collector's retain/elide decision.
- Confirm the `restrict`-basis elided path is unaffected (still enforced by the
  immediate basis check).

## Notes for the implementer

- The existing test block already pins the **collector decision** (retain) for the
  cascade case; what is missing is the **end-to-end firing**. Start from the repro
  here.
- `docs/lens.md` § Constraint Attachment currently states the parent-side check is
  "auto-deferred to commit" and lists CASCADE/SET NULL/SET DEFAULT only as
  "out of scope (backlog)" for *lens-declared* actions — it does not call out that
  a RESTRICT lens FK over a non-restrict **basis** FK is under-enforced. Update it
  with the corrected timing once fixed.
