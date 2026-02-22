import { test, expect, bridge } from "./fixtures";

test.describe("Discovery", () => {
  test("well-known endpoint returns valid server metadata", async ({ page }) => {
    const response = await page.request.get("http://localhost:25377/.well-known/less-platform");
    expect(response.ok()).toBe(true);

    const metadata = await response.json();
    expect(metadata.version).toBe(1);
    expect(metadata.accounts_endpoint).toBeTruthy();
    expect(metadata.sync_endpoint).toBeTruthy();
    expect(metadata.jwks_uri).toBeTruthy();
    expect(metadata.webfinger).toBeTruthy();
    expect(metadata.protocols).toContain("less-rpc-v1");

    // accounts_endpoint should point to a reachable accounts server
    expect(metadata.accounts_endpoint).toMatch(/^https?:\/\//);
    // sync_endpoint should include /api/v1
    expect(metadata.sync_endpoint).toContain("/api/v1");
  });

  test("discovery-based auth flow works end-to-end", async ({ authenticatedContext }) => {
    // authenticatedContext uses domain-based OAuthClient and LessProvider
    // (via the updated e2e harness) — if this works, discovery is functional.
    const { page } = await authenticatedContext();

    const state = await bridge(page, (api) => api.getAuthState());
    expect(state.isAuthenticated).toBe(true);
    expect(state.personalSpaceId).toBeTruthy();
    expect(state.hasEncryptionKey).toBe(true);
    expect(state.hasKeypair).toBe(true);
  });

  test("discovery-based sync works end-to-end", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();

    // Wait for initial sync (proves discovery resolved sync endpoint correctly)
    await bridge(page, (api) => api.waitForSync());
    const syncStatus = await bridge(page, (api) => api.getSyncStatus());
    expect(syncStatus.phase).toBe("ready");

    // Create an item and sync it (proves the resolved sync_endpoint works)
    const id = await bridge(page, (api) =>
      api.put("items", { title: "discovery-test", value: 42, tags: [] }),
    );
    expect(id).toBeTruthy();
    await bridge(page, (api) => api.sync());

    // Verify the item round-trips
    const item = await bridge(page, (api, a) => api.get("items", a.id), {
      id,
    });
    expect(item).toBeTruthy();
    expect(item!.title).toBe("discovery-test");
  });

  test("cache-control header is set on discovery endpoint", async ({ page }) => {
    const response = await page.request.get("http://localhost:25377/.well-known/less-platform");
    expect(response.headers()["cache-control"]).toContain("public, max-age=3600");
  });

  test("CORS headers allow cross-origin discovery", async ({ page }) => {
    const response = await page.request.get("http://localhost:25377/.well-known/less-platform");
    expect(response.headers()["access-control-allow-origin"]).toBe("*");
  });
});
