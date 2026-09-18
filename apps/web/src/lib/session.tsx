import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { api, ApiError, type User } from './api';

interface SessionValue {
  user: User | null;
  /** True until the first `me` call settles, so the shell can avoid flashing the login form. */
  loading: boolean;
  needsSetup: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  setUp: (email: string, name: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { user: current } = await api.me();
      setUser(current);
      setNeedsSetup(false);
    } catch (error) {
      setUser(null);
      if (error instanceof ApiError && error.status === 401) {
        try {
          const { needsSetup: required } = await api.bootstrapStatus();
          setNeedsSetup(required);
        } catch {
          setNeedsSetup(false);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      loading,
      needsSetup,
      signIn: async (email, password) => {
        const { user: current } = await api.login({ email, password });
        setUser(current);
        setNeedsSetup(false);
      },
      setUp: async (email, name, password) => {
        const { user: current } = await api.register({ email, name, password });
        setUser(current);
        setNeedsSetup(false);
      },
      signOut: async () => {
        try {
          await api.logout();
        } catch {
          // Swallowed on purpose. The person asked to sign out, so the page
          // must honour that whether or not the server was reachable. Letting
          // the failure escape here produced an unhandled rejection, because
          // the button that calls this discards the promise.
        }
        setUser(null);
        await refresh();
      },
      refresh,
    }),
    [user, loading, needsSetup, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
