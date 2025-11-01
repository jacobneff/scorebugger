const shouldEnableDeleteSet = (mode, totalCompletedSets, displayedHistoryIndex) =>
  mode === "history" &&
  totalCompletedSets > 0 &&
  displayedHistoryIndex === totalCompletedSets - 1;

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
