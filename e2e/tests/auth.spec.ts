import { test, expect, bridge } from "./fixtures";

test.describe("Authentication", () => {
  test("full OAuth flow delivers encryption key and keypair", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();

    const state = await bridge(page, (api) => api.getAuthState());
    expect(state.isAuthenticated).toBe(true);
    expect(state.personalSpaceId).toBeTruthy();
    expect(state.hasEncryptionKey).toBe(true);
    expect(state.hasKeypair).toBe(true);

    // personalSpaceId should be a valid UUID
    expect(state.personalSpaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("session persists across page reload", async ({ authenticatedContext }) => {
    const { page, dbName } = await authenticatedContext();

    // Get initial state
    const stateBefore = await bridge(page, (api) => api.getAuthState());
    expect(stateBefore.isAuthenticated).toBe(true);

    // Reload with same DB name
    await page.goto(`/?db=${encodeURIComponent(dbName)}`);
    await page.waitForSelector("#status");
    await expect(page.locator("#status")).toHaveText("ready", {
      timeout: 30_000,
    });

    // State should be restored
    const stateAfter = await bridge(page, (api) => api.getAuthState());
    expect(stateAfter.isAuthenticated).toBe(true);
    expect(stateAfter.personalSpaceId).toBe(stateBefore.personalSpaceId);
    expect(stateAfter.hasEncryptionKey).toBe(true);
    expect(stateAfter.hasKeypair).toBe(true);
  });

  test("two different users get different personal spaces", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();

    const aliceState = await bridge(alice.page, (api) => api.getAuthState());
    const bobState = await bridge(bob.page, (api) => api.getAuthState());

    expect(aliceState.personalSpaceId).toBeTruthy();
    expect(bobState.personalSpaceId).toBeTruthy();
    expect(aliceState.personalSpaceId).not.toBe(bobState.personalSpaceId);
  });
});
