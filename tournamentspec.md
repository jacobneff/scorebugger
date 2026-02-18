# Tournament Module Spec v0.1 (for Scorebugger)

## Goal
Add a Tournament section to Scorebugger that generates and publishes:

- Phase 1 pools (seeded + admin-adjustable)
- Phase 2 re-pool (new opponents)
- Gold/Silver/Bronze playoffs (5 teams each)
- Live schedule + standings + brackets that update as matches are finalized

## Non-goals (MVP)
- No automatic match finalization (manual finalize only)
- No Swiss round-to-round pairing
- No third-place matches
- No complex strength-of-schedule tiebreaks (keep it simple + transparent)

## Core Concept: Match Owns a Scoreboard
Each tournament match has a `scoreboardId`. Score entry happens through the existing Scorebugger control panel.

Tournament state updates when a match is manually finalized.

## Match Rules / Scoring Configuration
- Format: Best of 3 sets
- Set 1/2: to 25, win by 2, cap configurable (default cap 27)
- Set 3: to 15, win by 2, cap configurable (default cap 17)

### Cap behavior (explicit)
If `capPoints` is set and a team reaches cap first, they win the set even if not up by 2 (example: `27-26` wins).

These settings are stored on the Tournament (defaults) and copied onto each Match/Scoreboard config at generation time.

## Standings Tiebreakers (Pool + Overall Seeding)
Only finalized matches count.

Order:
1. Match W-L
2. Set % = `setsWon / setsPlayed`
3. Point differential = `pointsFor - pointsAgainst` (across all finalized sets)
4. Head-to-head (only when exactly 2 teams are tied and they played)
5. Coin flip (admin button to resolve tie; store resolution)

## Manual Finalize (Critical)
Add an admin action on each match:

- `Finalize match`: locks the match result for tournament standings
- `Unfinalize match` (admin only): reopens standings changes

Tournament standings and brackets update only on finalize/unfinalize.

## Entities (Mongo / Mongoose)

### Tournament
- `_id`
- `name`, `date`, `timezone` (default `America/New_York`)
- `publicCode` (6 chars)
- `status`: `setup | phase1 | phase2 | playoffs | complete`
- `facilities`:
  - `SRC` courts: `["SRC-1","SRC-2","SRC-3"]`
  - `VC` courts: `["VC-1","VC-2"]`
- `settings`:
  - `scoring`: `{ setTargets: [25,25,15], winBy: 2, caps: [27,27,17] }`
  - `tiebreakers`: fixed list above
- `createdByUserId`

### TournamentTeam
- `_id`, `tournamentId`
- `name`, `shortName`, `logoUrl?`
- `seed` (admin-entered integer; used for Phase 1 initial placement)

### Pool
- `_id`, `tournamentId`, `phase` (`phase1` or `phase2`)
- `name` (`A-E`, `F-J`)
- `teamIds[3]` (orderable)
- Optional: `homeCourt` (one of SRC/VC courts)

### Match
- `_id`, `tournamentId`
- `phase`: `phase1 | phase2 | playoffs`
- `poolId?`
- `bracket?`: `gold | silver | bronze`
- `bracketRound?`: `R1 | R2 | R3`
- `seedA?`, `seedB?` (for playoffs labeling)
- `roundBlock` (integer; example: Phase 1 blocks 1-3, Phase 2 blocks 4-6, playoffs 7-9)
- `facility`: `SRC | VC`
- `court`: `SRC-1` etc.
- `teamAId`, `teamBId`
- `refTeamIds[]` (for ops sheet / assignments)
- `scoreboardId`
- `status`: `scheduled | live | final`
- `finalizedAt?`, `finalizedBy?`

## Phase Formats

### Phase 1 (Pools A-E)
- Admin creates 5 pools of 3 using team seeds as a starting point.
- Admin can adjust pool membership after generation (drag/drop).
- Phase 1 matches auto-generated per pool.

Round order per pool (3 matches):
1. `1 vs 2` (3 refs)
2. `2 vs 3` (1 refs)
3. `1 vs 3` (2 refs)

Scheduling constraint: fixed hourly blocks; assign pools to courts so each round is exactly 5 matches.

### Phase 2 (Pools F-J)
- Re-pool based on Phase 1 pool placements (`A1..E3`).
- Use deterministic mapping (the one you liked), with rematch-avoid swaps allowed.
- Generate Phase 2 matches using the same 3-match order per pool.

### Seeding and Playoffs (Gold/Silver/Bronze = 5 teams each)
After Phase 2, compute overall seeds `1-15` using the tiebreakers above.

