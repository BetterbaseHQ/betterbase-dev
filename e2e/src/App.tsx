import { useState, useCallback, useMemo, useEffect, type ReactNode } from "react";
import { OAuthClient } from "@betterbase/sdk/auth";
import { useAuth as useAuthBase } from "@betterbase/sdk/auth/react";
import { createOpfsDb, type OpfsDb } from "@betterbase/sdk/db";
import { LessProvider, useSyncReady } from "@betterbase/sdk/sync/react";
import { spaces } from "@betterbase/sdk/sync";
import { items, notes } from "./collections";
import { TestBridge } from "./bridge";

// ---------------------------------------------------------------------------
// Config from env + URL params
// ---------------------------------------------------------------------------

const DEFAULT_CLIENT_ID = import.meta.env.VITE_OAUTH_CLIENT_ID || "";
const DEFAULT_DOMAIN = import.meta.env.VITE_DOMAIN || "localhost:25377";

interface AppConfig {
  dbName: string;
  clientId: string;
  domain: string;
}

function getConfig(): AppConfig {
  const params = new URLSearchParams(window.location.search);

  // URL params override env defaults (for federation tests targeting Server B)
  const urlDb = params.get("db");
  const urlClientId = params.get("clientId");
  const urlDomain = params.get("domain");

  // Persist across OAuth redirects (which strip query params)
  if (urlDb) sessionStorage.setItem("less-e2e-db", urlDb);
  if (urlClientId) sessionStorage.setItem("less-e2e-clientId", urlClientId);
  if (urlDomain) sessionStorage.setItem("less-e2e-domain", urlDomain);

  return {
    dbName: urlDb || sessionStorage.getItem("less-e2e-db") || "less-e2e",
    clientId: urlClientId || sessionStorage.getItem("less-e2e-clientId") || DEFAULT_CLIENT_ID,
    domain: urlDomain || sessionStorage.getItem("less-e2e-domain") || DEFAULT_DOMAIN,
  };
}

// ---------------------------------------------------------------------------
// Auth layer (mirrors examples/tasks pattern)
// ---------------------------------------------------------------------------

interface AuthContextValue {
  session: import("@betterbase/sdk/auth").AuthSession | null;
  getToken: () => Promise<string | null>;
  encryptionKey: Uint8Array | null;
  epochKey: Uint8Array | null;
  personalSpaceId: string | null;
  keypair: { privateKeyJwk: JsonWebKey; publicKeyJwk: JsonWebKey } | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => void;
}

function AuthLayer({
  config,
  children,
}: {
  config: AppConfig;
  children: (auth: AuthContextValue) => ReactNode;
}) {
  const client = useMemo(
    () =>
      config.clientId
        ? new OAuthClient({
            clientId: config.clientId,
            redirectUri: window.location.origin + "/",
            domain: config.domain,
            scope: "openid email sync files",
          })
        : null,
    [config.clientId, config.domain],
  );

  const {
    session,
    isAuthenticated,
    isLoading,
    error: sessionError,
    logout: sessionLogout,
    getToken,
    encryptionKey,
    epochKey,
    personalSpaceId,
    keypair,
  } = useAuthBase(client);

  const [loginError, setLoginError] = useState<string | null>(null);

  const login = useCallback(async () => {
    if (!client) {
      setLoginError("No client ID configured");
      return;
    }
    setLoginError(null);
    try {
      await client.startAuth();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Login failed");
    }
  }, [client]);

  const logout = useCallback(() => {
    sessionLogout();
    setLoginError(null);
  }, [sessionLogout]);

  return (
    <>
      {children({
        session,
        getToken,
        encryptionKey,
        epochKey,
        personalSpaceId,
        keypair,
        isAuthenticated,
        isLoading,
        error: loginError ?? sessionError,
        login,
        logout,
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// SyncGate — waits for sync infrastructure before mounting TestBridge
// ---------------------------------------------------------------------------

function SyncGate({ auth }: { auth: AuthContextValue }) {
  const ready = useSyncReady();
  if (!ready) return <div id="status">initializing-sync</div>;
  return <TestBridge auth={auth} />;
}

// ---------------------------------------------------------------------------
// SyncLayer — wraps LessProvider once auth is ready
// ---------------------------------------------------------------------------

function SyncLayer({
  auth,
  config,
  db,
}: {
  auth: AuthContextValue;
  config: AppConfig;
  db: OpfsDb;
}) {
  const { session, logout } = auth;

  if (!session) {
    return <div id="status">waiting-for-auth-data</div>;
  }

  return (
    <LessProvider
      adapter={db}
      collections={[items, notes]}
      editChainCollections={["items"]}
      session={session}
      clientId={config.clientId}
      domain={config.domain}
      onAuthError={logout}
    >
      <SyncGate auth={auth} />
    </LessProvider>
  );
}

// ---------------------------------------------------------------------------
// App — root component
// ---------------------------------------------------------------------------

export default function App() {
  const [db, setDb] = useState<OpfsDb | null>(null);
  const [dbError, setDbError] = useState<string | null>(null);
  const [config] = useState<AppConfig>(() => getConfig());

  useEffect(() => {
    let disposed = false;
    let dbInstance: OpfsDb | undefined;

    createOpfsDb(config.dbName, [items, notes, spaces], {
      worker: new Worker(new URL("./db-worker.ts", import.meta.url), { type: "module" }),
    }).then(
      (d) => {
        if (disposed) {
          d.close();
          return;
        }
        dbInstance = d;
        setDb(d);
        // Expose a close function for test cleanup (switchToDevice).
        (window as unknown as Record<string, unknown>).__test_closeDb = () => d.close();
      },
      (err) => {
        if (!disposed) setDbError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      disposed = true;
      delete (window as unknown as Record<string, unknown>).__test_closeDb;
      dbInstance?.close();
    };
  }, [config.dbName]);

  if (dbError) return <div id="status">db-error: {dbError}</div>;
  if (!db) return <div id="status">initializing-db</div>;

  return (
    <AuthLayer config={config}>
      {(auth) => {
        if (auth.isLoading) return <div id="status">loading</div>;
        if (!auth.isAuthenticated) {
          return (
            <div id="status">
              unauthenticated
              {auth.error && <div id="auth-error">{auth.error}</div>}
              <button id="login-btn" onClick={auth.login}>
                Login
              </button>
            </div>
          );
        }
        return <SyncLayer auth={auth} config={config} db={db} />;
      }}
    </AuthLayer>
  );
}
