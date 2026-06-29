---
description: Lamina-smoke regression — SCN-NAV — anonymous `?` parameter in a HAVING clause throws "? isn't a parameter"; tag-filter viewport query (EntityTag group/having) fails
prereq:
files:
  - packages/quereus/src/planner/resolve.ts
features: [SCN-NAV]
aspect: lamina-smoke
owner: quereus
---

# Lamina-smoke regression — SCN-NAV — anonymous `?` param in HAVING clause is unresolvable

**Feature:** [`SCN-NAV — Hierarchy Travel`](../../../SiteCAD_branch/features/SCN%20-%20Scene/NAV%20-%20Hierarchy%20Travel.md)
**Verdict:** partial
**Browser tool used:** chrome-devtools

## Triage

**Owning package:** `quereus`

**Why this owner:** SiteCAD's tag-filter computes the viewport-visible entity set with a
*valid* parameterized query:

```sql
select entity_id from EntityTag
 where tag in (?)
 group by entity_id
 having count(distinct tag) = ?
```
params: `["Mesh", 1]`

Quereus throws `? isn't a parameter` (StatusCode.ERROR) while planning it. Bare `?`
positional parameters and `... in (${placeholders})` lists are used pervasively across
the SiteCAD codebase and work everywhere else (e.g. `where E.id = ?`,
`where id in (?)` in drawing/export/binding code). The **only** element unique to this
query is the `?` in the **HAVING** clause. The throw originates in Quereus at
`packages/quereus/src/planner/resolve.ts:82` (`resolveParameter` →
`scope.resolveSymbol('?')` returns undefined), so the anonymous-parameter symbol `'?'`
is not visible in the scope active while resolving the HAVING expression (the
aggregate-output scope). The parameter scope is not threaded into HAVING-clause
resolution. The SiteCAD SQL is well-formed — this is a Quereus planner scoping bug.

**Cross-repo path:** this ticket lives in the quereus repo at
`C:/projects/quereus/tickets/fix/lamina-smoke-scn-nav-having-clause-anonymous-param-not-resolved.md`.
The site-cad trigger surface is `packages/site-cad/src/lib/scene/scene.ts:370-379`
(`Scene.getVisibleEntityIds`).

## Reproduction

1. In SiteCAD (vite :3002), open a site with at least one tagged entity (add a tag via
   the Inspector "add tag…" field — e.g. tag the Mesh `zone-a`).
2. In the Scene panel, type a tag into **Filter by tag… (/)** and apply the filter chip
   (`+ Filter "zone-a"`).
3. Observed: the left-panel hierarchy tree filters correctly (separate query path), **but**
   the viewport-visibility query throws. Console shows
   `[QuereusWorker] Query error: {"error":"? isn't a parameter", sql:"select entity_id from EntityTag where tag in (?) group by entity_id having count(distinct tag) = ?", params:["zone-a",1]}`
   followed by an `Uncaught (in promise)` from `scene.ts:373` via `Viewport.svelte:325`.

Minimal SQL repro (any Quereus session with a grouped table):

```sql
select entity_id from EntityTag
 where tag in (?)
 group by entity_id
 having count(distinct tag) = ?;   -- params: ['x', 1]  → "? isn't a parameter"
```

**Expected:** the anonymous `?` in the HAVING clause resolves to the bound parameter, the
query returns the entity ids whose tag set contains all requested tags, and the viewport
filters/dims non-matching entities. (A non-grouped query with the same `?` placeholders
resolves fine, so HAVING-clause parameter resolution should behave identically.)

## Evidence

### Console

```
[QuereusWorker] Query error: {"error":"? isn't a parameter",
 "sql":"select entity_id from EntityTag\n where tag in (?)\n group by entity_id\n having count(distinct tag) = ?",
 "paramsLength":2,"paramsTypes":["string","number"],"params":["Mesh",1]}
Uncaught (in promise)   (quereus-service.ts:314 → service.ts:290 → scene.ts:373 → Viewport.svelte:325)
```

### Network

n/a (client-side Quereus worker error; no failed XHR).

### Screenshot / snapshot

Scene panel filtered to `zone-a (1)` reveals "Mesh - zone-a" in the tree (tree path OK);
the console error fires concurrently from the viewport visibility path.

## Suspect surface

- **Quereus:** `packages/quereus/src/planner/resolve.ts:74-83` (`resolveParameter`) throws
  when `scope.resolveSymbol('?')` misses. The parameter scope that registers the anonymous
  `?` symbol is not an ancestor of the scope used to resolve the HAVING clause of a grouped
  SELECT. Likely fix: ensure HAVING-clause (aggregate-output) resolution inherits the
  outer parameter scope — same as WHERE-clause resolution does. Look at how the
  group/aggregate scope is constructed in the select-aggregates planner
  (`packages/quereus/src/planner/building/select-aggregates.ts`) and whether it chains to
  the parameter-bearing parent scope.
- **site-cad trigger (not the bug):** `packages/site-cad/src/lib/scene/scene.ts:370-379`
  builds `where tag in (${placeholders}) ... having count(distinct tag) = ?`. A local
  workaround (sidesteps but does not fix the engine bug): inline the trusted integer
  `tagStrings.length` into the SQL text instead of binding it as a parameter, since it is
  an internal array length, not user input.

Relevant docs:
- SiteCAD `docs/site-cad.md` (Scene / tag filter)
- Quereus planner scope/parameter resolution

## Notes

- User-facing impact is **partial**, not a full gap: the Scene-panel **hierarchy tree**
  tag filter works (it reveals matching entities via a different query path), and camera
  framing on a located entity (double-click a tree node) works. Only the **viewport
  visibility** reflection of the tag filter (`getVisibleEntityIds`) throws, leaving an
  uncaught promise rejection per filter application.
- Same root cause would break any SiteCAD query that binds a `?` inside a HAVING clause.
- Not the audit-agent's inline-fix size class: the true fix is an upstream Quereus planner
  scope-chaining change in a different repo needing engine-side judgement.