- Seeds `1-5` -> Gold
- Seeds `6-10` -> Silver
- Seeds `11-15` -> Bronze

5-team bracket structure (no 3rd place):
1. Round 1:
   - `4 vs 5`
   - `2 vs 3`
2. Round 2:
   - `1 vs winner(4/5)`
3. Round 3:
   - Final: `winner(R2) vs winner(2/3)`

## Court / Facility / Ref Assignments (Ops Rules)

### Playoff Round 1 (same start time)
| Court | Match | Ref |
| --- | --- | --- |
| SRC-1 | Gold 4v5 | Bronze #1 |
| SRC-2 | Silver 4v5 | Bronze #2 |
| SRC-3 | Bronze 4v5 | Bronze #3 |
| VC-1 | Gold 2v3 | Silver #1 |
| VC-2 | Silver 2v3 | Gold #1 |

After Round 1:
- Bronze bracket stays SRC
- Gold + Silver stay VC
- No 3rd-place matches

### Round 2
- VC-1: Gold `1 vs winner(Gold 4/5)`
- VC-2: Silver `1 vs winner(Silver 4/5)`
- SRC: Bronze `2v3` and Bronze `1v(4/5)` as scheduled (third SRC court is buffer)

### Round 3
- VC-1 Gold Final
- VC-2 Silver Final
- SRC Bronze Final

Refs in later rounds: default to "loser refs next" within the same facility, but always allow admin override.

## UI Requirements

### Admin Views

#### Tournament setup page
- Add/edit teams, seeds
- Set caps per set (defaults `27/27/17`)

#### Pool editor (Phase 1)
- Drag/drop teams into Pools A-E
- `Generate Phase 1 matches`

#### Live admin dashboard
- Schedule by `roundBlock` + court
- Each match card: open control panel, mark live, finalize/unfinalize

#### Phase 2 generator
- Computes placements from finalized Phase 1
- Generates F-J pools + matches
- Allows manual swaps before locking

#### Playoffs generator
- Generates brackets + matches with ops assignments

#### Ops Sheet view
- Round-by-round table with court, match, refs, and `open control panel`

### Public Views
Route: `/t/:publicCode`

- Current phase, schedule list, standings, bracket tabs
- Match status badges (`scheduled/live/final`)
- Optional: link to overlay view (read-only)

## Realtime Updates
Add Socket.IO room `tournament:<publicCode>`.

Emit on:
- Match finalized/unfinalized
- Match status changes
- Optional: scoreboard summary change (only if you want live scores in the schedule without opening the match)

## Testing Requirements (Minimum)

Unit tests for:
- Standings + tiebreakers
- Pool match generation
- Playoff match generation + ops assignment

Integration tests for:
- Generate phase endpoints create correct number of pools/matches/scoreboards

## Codex Execution Plan (PR-by-PR)
These are "agent-safe" tasks: small, testable, and hard to misinterpret.

### PR1 - Models + CRUD
Deliverables:
- Mongoose models: Tournament, TournamentTeam, Pool, Match
- Admin CRUD endpoints
- Public `GET /t/:code` read endpoints

Acceptance:
- Can create tournament + teams; retrieve by code

### PR2 - Admin Pool Editor (Phase 1)
Deliverables:
- UI to assign seeds and drag/drop into Pools A-E
- `Generate Phase 1 matches` button creates 15 matches + 15 scoreboards

Acceptance:
- Matches have proper courts/roundBlocks and scoreboardIds

### PR3 - Standings from Finalized Matches + Finalize Flow
Deliverables:
- Manual finalize/unfinalize for match
- Standings computed only from finalized matches

Acceptance:
- Finalize changes standings instantly in UI

### PR4 - Phase 2 Re-pool Generator + Editor
Deliverables:
- Compute placements `A1..E3` from finalized Phase 1
- Generate Pools F-J using mapping + rematch-avoid swaps
- Generate matches + scoreboards

Acceptance:
- No rematches unless unavoidable; admin can tweak before locking

### PR5 - Playoffs Generator + Ops Sheet
Deliverables:
- Seed `1-15` -> `5/5/5` brackets
- Generate bracket matches and assign courts/refs per ops spec
- Ops view (printable)

Acceptance:
- Playoff Round 1 matches exactly match the SRC/VC layout

### PR6 - Tournament Realtime Room (Optional)
Deliverables:
- Tournament socket room updates on finalize/status

Acceptance:
- Public page updates without refresh
