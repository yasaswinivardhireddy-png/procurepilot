import { ResponseCache, createClient, type ProcurePilotClient, type User } from '@procurepilot/sdk';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { defaultBaseUrl } from './api';
import { SDUI_CAPABILITIES } from './sdui/capabilities';
import { deviceStorage } from './storage';

const SESSION_KEY = 'pp-session:v1';

type Stored = { baseUrl: string; token: string | null; user: User | null };

type SessionValue = {
  ready: boolean;
  baseUrl: string;
  user: User | null;
  client: ProcurePilotClient;
  cache: ResponseCache;
  signIn(userId: string): Promise<void>;
  signOut(): Promise<void>;
  setBaseUrl(url: string): Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Stored & { ready: boolean }>({ ready: false, baseUrl: defaultBaseUrl(), token: null, user: null });
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = state.token;

  useEffect(() => {
    deviceStorage
      .getItem(SESSION_KEY)
      .then((raw) => {
        const stored = raw ? (JSON.parse(raw) as Stored) : null;
        setState({ ready: true, baseUrl: stored?.baseUrl || defaultBaseUrl(), token: stored?.token ?? null, user: stored?.user ?? null });
      })
      .catch(() => setState((s) => ({ ...s, ready: true })));
  }, []);

  const persist = useCallback(async (next: Stored) => {
    tokenRef.current = next.token;
    setState({ ...next, ready: true });
    await deviceStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }, []);

  const baseUrlRef = useRef(state.baseUrl);
  baseUrlRef.current = state.baseUrl;
  const expireSession = useRef(() => {});
  expireSession.current = () => void persist({ baseUrl: baseUrlRef.current, token: null, user: null });

  const client = useMemo(
    () =>
      createClient({
        baseUrl: state.baseUrl,
        token: () => tokenRef.current,
        sduiCapabilities: SDUI_CAPABILITIES,
        timeoutMs: 15_000,
        // A 401 means the session expired or was revoked: go back to sign-in.
        onRequest: (info) => {
          if (info.status === 401 && tokenRef.current) expireSession.current();
        },
      }),
    [state.baseUrl],
  );

  // Cached screens are stored per user, so switching accounts never shows someone else's data.
  const cache = useMemo(() => new ResponseCache(deviceStorage, { namespace: `pp-cache:v1:${state.user?.id ?? 'anon'}` }), [state.user?.id]);

  const signIn = useCallback(
    async (userId: string) => {
      const session = await client.demoLogin(userId);
      await persist({ baseUrl: baseUrlRef.current, token: session.token, user: session.user });
    },
    [client, persist],
  );

  const signOut = useCallback(async () => {
    try {
      await client.logout();
    } catch {
      // The local session is cleared either way.
    }
    await persist({ baseUrl: baseUrlRef.current, token: null, user: null });
  }, [client, persist]);

  const setBaseUrl = useCallback(
    async (url: string) => {
      await persist({ baseUrl: url.trim().replace(/\/+$/, '') || defaultBaseUrl(), token: null, user: null });
    },
    [persist],
  );

  const value = useMemo<SessionValue>(
    () => ({ ready: state.ready, baseUrl: state.baseUrl, user: state.user, client, cache, signIn, signOut, setBaseUrl }),
    [state.ready, state.baseUrl, state.user, client, cache, signIn, signOut, setBaseUrl],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
