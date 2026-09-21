/**
 * Fault injection — real server restarts against the isolated e2e compose
 * project. These tests restart containers, which would disturb any test
 * running in parallel, so they are gated behind E2E_FAULT_INJECTION=1 and
 * run as their own single-worker phase (`just e2e-faults`).
 *
 * These pin the crash-safety design (D-005): key shares persist server-side
 * across restarts, offline members adopt fresh keys via pull, and stateless
 * auth (JWKS with stable keys) survives an accounts restart.
 */

import { execSync } from "node:child_process";
import type { Page } from "@playwright/test";
import { test, expect, bridge, setupSharedSpace, COMPOSE_CMD, PROJECT_ROOT } from "./fixtures";

const enabled = process.env.E2E_FAULT_INJECTION === "1";

function restartService(service: string): void {
  execSync(`${COMPOSE_CMD} restart ${service}`, {
    cwd: PROJECT_ROOT,
    timeout: 90_000,
    stdio: "pipe",
  });
}

async function waitHealthy(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastError = "never attempted";
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `status ${response.status}`;
    } catch (err) {
      lastError = String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} not healthy within ${timeoutMs}ms (last: ${lastError})`);
}

/** Drive sync cycles until the page's item titles match `expected` exactly. */
async function convergeTitles(
  page: Page,
  expected: string[],
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    await bridge(page, (api) => api.sync()).catch(() => undefined);
    const items = await bridge(page, (api) => api.query("items"));
    last = items.map((r: Record<string, unknown>) => String(r.title)).sort();
    if (
      last.length === expected.length &&
      expected.slice().sort().every((t, i) => last[i] === t)
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`did not converge to ${JSON.stringify(expected)} (last: ${JSON.stringify(last)})`);
}

/** Drive sync cycles until the space epoch reaches `expected`. */
async function convergeEpoch(page: Page, spaceId: string, expected: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: number | null = null;
  while (Date.now() < deadline) {
    const epoch = await bridge(page, (api, a) => api.getSpaceEpoch(a.spaceId), { spaceId });
    last = epoch;
    if (epoch === expected) return;
    await bridge(page, (api) => api.sync()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`epoch did not converge to ${expected} (last: ${last})`);
}

test.describe("Fault injection — server restarts", () => {
  test.skip(!enabled, "gated: run via `just e2e-faults` (restarts disturb parallel tests)");

  test("sync service restart preserves all data and sessions recover", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Pre Restart Alice", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Pre Restart Bob", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    restartService("sync");
    await waitHealthy("http://localhost:25379/health");

    // Both sessions reconnect and see all pre-restart data (re-subscription
    // after a restart can take more than one cycle).
    await convergeTitles(alice.page, ["Pre Restart Alice", "Pre Restart Bob"]);
    await convergeTitles(bob.page, ["Pre Restart Alice", "Pre Restart Bob"]);

    // Post-restart writes flow both directions.
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Post Restart", value: 3, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await convergeTitles(bob.page, ["Post Restart", "Pre Restart Alice", "Pre Restart Bob"]);
  });

  test("member offline during rotation adopts the fresh key across a sync restart (D-005)", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Before Rotation", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    // Bob is truly offline while the admin rotates to a fresh random key
    // and writes post-rotation records.
    await bob.context.setOffline(true);
    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), { spaceId });
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "After Rotation", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // The server restarts between rotation and adoption — the wrapped key
    // shares must survive in storage (D-005: pull-based adoption).
    restartService("sync");
    await waitHealthy("http://localhost:25379/health");

    await bob.context.setOffline(false);
    // Bob adopted the fresh key and reads BOTH pre- and post-rotation data
    // (adoption can take several pull cycles: epoch detection → share
    // fetch → local update → decrypt).
    await convergeTitles(bob.page, ["After Rotation", "Before Rotation"], 60_000);

    // Epochs agree after adoption.
    const aliceEpoch = await bridge(alice.page, (api, a) => api.getSpaceEpoch(a.spaceId), {
      spaceId,
    });
    expect(aliceEpoch).not.toBeNull();
    await convergeEpoch(bob.page, spaceId, aliceEpoch!);

    // And a post-adoption rotation still works (server state consistent).
    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), { spaceId });
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "After Adoption Rotation", value: 3, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await convergeTitles(
      bob.page,
      ["After Adoption Rotation", "After Rotation", "Before Rotation"],
      60_000,
    );
  });

  test("accounts service restart: existing sessions keep syncing (stateless validation)", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Pre Accounts Restart", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    restartService("accounts");
    await waitHealthy("http://localhost:25377/health");

    // Existing tokens stay valid: sync validates them against JWKS whose
    // signing keys are stable across restarts.
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Post Accounts Restart", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await convergeTitles(bob.page, ["Post Accounts Restart", "Pre Accounts Restart"]);
  });
});
