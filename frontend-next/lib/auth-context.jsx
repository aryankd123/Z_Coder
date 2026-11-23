'use client';

/**
 * AuthProvider: the single source of truth for "who is logged in" in the UI.
 *
 * status:
 *   'loading'       - first render; we're asking the server via refresh
 *   'authenticated' - user is set
 *   'anonymous'     - no valid session
 *
 * This replaces v1's pattern (token in sessionStorage plus a HOC that
 * re-fetched the user on every page). The server stays the authority: the
 * UI state only mirrors what the last refresh or login said.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, refreshSession, setAuthLostHandler } from './api';

const AuthContext = createContext(null);

const ANONYMOUS = { status: 'anonymous', user: null };

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', user: null });

  useEffect(() => {
    setAuthLostHandler(() => setState(ANONYMOUS));
    let cancelled = false;
    refreshSession()
      .then((data) => !cancelled && setState({ status: 'authenticated', user: data.user }))
      .catch(() => !cancelled && setState(ANONYMOUS));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (credentials) => {
    const { user } = await authApi.login(credentials);
    setState({ status: 'authenticated', user });
    return user;
  }, []);

  const signup = useCallback(async (input) => {
    const { user } = await authApi.signup(input);
    setState({ status: 'authenticated', user });
    return user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      setState(ANONYMOUS);
    }
  }, []);

  const value = useMemo(() => ({ ...state, login, signup, logout }), [state, login, signup, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** @returns {{ status: 'loading'|'authenticated'|'anonymous', user: object|null, login: Function, signup: Function, logout: Function }} */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>');
  return ctx;
}
