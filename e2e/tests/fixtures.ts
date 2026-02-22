import {
  test as base,
  expect,
  type Page,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { TestAPI } from "../src/bridge";

// Load e2e/.env into process.env (Vite loads it for the browser, but Playwright tests need it too)
try {
  const envPath = new URL("../.env", import.meta.url).pathname;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1).replace(/^(['"])(.*)\1$/, "$2");
      if (!process.env[key]) process.env[key] = value;
    }
  }
} catch {
  /* .env may not exist in all environments */
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserCredentials {
  username: string;
  handle: string;
  email: string;
  password: string;
}

interface AuthenticatedContext {
  context: BrowserContext;
  page: Page;
  credentials: UserCredentials;
  dbName: string;
}

interface PrewarmedAuthContext {
  context: BrowserContext;
  page: Page;
  credentials: UserCredentials;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let userCounter = 0;

/** identityDomain must match the accounts server's configured identity domain.
 *  In production, handles come from the server's token response — this is test-only. */
function generateUser(identityDomain = "localhost:25377"): UserCredentials {
  // username must satisfy the accounts constraint: ^[a-z0-9_]{3,32}$.
  const ts = Date.now().toString(36).slice(-8);
  const pid = process.pid.toString(36).slice(-4);
  const seq = (++userCounter).toString(36).slice(-3);
  const rnd = randomUUID().replace(/-/g, "").slice(0, 6);
  const id = `e2e_${ts}_${pid}_${seq}_${rnd}`;
  return {
    username: id,
    handle: `${id}@${identityDomain}`,
    email: `${id}@test.local`,
    password: "TestPassword123!",
  };
}

const ACCOUNTS_URL = "http://localhost:25377";
const ACCOUNTS_URL_B = "http://localhost:25387";
const CLIENT_ID_B = process.env.VITE_OAUTH_CLIENT_ID_B || "";
const DOMAIN_B = process.env.VITE_DOMAIN_B || "localhost:25387";
const COMPOSE_CMD = "docker compose -f docker-compose.yml -f docker-compose.e2e.yml";
const PROJECT_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Poll Docker container logs for a verification code sent to the given email.
 * The accounts service in SMTP_DEV_MODE logs codes to stdout.
 */
async function pollVerificationCode(
  email: string,
  containerName = "accounts",
  timeoutMs = 20_000,
): Promise<string> {
  const start = Date.now();
  const since = new Date(start - 1_000).toISOString();
  const pattern = new RegExp(
    `To: ${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?Your verification code is: (\\d{6})`,
  );
  while (Date.now() - start < timeoutMs) {
    try {
      const logs = execSync(`${COMPOSE_CMD} logs --no-color --since "${since}" ${containerName}`, {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 5_000,
      });
      const match = logs.match(pattern);
      if (match) return match[1]!;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Verification code not found in logs for ${email} within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Registration — navigates accounts web UI directly
// ---------------------------------------------------------------------------

async function registerUser(
  page: Page,
  creds: UserCredentials,
  opts?: { accountsUrl?: string; containerName?: string },
): Promise<void> {
  const accountsUrl = opts?.accountsUrl ?? ACCOUNTS_URL;
  const containerName = opts?.containerName ?? "accounts";

  // Step 1: Go to signup page
  await page.goto(`${accountsUrl}/signup`);
  await page.waitForSelector("#username");

  // Step 1a: Fill username and email
  await page.fill("#username", creds.username);
  await page.fill("#email", creds.email);
  await page.click('button:has-text("Continue")');

  // Step 2: Verification code — extract from Docker container logs (SMTP_DEV_MODE logs codes to stdout)
  const firstDigit = page.locator('input[aria-label="Digit 1 of 6"]');
  await firstDigit.waitFor({ timeout: 10_000 });

  // Poll container logs for the verification code sent to this email
  const code = await pollVerificationCode(creds.email, containerName);
  await firstDigit.focus();
  for (const d of code) {
    await page.keyboard.type(d);
  }

  // Step 3: Password form
  await page.waitForSelector("#password", { timeout: 30_000 });
  await page.fill("#password", creds.password);
  await page.fill("#confirmPassword", creds.password);
  await page.click('button:has-text("Create account")');

  // Step 4: Recovery setup — check acknowledgment and click Continue
  await page.waitForURL("**/recovery-setup**", { timeout: 15_000 });
  const checkbox = page.locator('input[type="checkbox"]');
  await checkbox.waitFor({ timeout: 10_000 });
  await checkbox.check();
  await page.click('button:has-text("Continue")');

  // Wait for navigation away from recovery-setup (to consent or home)
  await page.waitForFunction(
    () => !window.location.pathname.includes("recovery-setup"),
    undefined,
    { timeout: 10_000 },
  );
}

// ---------------------------------------------------------------------------
// OAuth login — initiates from the test harness, completes through accounts UI
// ---------------------------------------------------------------------------

async function loginUser(
  page: Page,
  creds: UserCredentials,
  dbName: string,
  opts?: { clientId?: string; domain?: string },
): Promise<void> {
  // Navigate to test harness with unique DB name (and optional Server B overrides)
  const params = new URLSearchParams({ db: dbName });
  if (opts?.clientId) params.set("clientId", opts.clientId);
  if (opts?.domain) params.set("domain", opts.domain);
  await page.goto(`/?${params.toString()}`);

  // Wait for the login button to appear
  await page.waitForSelector("#login-btn", { timeout: 30_000 });
  await page.click("#login-btn");

  // The OAuth flow redirects to accounts (port 25377). The consent page may briefly
  // render then redirect to reauth (if root key isn't in memory). We loop until
  // we successfully reach the stable consent page with an enabled Allow button.
  for (let attempt = 0; attempt < 3; attempt++) {
    // Wait for either the password field (login/reauth) or the Allow button (consent)
    await page.waitForSelector('#password, button:has-text("Allow")', {
      timeout: 30_000,
    });

    // If we're on a login/reauth page, complete it
    const passwordField = page.locator("#password");
    if (await passwordField.isVisible().catch(() => false)) {
      const usernameField = page.locator("#username");
      const isReadonly = (await usernameField.getAttribute("readonly")) !== null;
      if (!isReadonly) {
        await usernameField.fill(creds.username);
      }
      await passwordField.fill(creds.password);
      await page.locator('button[type="submit"]').click();
      // Wait for navigation away from login page
      await page.waitForFunction(() => !window.location.pathname.includes("/login"), undefined, {
        timeout: 30_000,
      });
      continue; // Loop back — consent page may redirect to reauth again
    }

    // We're on the consent page — click Allow
    break;
  }

  await page.locator('button:has-text("Allow")').click();

  // Accounts redirects back to test harness (port 25390) with auth code — wait for bridge ready
  await page.waitForSelector("#status", { timeout: 30_000 });

  await expect(page.locator("#status")).toHaveText("ready", {
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Bridge — evaluate functions in browser context with window.__test
// ---------------------------------------------------------------------------

async function waitForBridge(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(() => window.__test?.ready === true, undefined, {
    timeout: timeoutMs,
  });
}

interface ServerConfig {
  accountsUrl: string;
  containerName: string;
  clientId: string;
  domain: string;
  identityDomain: string;
}

const SERVER_A: ServerConfig = {
  accountsUrl: ACCOUNTS_URL,
  containerName: "accounts",
  clientId: "", // uses default from env
  domain: "", // uses default from env
  identityDomain: "localhost:25377",
};

const SERVER_B: ServerConfig = {
  accountsUrl: ACCOUNTS_URL_B,
  containerName: "accounts-b",
  clientId: CLIENT_ID_B,
  domain: DOMAIN_B,
  identityDomain: DOMAIN_B,
};

async function createPrewarmedAuthContext(
  browser: Browser,
  creds = generateUser(SERVER_A.identityDomain),
  server: ServerConfig = SERVER_A,
): Promise<PrewarmedAuthContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await registerUser(page, creds, {
      accountsUrl: server.accountsUrl,
      containerName: server.containerName,
    });
    const dbName = `e2e_${creds.username}_${Date.now()}`;
    const loginOpts = server.clientId
      ? { clientId: server.clientId, domain: server.domain }
      : undefined;
    await loginUser(page, creds, dbName, loginOpts);
    await waitForBridge(page);
    return { context, page, credentials: creds };
  } catch (err) {
    await context.close();
    throw err;
  }
}

/**
 * Execute a function in the browser context with `window.__test` as the argument.
 *
 * IMPORTANT: The function is serialized as a string, so it must NOT capture
 * variables from the Node.js scope. For calls that need Node-side values,
 * pass them via the `args` parameter.
 *
 * Usage:
 *   // No args:
 *   await bridge(page, (api) => api.waitForSync());
 *
 *   // With args (values are serialized to the browser):
 *   await bridge(page, (api, a) => api.del("items", a.id), { id });
 *   await bridge(page, (api, a) => api.invite(a.spaceId, a.handle), { spaceId, handle });
 */
async function bridge<T>(page: Page, fn: (api: TestAPI) => Promise<T> | T): Promise<T>;
async function bridge<T, A>(
  page: Page,
  fn: (api: TestAPI, args: A) => Promise<T> | T,
  args: A,
): Promise<T>;
async function bridge<T, A>(
  page: Page,
  fn: ((api: TestAPI) => Promise<T> | T) | ((api: TestAPI, args: A) => Promise<T> | T),
  args?: A,
): Promise<T> {
  const fnStr = fn.toString();
  if (args !== undefined) {
    // Pass args to the browser — reconstructed via new Function to bind correctly
    const result = await page.evaluate(
      ([s, a]) => {
        // eslint-disable-next-line no-new-func
        const f = new Function("return " + s)();
        return f((window as unknown as { __test: TestAPI }).__test, a);
      },
      [fnStr, args] as [string, A],
    );
    return result as T;
  }
  // No args — evaluate directly
  const result = await page.evaluate(`(${fnStr})(window.__test)`);
  return result as T;
}

// ---------------------------------------------------------------------------
// Playwright test fixtures
// ---------------------------------------------------------------------------

interface E2EFixtures {
  /** Register a new user and log them into a fresh browser context.
   *  Pass `server: "b"` to target Server B (federation peer). */
  authenticatedContext: (opts?: {
    credentials?: UserCredentials;
    server?: "a" | "b";
  }) => Promise<AuthenticatedContext>;
}

export const test = base.extend<E2EFixtures>({
  authenticatedContext: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const prewarmedPool: Array<Promise<PrewarmedAuthContext>> = [];
    const prewarmTarget = Math.max(
      0,
      Number.parseInt(process.env.E2E_AUTH_PREWARM ?? "1", 10) || 1,
    );

    // Only prewarm Server A contexts (the common case)
    const refillPrewarmedPool = () => {
      while (prewarmedPool.length < prewarmTarget) {
        const p = createPrewarmedAuthContext(
          browser,
          generateUser(SERVER_A.identityDomain),
          SERVER_A,
        );
        p.catch(() => {});
        prewarmedPool.push(p);
      }
    };

    refillPrewarmedPool();

    const factory = async (opts?: { credentials?: UserCredentials; server?: "a" | "b" }) => {
      const server = opts?.server === "b" ? SERVER_B : SERVER_A;

      let prewarmed: PrewarmedAuthContext;
      if (opts?.credentials || server !== SERVER_A) {
        // Custom credentials or Server B — create inline (no prewarming)
        prewarmed = await createPrewarmedAuthContext(
          browser,
          opts?.credentials ?? generateUser(server.identityDomain),
          server,
        );
      } else {
        // Server A with generated credentials — use prewarmed pool
        refillPrewarmedPool();
        const next = prewarmedPool.shift();
        refillPrewarmedPool();
        try {
          prewarmed = next
            ? await next
            : await createPrewarmedAuthContext(
                browser,
                generateUser(SERVER_A.identityDomain),
                SERVER_A,
              );
        } catch {
          prewarmed = await createPrewarmedAuthContext(
            browser,
            generateUser(SERVER_A.identityDomain),
            SERVER_A,
          );
        }
      }

      const { context, page, credentials } = prewarmed;
      const dbName = `e2e_${credentials.username}_${Date.now()}`;

      // Rebind to a unique DB for this context.
      const params = new URLSearchParams({ db: dbName });
      if (server.clientId) params.set("clientId", server.clientId);
      if (server.domain) params.set("domain", server.domain);
      await page.goto(`/?${params.toString()}`);
      await page.waitForSelector("#status", { timeout: 30_000 });
      await expect(page.locator("#status")).toHaveText("ready", {
        timeout: 30_000,
      });
      await waitForBridge(page);

      contexts.push(context);
      return { context, page, credentials, dbName };
    };

    await use(factory);

    for (const ctx of contexts) {
      await ctx.close();
    }
    const leftovers = await Promise.allSettled(prewarmedPool);
    for (const result of leftovers) {
      if (result.status === "fulfilled") {
        await result.value.context.close().catch(() => {});
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

interface User {
  page: Page;
  credentials: {
    /** Raw account username — for UI form interaction only. Use handle for server identity. */
    username: string;
    handle: string;
  };
}

/**
 * Set up a shared space with Alice (admin) and Bob (member).
 * Both users are synced and Bob has accepted the invitation.
 */
async function setupSharedSpace(
  alice: User,
  bob: User,
): Promise<{ spaceId: string; aliceDID: string; bobDID: string }> {
  await bridge(alice.page, (api) => api.waitForSync());
  await bridge(bob.page, (api) => api.waitForSync());

  const spaceId = await bridge(alice.page, (api) => api.createSpace());
  await bridge(alice.page, (api) => api.sync());
  await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
    spaceId,
    handle: bob.credentials.handle,
  });
  await bridge(alice.page, (api) => api.sync());

  await bridge(bob.page, (api) => api.checkInvitations());
  await bridge(bob.page, (api) => api.sync());
  const invitations = await bridge(bob.page, (api) => api.getInvitations());
  await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
    id: invitations[0]!.id,
  });
  await bridge(bob.page, (api) => api.sync());
  await bridge(alice.page, (api) => api.sync());

  const aliceDID = await bridge(alice.page, (api) => api.getSelfDID());
  if (!aliceDID) throw new Error("setupSharedSpace: Alice DID is null");

  const members = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), { spaceId });
  const bobMember = members.find((m: { did: string }) => m.did !== aliceDID);
  if (!bobMember) throw new Error("setupSharedSpace: Bob not found in member list");

  return { spaceId, bobDID: bobMember.did, aliceDID };
}

/** Remove a member from a shared space. */
async function removeMember(admin: User, spaceId: string, memberDID: string): Promise<void> {
  await bridge(admin.page, (api, a) => api.removeMember(a.spaceId, a.did), {
    spaceId,
    did: memberDID,
  });
  await bridge(admin.page, (api) => api.sync());
}

/**
 * Poll a bridge call from Node side until it returns a truthy value or timeout.
 * Use this instead of page.waitForFunction() when the return value has
 * serialization issues crossing the Playwright JSHandle boundary (e.g. arrays
 * of objects from getInvitations).
 */
async function pollUntil<T>(
  page: Page,
  fn: (api: TestAPI) => Promise<T> | T,
  opts: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const { timeout = 15_000, interval = 500 } = opts;
  const deadline = Date.now() + timeout;
  let last: T;
  while (Date.now() < deadline) {
    last = await bridge(page, fn);
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`pollUntil timed out after ${timeout}ms (last value: ${JSON.stringify(last!)})`);
}

/** Navigate to a different OPFS database (simulates switching devices). */
async function switchToDevice(page: Page, dbName: string): Promise<void> {
  // Properly close the current database before navigating to release OPFS
  // access handles and flush any pending writes. Without this, the worker
  // is terminated abruptly by the pagehide handler, which can abort
  // in-progress OPFS flush() calls and cause data loss.
  try {
    await page.evaluate(() => {
      const closeDb = (window as unknown as Record<string, () => void>).__test_closeDb;
      closeDb?.();
    });
  } catch {
    // close may fail during navigation — non-fatal
  }
  await page.goto(`/?db=${encodeURIComponent(dbName)}`);
  await page.waitForSelector("#status");
  await expect(page.locator("#status")).toHaveText("ready", {
    timeout: 30_000,
  });
  await waitForBridge(page);
}

export {
  expect,
  bridge,
  pollUntil,
  registerUser,
  loginUser,
  waitForBridge,
  generateUser,
  setupSharedSpace,
  removeMember,
  switchToDevice,
};
export type { UserCredentials, AuthenticatedContext };
