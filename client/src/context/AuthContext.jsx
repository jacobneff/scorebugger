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
  } catch {
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

  const completeAuth = useCallback((data) => {
    if (!data?.token || !data?.user) {
      throw new Error('Malformed authentication response');
    }

    setAuthState({
      token: data.token,
      user: data.user,
    });

    return { ok: true, user: data.user };
  }, []);

  const parseResponse = useCallback(async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }, []);

  const buildError = useCallback(
    async (response) => {
      const payload = await parseResponse(response);
      const message =
        payload?.message ||
        (response.status >= 400 && response.status < 500
          ? 'Unable to authenticate with the provided credentials'
          : 'Authentication failed');
      return { ok: false, message, code: payload?.code, payload };
    },
    [parseResponse]
  );

  const normalizeNetworkError = useCallback((error) => {
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
  }, []);

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
          return buildError(response);
        }

        const data = await response.json();
        return completeAuth(data);
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      } finally {
        setAuthBusy(false);
      }
    },
    [buildError, completeAuth, normalizeNetworkError]
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
          return buildError(response);
        }

        const data = await response.json();
        if (data?.token && data?.user) {
          return completeAuth(data);
        }
        return {
          ok: true,
          message: data?.message || 'Account created. Check your email to verify your account.',
          requiresEmailVerification: Boolean(data?.requiresEmailVerification),
          emailDeliveryConfigured: Boolean(data?.emailDeliveryConfigured),
          email: data?.email,
        };
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      } finally {
        setAuthBusy(false);
      }
    },
    [buildError, completeAuth, normalizeNetworkError]
  );

  const logout = useCallback(() => {
    setAuthState({ user: null, token: null });
  }, []);

  const resendVerification = useCallback(
    async (email) => {
      try {
        const response = await fetch(`${API_URL}/api/auth/resend-verification`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        const payload = await parseResponse(response);

        if (!response.ok) {
          return {
            ok: false,
            message: payload?.message || 'Unable to resend verification email',
            code: payload?.code,
          };
        }

        return {
          ok: true,
          message: payload?.message || 'Verification email sent. Check your inbox.',
        };
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      }
    },
    [normalizeNetworkError, parseResponse]
  );

  const requestPasswordReset = useCallback(
    async (email) => {
      try {
        const response = await fetch(`${API_URL}/api/auth/request-password-reset`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });

        const payload = await parseResponse(response);

        if (!response.ok) {
          return {
            ok: false,
            message: payload?.message || 'Unable to request a password reset right now',
            code: payload?.code,
          };
        }

        return {
          ok: true,
          message:
            payload?.message ||
            'If that account exists, you will receive password reset instructions shortly.',
        };
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      }
    },
    [normalizeNetworkError, parseResponse]
  );

  const resetPassword = useCallback(
    async ({ token: resetToken, password }) => {
      try {
        const response = await fetch(`${API_URL}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: resetToken, password }),
        });

        const payload = await parseResponse(response);

        if (!response.ok) {
          return {
            ok: false,
            message: payload?.message || 'Unable to reset password with that link',
            code: payload?.code,
          };
        }

        const result = completeAuth(payload);
        return {
          ...result,
          message: payload?.message || 'Password updated successfully',
        };
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      }
    },
    [completeAuth, normalizeNetworkError, parseResponse]
  );

  const verifyEmail = useCallback(
    async (tokenParam) => {
      try {
        const url = new URL(`${API_URL}/api/auth/verify-email`);
        url.searchParams.set('token', tokenParam);

        const response = await fetch(url.toString(), {
          method: 'GET',
        });

        const payload = await parseResponse(response);

        if (!response.ok) {
          return {
            ok: false,
            message: payload?.message || 'Unable to verify that email link',
            code: payload?.code,
          };
        }

        const result = completeAuth(payload);
        return {
          ...result,
          message: payload?.message || 'Email verified successfully',
        };
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      }
    },
    [completeAuth, normalizeNetworkError, parseResponse]
  );

  const changePassword = useCallback(
    async ({ currentPassword, newPassword }) => {
      if (!authState?.token) {
        return { ok: false, message: 'You must be signed in to change your password.' };
      }

      try {
        const response = await fetch(`${API_URL}/api/auth/change-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authState.token}`,
          },
          body: JSON.stringify({ currentPassword, newPassword }),
        });

        if (!response.ok) {
          return buildError(response);
        }

        const data = await response.json();
        const result = completeAuth(data);
        return {
          ...result,
          message: data?.message || 'Password updated successfully',
        };
      } catch (error) {
        return { ok: false, message: normalizeNetworkError(error) };
      }
    },
    [authState.token, buildError, completeAuth, normalizeNetworkError]
  );

  const value = useMemo(
    () => ({
      user: authState.user,
      token: authState.token,
      authBusy,
      initializing,
      login,
      register,
      logout,
      completeAuth,
      resendVerification,
      requestPasswordReset,
      resetPassword,
      verifyEmail,
      changePassword,
    }),
    [
      authState.token,
      authState.user,
      authBusy,
      initializing,
      login,
      register,
      logout,
      completeAuth,
      resendVerification,
      requestPasswordReset,
      resetPassword,
      verifyEmail,
      changePassword,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
