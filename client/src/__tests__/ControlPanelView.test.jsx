import { deriveSetNavigationState, shouldEnableDeleteSet } from "../components/controlPanel.utils.js";

describe("shouldEnableDeleteSet", () => {
  it("returns false when there are no completed sets", () => {
    expect(
      shouldEnableDeleteSet({
        mode: "current",
        totalCompletedSets: 0,
        historyIndex: 0,
      })
    ).toBe(false);
  });

  it("returns false in current mode even when sets exist", () => {
    expect(
      shouldEnableDeleteSet({
        mode: "current",
        totalCompletedSets: 2,
        historyIndex: 0,
      })
    ).toBe(false);
  });

  it("returns false when viewing an earlier completed set", () => {
    expect(
      shouldEnableDeleteSet({
        mode: "history",
        totalCompletedSets: 3,
        historyIndex: 1,
      })
    ).toBe(false);
  });

  it("allows delete only when viewing the final completed set", () => {
    expect(
      shouldEnableDeleteSet({
        mode: "history",
        totalCompletedSets: 3,
        historyIndex: 2,
      })
    ).toBe(true);
  });

  it("returns false when the history index exceeds the last set", () => {
    expect(
      shouldEnableDeleteSet({
        mode: "history",
        totalCompletedSets: 2,
        historyIndex: 5,
      })
    ).toBe(false);
  });
});

describe("deriveSetNavigationState", () => {
  it("includes the live set slot when viewing history", () => {
    const result = deriveSetNavigationState({
      mode: "history",
      totalCompletedSets: 1,
      historyIndex: 0,
    });

    expect(result.totalSetCount).toBe(2);
    expect(result.activeSetNumber).toBe(1);
    expect(result.deleteLabelNumber).toBe(1);
  });

  it("keeps the total set count accurate with multiple completed sets", () => {
    const result = deriveSetNavigationState({
      mode: "history",
      totalCompletedSets: 3,
      historyIndex: 1,
    });

    expect(result.totalSetCount).toBe(4);
    expect(result.activeSetNumber).toBe(2);
  });

  it("reports the live set number when editing the current set", () => {
    const result = deriveSetNavigationState({
      mode: "current",
      totalCompletedSets: 2,
    });

    expect(result.totalSetCount).toBe(3);
    expect(result.activeSetNumber).toBe(3);
    expect(result.hasCompletedSets).toBe(true);
  });

  it("clamps the history index when no sets are completed", () => {
    const result = deriveSetNavigationState({
      mode: "history",
      totalCompletedSets: 0,
      historyIndex: 5,
    });

    expect(result.totalSetCount).toBe(1);
    expect(result.activeSetNumber).toBe(1);
    expect(result.hasCompletedSets).toBe(false);
  });

  it("stops adding a live slot once the maximum total sets are completed", () => {
    const result = deriveSetNavigationState({
      mode: "history",
      totalCompletedSets: 6,
      historyIndex: 5,
      maxTotalSets: 5,
    });

    expect(result.totalSetCount).toBe(6);
    expect(result.activeSetNumber).toBe(6);
    expect(result.deleteLabelNumber).toBe(6);
  });
});
