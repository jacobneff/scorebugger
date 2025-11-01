const shouldEnableDeleteSet = ({ mode, totalCompletedSets, displayedHistoryIndex, hasDraftSet }) => {
  if (totalCompletedSets <= 0) return false;
  const totalSets = totalCompletedSets + (hasDraftSet ? 1 : 0);
  if (totalSets <= 0) return false;
  const lastIndex = totalSets - 1;
  const currentIndex =
    mode === "current"
      ? lastIndex
      : Math.min(Math.max(displayedHistoryIndex, 0), Math.min(totalCompletedSets - 1, lastIndex));
  return currentIndex === lastIndex;
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

export { buildShortcutMap, shouldEnableDeleteSet };
