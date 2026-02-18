import { planTournamentTeamSync } from "../components/tournamentTeamDiff.utils.js";

describe("planTournamentTeamSync", () => {
  it("returns no operations when teams are unchanged", () => {
    const existing = [
      { _id: "team-1", name: "Eagles", shortName: "EAG", seed: 1 },
      { _id: "team-2", name: "Tigers", shortName: "TIG", seed: 2 },
    ];

    const draft = [
      { _id: "team-1", name: "Eagles", shortName: "EAG", seed: 1 },
      { _id: "team-2", name: "Tigers", shortName: "TIG", seed: 2 },
    ];

    expect(planTournamentTeamSync(existing, draft)).toEqual({
      patches: [],
      creates: [],
      deletes: [],
    });
  });

  it("plans patch operations for changed existing teams", () => {
    const existing = [{ _id: "team-1", name: "Eagles", shortName: "EAG", seed: 1 }];
    const draft = [{ _id: "team-1", name: "Eagles Elite", shortName: "EAG", seed: "" }];

    expect(planTournamentTeamSync(existing, draft)).toEqual({
      patches: [
        {
          id: "team-1",
          payload: {
            name: "Eagles Elite",
            seed: null,
          },
        },
      ],
      creates: [],
      deletes: [],
    });
  });

  it("plans create operations for new teams", () => {
    const existing = [];
    const draft = [
      { _id: "", name: "Falcons", shortName: "FAL", seed: "4" },
      { _id: "", name: "", shortName: "", seed: "" },
    ];

    expect(planTournamentTeamSync(existing, draft)).toEqual({
      patches: [],
      creates: [{ name: "Falcons", shortName: "FAL", seed: 4 }],
      deletes: [],
    });
  });

  it("plans delete operations for removed teams", () => {
    const existing = [
      { _id: "team-1", name: "Eagles", shortName: "EAG", seed: 1 },
      { _id: "team-2", name: "Tigers", shortName: "TIG", seed: 2 },
    ];
    const draft = [{ _id: "team-1", name: "Eagles", shortName: "EAG", seed: 1 }];

    expect(planTournamentTeamSync(existing, draft)).toEqual({
      patches: [],
      creates: [],
      deletes: ["team-2"],
    });
  });
});

