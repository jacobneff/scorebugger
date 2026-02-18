# Tournament API (PR1)

This document describes the new Tournament module API added in PR1.

## Auth
- Admin endpoints require `Authorization: Bearer <jwt>`.
- Only the tournament owner (`createdByUserId`) can read/update that tournament and manage its teams.

## Admin Endpoints

### `POST /api/tournaments`
Create a tournament.

Request body:
```json
{
  "name": "Summer Classic",
  "date": "2026-07-10T14:00:00.000Z",
  "timezone": "America/New_York"
}
```

Response (201):
```json
{
  "_id": "...",
  "name": "Summer Classic",
  "date": "2026-07-10T14:00:00.000Z",
  "timezone": "America/New_York",
  "publicCode": "A1B2C3",
  "status": "setup",
  "facilities": {
    "SRC": ["SRC-1", "SRC-2", "SRC-3"],
    "VC": ["VC-1", "VC-2"]
  },
  "settings": {
    "scoring": {
      "setTargets": [25, 25, 15],
      "winBy": 2,
      "caps": [27, 27, 17]
    }
  },
  "createdByUserId": "..."
}
```

### `GET /api/tournaments`
List tournaments created by the current user.

### `PATCH /api/tournaments/:id`
Update tournament fields: `name`, `date`, `timezone`, `status`.

Request body example:
```json
{
  "status": "phase1",
  "timezone": "America/Chicago"
}
```

### `GET /api/tournaments/:id`
Get one owned tournament plus counts.

Response includes:
- tournament document fields
- `teamsCount`
- `poolsCount`
- `matchesCount`

### `POST /api/tournaments/:id/teams`
Create tournament teams (single or bulk).

Single create:
```json
{
  "name": "Northside VBC",
  "shortName": "NSV",
  "logoUrl": "https://example.com/nsv.png",
  "seed": 2
}
```

Bulk create:
```json
[
  {
    "name": "Northside VBC",
    "shortName": "NSV",
    "seed": 2
  },
  {
    "name": "Southside VBC",
    "shortName": "SSV",
    "seed": 3
  }
]
```

### `GET /api/tournaments/:id/teams`
List teams for an owned tournament.

### `PATCH /api/tournament-teams/:teamId`
Update team fields: `name`, `shortName`, `logoUrl`, `seed`.

### `DELETE /api/tournament-teams/:teamId`
Delete a team from an owned tournament.

## Public Endpoints

### `GET /api/tournaments/code/:publicCode`
Returns sanitized tournament data and team list.

Returned tournament fields:
- `id`
- `name`
- `date`
- `timezone`
- `status`
- `facilities`
- `publicCode`

Returned team fields:
- `id`
- `name`
- `shortName`
- `logoUrl`
- `seed`

Internal ownership fields (for example `createdByUserId`) are not exposed.

### `GET /api/tournaments/code/:publicCode/matches`
Returns match list for a tournament code.

Optional query:
- `phase=phase1|phase2|playoffs`

Returned match fields include core scheduling/state fields such as:
- `phase`, `poolId`, `bracket`, `bracketRound`, `roundBlock`
- `facility`, `court`
- `teamAId`, `teamBId`, `refTeamIds`
- `scoreboardId`, `status`, `finalizedAt`, timestamps
