# Quereus: cryptic "Symbol 'id' already exists in the same scope" on GROUP BY of same-named qualified columns

**Package:** `@quereus/quereus` (observed on 4.3.0, React Native / optimystic strand DB).
**Severity:** Low — correct behavior is arguable, but the error message is hard to act on.

## Repro

```sql
SELECT i.id, i.name, c.id AS categoryId, c.name AS categoryName, count(lei.entry_id) AS usageCount
FROM items i
JOIN categories c ON c.id = i.category_id
LEFT JOIN log_entry_items lei ON lei.item_id = i.id
WHERE c.type_id = ?
GROUP BY i.id, i.name, c.id, c.name
```

Fails at prepare/plan time with:

```
QuereusError: Symbol 'id' already exists in the same scope.   (code 1)
```

## Diagnosis

The trigger is the **GROUP BY** listing two *qualified* columns whose base names collide
(`i.id` and `c.id`, likewise `i.name` and `c.name`). Removing the GROUP BY (computing the
count with a correlated scalar subquery instead) resolves it; so does — presumably — aliasing.
The SELECT projection itself is fine: only one bare `id` is projected (`i.id`), `c.id` is aliased.

For comparison, these sibling queries work: a single-table GROUP BY (`GROUP BY c.id, c.name`)
and multi-table joins that project only one table's `id` as bare `id`.

## Two points of feedback

1. **Message clarity (the main ask).** "Symbol 'id' already exists in the same scope" doesn't tell
   the author *which clause* (GROUP BY), *which two columns* collided, or *how to fix it*. A message like
   `GROUP BY: duplicate column name 'id' from items.id and categories.id — alias one of them` would be
   directly actionable. As-is, with several `id` references in the query, it's a guessing game.

2. **Behavior (secondary).** Standard SQL permits `GROUP BY a.id, b.id` (grouping by two qualified
   columns with the same base name); the grouping *keys* don't need to form a named relation with unique
   attributes. If the current strictness is intentional (Third-Manifesto relational purity), point 1 still
   stands; if not, consider allowing qualified same-base-name columns in GROUP BY.
