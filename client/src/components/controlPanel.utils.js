import { MAX_TOTAL_SETS } from "../constants/scoreboard.js";

const shouldEnableDeleteSet = ({ mode, totalCompletedSets, historyIndex }) => {
  if (mode !== "history") return false;
  if (totalCompletedSets <= 0) return false;
  const lastCreatedIndex = totalCompletedSets - 1;
  return historyIndex === lastCreatedIndex;
};

const deriveSetNavigationState = ({
  mode,
  totalCompletedSets,
  historyIndex = 0,
  maxTotalSets = MAX_TOTAL_SETS,
}) => {
  const completedCount = Math.max(Number(totalCompletedSets) || 0, 0);
  const safeMaxTotalSets = Math.max(Number(maxTotalSets) || 0, 0);
  const safeHistoryIndex =
    completedCount > 0
      ? Math.min(Math.max(Number(historyIndex) || 0, 0), completedCount - 1)
      : 0;
  const hasLiveSetSlot = safeMaxTotalSets > 0 && completedCount < safeMaxTotalSets;
  const currentSetNumber = hasLiveSetSlot
    ? Math.max(completedCount + 1, 1)
    : Math.max(completedCount, 1);
  const totalSetCount = hasLiveSetSlot ? currentSetNumber : Math.max(completedCount, 1);
  const historySetNumber = completedCount > 0 ? safeHistoryIndex + 1 : 1;
  const activeSetNumber = mode === "current" ? currentSetNumber : historySetNumber;

  return {
    completedCount,
    totalSetCount,
    activeSetNumber,
    currentSetNumber,
    hasLiveSetSlot,
    deleteLabelNumber: completedCount,
    hasCompletedSets: completedCount > 0,
  };
};

const KEY_DISPLAY_OVERRIDES = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
};

const buildShortcutMap = (config) =>
  Object.fromEntries(
    Object.entries(config).map(([action, value]) => {
      const rawKey = typeof value.key === "string" ? value.key.trim() : "";
      if (!rawKey) {
        return [action, null];
      }
      const normalizedKey = rawKey.toLowerCase();
      const display =
        value.display ??
        KEY_DISPLAY_OVERRIDES[normalizedKey] ??
        (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey.toUpperCase());
      return [action, { ...value, key: rawKey, normalizedKey, display }];
    })
  );

export { buildShortcutMap, deriveSetNavigationState, shouldEnableDeleteSet };
