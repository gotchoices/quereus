description: If a table was created before sync was attached and only that device has it, one write to the table sends its data to the server without its definition, and from then on no new device can finish its first sync.
architecture: docs/sync.md#rows-sync-has-never-recorded
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts # recordCommitBatch (~847): records a table's cells without checking anyone was told the table exists
  - packages/quereus-sync/src/sync/unrecorded-rows.ts # missingCreateEvents (~274) and hasLiveCreate (~305): adoption already sends the missing definition
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Apps that create tables after attaching sync, or that ship the same schema to every device, never hit this, and checking on the local write path adds a read of the table's migrations unless the answer is remembered per table.
----
<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-11-03T17:53:18.186Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\1-bug-sync-write-to-unannounced-table-strands-new-devices.fix.2026-11-03T17-53-18-184Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->

## What happens

Run with real clients against a real coordinator, under default options:

1. Device D creates `extra (id integer primary key, v text not null) using store` before sync attaches. No `create_table` migration is recorded.
2. D runs `insert into extra values (1, 'y')`. An `update` of a row already there does the same.
3. D connects. Its status is `synced`, and the server stores the cells for `extra`.
4. A new device C connects. It holds no `extra` table. Its snapshot fails with `No table schema for main.extra — sync pk identity is unresolvable`, and it ends `disconnected`.

The coordinator keeps no table definitions, so the definition can only come from D. Adoption handles this by sending a `create_table` along with a table's first adopted rows, but ordinary local capture does not. Devices already connected were not checked in this run; `docs/sync.md` says they hold such cells in quarantine.

The run used `autoReconnect: false`, so retries were not observed. Nothing on the server changes between attempts, so a retry would be expected to fail the same way, but that is inferred.

## Expected behaviour

A write that sends a table's cells also makes sure its definition is sent, so a new device can bootstrap. One option is for local capture to announce a table the first time it records a cell for one with no live create, reusing `missingCreateEvents`. The ticket that picks this up should weigh that against having a snapshot skip a table it has no definition for.

The first fix run was interrupted by a machine restart. Its probe spec, which ran against `test/sync/_peer-harness.ts`, is saved at `tickets/.logs/zz-probe.unannounced-table.spec.ts.txt`, and its results are at the end of that run's log.
