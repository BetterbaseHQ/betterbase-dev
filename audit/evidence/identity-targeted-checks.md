# Identity audit: targeted checks

Date: 2026-09-20. Accounts baseline `b7cda8872ee09cfad44f4186ff40096ee3c95483`; SDK baseline `e3a9ad167d8d3cf0d8310304716e5c4e75861a47`. Both component working trees were clean at inspection. No product files or real accounts were changed. Source-only findings are distinguished from executed checks in [the report](../reviews/01-identity-keys.md).

## PostgreSQL transaction behavior (executed, reproduced)

Used the coordinator's disposable `betterbase-audit-postgres` container, database `audit`, with session-local temporary synthetic tables only. This verifies the transaction failure mechanism used by accounts refresh-token reuse handling; it is not an HTTP/whole-handler test.

```sql
CREATE TEMP TABLE audit_used_tokens (hash integer PRIMARY KEY);
CREATE TEMP TABLE audit_active_tokens (grant_id integer);
INSERT INTO audit_used_tokens VALUES (1);
INSERT INTO audit_active_tokens VALUES (7);
BEGIN;
INSERT INTO audit_used_tokens VALUES (1);
DELETE FROM audit_active_tokens WHERE grant_id = 7;
COMMIT;
SELECT count(*) AS surviving_active_tokens FROM audit_active_tokens;
```

Observed: duplicate insert raises SQLSTATE `23505`; subsequent delete raises `25P02` (transaction aborted); `COMMIT` results in rollback; surviving active tokens = **1**. The product code follows this ordering without a savepoint or rollback before deletion. Temporary tables disappear when the connection closes.

## AuthSession refresh completing after logout (executed, reproduced)

Executed Node with the checked-in `betterbase/js/src/auth/session.ts` transpiled in memory using the installed TypeScript package. Browser storage, timers, KeyStore, WASM initialization and token endpoint were mocked; the actual AuthSession control flow was used without editing it. No secrets or network calls were involved. The source argument also applies to `dispose()` followed by account switching.

Essential harness:

```js
const fs = require('fs');
const vm = require('vm');
const ts = require('./betterbase/js/node_modules/typescript');
const filename = './betterbase/js/src/auth/session.ts';
const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const memory = new Map();
const keys = { initialize: async () => {}, clearAll: async () => {} };
const exports = {};
const sandbox = {
  exports, console, Date,
  setTimeout: () => 1, clearTimeout: () => {},
  localStorage: {
    getItem: k => memory.get(k) ?? null,
    setItem: (k, v) => memory.set(k, v),
    removeItem: k => memory.delete(k),
  },
  window: { addEventListener: () => {}, removeEventListener: () => {} },
  require(id) {
    if (id.endsWith('wasm-init.js')) return { initWasm: async () => {} };
    if (id.endsWith('key-store.js')) return { KeyStore: { getInstance: () => keys } };
    if (id.endsWith('jwt.js')) return { decodeJwtClaim: () => undefined };
    if (id.endsWith('errors.js')) return {
      SessionExpiredError: class extends Error {},
      TokenRefreshError: class extends Error {},
      OAuthTokenError: class extends Error {},
    };
    return {};
  },
};
vm.runInNewContext(js, sandbox, { filename });
(async () => {
  let finish;
  const client = { refreshToken: () => new Promise(r => finish = r) };
  const session = await exports.AuthSession.create({ client }, {
    accessToken: 'synthetic-old', refreshToken: 'synthetic-refresh', expiresIn: 900,
  });
  const refresh = session.refresh();
  await session.destroy();
  console.log('After logout, session persisted:', memory.has('betterbase_session_state'));
  finish({ access_token: 'synthetic-new', refresh_token: 'synthetic-new-refresh', expires_in: 900 });
  await refresh;
  console.log('After in-flight refresh resolves, session persisted:', memory.has('betterbase_session_state'));
  const restored = await exports.AuthSession.restore({ client });
  console.log('Session restored after logout:', restored !== null);
  console.log('Restored token is late refreshed token:', (await restored.getToken()) === 'synthetic-new');
})();
```

Observed, in order: `false`, `true`, `true`, `true`. The expected result is that the late response cannot recreate a destroyed session. This harness does not establish browser-specific IndexedDB behavior or cross-tab rendering; those remain separate checks.

## Inventory checks (executed)

- Read accounts route handlers, domain storage SQL, migration, JWT/OPAQUE services, browser authentication/key/recovery flows, SDK auth/session/KeyStore, and selected native/Web Crypto primitives.
- `rg` inventory found **no tests under accounts storage** and no route-level registration/recovery/consent tests. Existing Rust tests are helper/primitive tests; web tests cover libraries, not complete page workflows. Coordinator independently ran native accounts tests with PostgreSQL configured and reported 26 unit tests, zero storage tests. Therefore the CI comment about DB tests skipping is misleading: simply setting `DATABASE_URL` does not add transactional assurance.
- `git -C betterbase-accounts status --short` and `git -C betterbase status --short` returned no component changes at review time.

## Not executed

No live account takeover, malicious consent link, password reset, production request, complete recovery browser flow, or whole refresh-handler race was executed. Findings for these paths use complete source arguments and require isolated route/browser regression tests during remediation. Native/browser baseline suites are owned by the coordinator to avoid duplicate builds and contention.
