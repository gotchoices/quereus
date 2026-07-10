description: The sync server writes messages to a client's socket as fast as it can generate them without checking whether the client is keeping up, so a slow client can make the server buffer an unbounded amount of data in memory.
files:
  - packages/sync-coordinator/src/server/websocket.ts   # sendMessage / snapshot + change broadcast loops
  - packages/sync-coordinator/src/service/coordinator-service.ts
----

## Problem

The coordinator's socket writes (e.g. the `snapshot_chunk` streaming loops in
`handleGetSnapshot`/`handleResumeSnapshot`, and change broadcasts) call `socket.send(...)`
without respecting the socket's drain/backpressure signal. A slow or stalled consumer causes
the server-side send buffer to grow without bound — a memory-exhaustion risk driven by a
single slow client.

Surfaced by the same review as the shared-protocol work.

## Direction / open questions (for the fix pass)

- Introduce backpressure on the streaming send paths: await the socket's drain (or check
  `bufferedAmount` / the `ws` write callback) before yielding the next chunk, so the producer
  paces to the consumer.
- Decide a policy for a client that never drains: a buffered-bytes ceiling after which the
  session is closed, vs. unbounded wait.
- Applies most acutely to snapshot streaming (many large chunks); confirm the change broadcast
  path needs the same treatment.

Hardening under adverse client behavior; backlog rather than an active bug.
