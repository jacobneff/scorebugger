import { createContext, useContext, useEffect, useMemo, useState } from "react";

const SettingsContext = createContext(null);

const STORAGE_KEY = "setpoint.settings";

const defaultSettings = {
  shortcutsEnabled: true,
};

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    if (typeof window === "undefined") return defaultSettings;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultSettings;
      const parsed = JSON.parse(raw);
      return {
        ...defaultSettings,
        ...parsed,
      };
    } catch {
      return defaultSettings;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* no-op */
    }
  }, [settings]);

  const value = useMemo(
    () => ({
      settings,
      shortcutsEnabled: settings.shortcutsEnabled,
      setShortcutsEnabled: (enabled) =>
        setSettings((prev) => ({
          ...prev,
          shortcutsEnabled: Boolean(enabled),
        })),
    }),
    [settings]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return context;
}
