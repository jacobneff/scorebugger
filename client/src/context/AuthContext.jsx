import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { API_URL } from '../config/env.js';

const STORAGE_KEY = 'scorebugger.auth';
const NETWORK_ERROR_FALLBACK =
  'Unable to reach the server. Please check your connection and try again.';

const AuthContext = createContext(null);

function loadStoredAuth() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.user) return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

export function AuthProvider({ children }) {
  const [authState, setAuthState] = useState(() => loadStoredAuth() ?? { user: null, token: null });
  const [initializing, setInitializing] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);

  useEffect(() => {
    if (initializing) {
      setInitializing(false);
    }
  }, [initializing]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (authState?.token && authState?.user) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(authState));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, [authState]);

  const handleAuthResponse = useCallback((data) => {
    if (!data?.token || !data?.user) {
      throw new Error('Malformed authentication response');
    }

    setAuthState({
      token: data.token,
      user: data.user,
    });

    return { ok: true };
  }, []);

  const extractErrorMessage = async (response) => {
    try {
      const payload = await response.json();
      if (payload?.message) return payload.message;
    } catch (error) {
      // Ignore JSON parse errors
    }
    return response.status >= 400 && response.status < 500
      ? 'Unable to authenticate with the provided credentials'
      : 'Authentication failed';
  };

  const normalizeNetworkError = (error) => {
    if (!error) return NETWORK_ERROR_FALLBACK;
    const message = String(error?.message || '').trim();
    if (!message) return NETWORK_ERROR_FALLBACK;
    const lowered = message.toLowerCase();
    if (
      lowered === 'failed to fetch' ||
      lowered === 'networkerror when attempting to fetch resource.' ||
      lowered === 'load failed'
    ) {
      return NETWORK_ERROR_FALLBACK;
    }
    return message;
  };

  const login = useCallback(
    async ({ email, password }) => {
      setAuthBusy(true);
      try {
        const response = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        if (!response.ok) {
          const message = await extractErrorMessage(response);
          return { ok: false, message };
        }

        const data = await response.json();
        return handleAuthResponse(data);
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      } finally {
        setAuthBusy(false);
      }
    },
    [handleAuthResponse]
  );

  const register = useCallback(
    async ({ email, password, displayName }) => {
      setAuthBusy(true);
      try {
        const response = await fetch(`${API_URL}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, displayName }),
        });

        if (!response.ok) {
          const message = await extractErrorMessage(response);
          return { ok: false, message };
        }

        const data = await response.json();
        return handleAuthResponse(data);
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      } finally {
        setAuthBusy(false);
      }
    },
    [handleAuthResponse]
  );

  const logout = useCallback(() => {
    setAuthState({ user: null, token: null });
  }, []);

  const value = useMemo(
    () => ({
      user: authState.user,
      token: authState.token,
      authBusy,
      initializing,
      login,
      register,
      logout,
    }),
    [authState.token, authState.user, authBusy, initializing, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
