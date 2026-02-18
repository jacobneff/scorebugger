# Tournament Realtime (PR6)

PR6 adds tournament-level Socket.IO rooms so public and admin tournament pages update without manual refresh.

## Room Model

- Room format: `tournament:<publicCode>`
- Join event (client -> server): `tournament:join`
  - Payload: `{ code: string }`
  - Behavior:
    - Tournament code is normalized to uppercase.
    - Join succeeds only when a tournament exists for that code.
    - On success, server emits `tournament:joined` with `{ code }`.
    - On failure, server emits `tournament:error` with `{ message: "Not found" }`.
- Leave event (client -> server): `tournament:leave`
  - Payload: `{ code: string }`
  - Behavior: socket leaves `tournament:<code>`.

## Tournament Event Channel

Server emits all tournament realtime updates on a single channel:

- Event name: `tournament:event`
- Payload shape:

```json
{
  "tournamentCode": "ABC123",
  "type": "POOLS_UPDATED",
  "data": {},
  "ts": 1760000000000
}
```

### Supported `type` values

1. `POOLS_UPDATED`
   - `data`: `{ phase: "phase1" | "phase2", poolIds?: string[] }`
2. `MATCHES_GENERATED`
   - `data`: `{ phase: "phase1" | "phase2" | "playoffs", matchIds?: string[] }`
3. `MATCH_STATUS_UPDATED`
   - `data`: `{ matchId: string, status: "scheduled" | "live" | "final" }`
4. `MATCH_FINALIZED`
   - `data`: `{ matchId: string }`
5. `MATCH_UNFINALIZED`
   - `data`: `{ matchId: string }`
6. `PLAYOFFS_BRACKET_UPDATED`
   - `data`: `{ bracket: "gold" | "silver" | "bronze", affectedMatchIds?: string[] }`
7. `SCOREBOARD_SUMMARY`
   - `data`: scoreboard summary payload (see below)

## SCOREBOARD_SUMMARY Schema

`SCOREBOARD_SUMMARY` is emitted from the existing scoreboard update socket flow when the scoreboard belongs to a tournament match.

```json
{
  "matchId": "matchObjectId",
  "scoreboardId": "scoreboardObjectId",
  "sets": { "a": 1, "b": 0 },
  "points": { "a": 14, "b": 12 },
  "serving": "A",
  "setIndex": 2
}
```

Notes:

- Only minimal scoreboard summary fields are emitted.
- No private tournament/user fields are included.
- Emission is throttled to once every 250ms per scoreboard.
- A scoreboard-to-match cache is populated during match generation and on first miss lookup.
