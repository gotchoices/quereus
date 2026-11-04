description: A date-and-time written with a named time zone is stored as that zone's local clock reading instead of being converted to UTC, so it silently names the wrong instant.
architecture: docs/types.md#temporal-types
files:
  - packages/quereus/src/types/temporal-types.ts   # parseDateTimeStringToUtcPlain, shared by DATE, TIME and DATETIME
  - packages/quereus/test/logic/98-temporal-edge-cases.sqllogic   # canonicalization sections cover only the [UTC] annotation
repro: verified
----

`docs/types.md` § DATETIME says inputs with an offset or `[zone]` annotation are converted to UTC, and the comment on `parseDateTimeStringToUtcPlain` says the same. The offset forms do convert. A named-zone form does not, because that branch calls `Temporal.ZonedDateTime.from(v).toPlainDateTime()`, which returns the clock reading in the input's own zone.

Reproduced on the memory module:

```sql
create table zn (id integer primary key, t datetime null);
insert into zn values (1, '2020-01-01T00:00:00-05:00[America/New_York]');
select t from zn;
-- stored: 2020-01-01T00:00:00
-- documented: 2020-01-01T05:00:00

select id from zn where t = '2020-01-01T05:00:00Z';
-- returns no row; the same instant spelled with a Z should find it
```

The existing canonicalization tests use only `[UTC]`, where the two readings agree, so they do not catch this.

Expected behaviour: a value carrying a named zone is stored as the UTC reading of the instant it names, for DATETIME. The same helper feeds DATE and TIME parsing, so those conversions extract the wrong date or time for these inputs too and need checking against the same rule.

Rows already stored from a zone-annotated input hold the local reading, and the zone is not recoverable from the stored value. The fix can only correct new writes, and its notes should say so.
