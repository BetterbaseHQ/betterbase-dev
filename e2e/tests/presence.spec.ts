import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Presence — Peer Awareness", () => {
  test("two peers see each other", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Both set presence in the shared space
    await bridge(alice.page, (api, a) => api.setPresence(a.spaceId, { cursor: "doc-1" }), {
      spaceId,
    });
    await bridge(bob.page, (api, a) => api.setPresence(a.spaceId, { cursor: "doc-2" }), {
      spaceId,
    });

    // Wait until Alice sees Bob as a peer
    await alice.page.waitForFunction((sid) => window.__test.getPeerCount(sid) >= 1, spaceId, {
      timeout: 15_000,
    });

    // Wait until Bob sees Alice as a peer
    await bob.page.waitForFunction((sid) => window.__test.getPeerCount(sid) >= 1, spaceId, {
      timeout: 15_000,
    });

    // Verify peer data — find by payload rather than index to avoid ordering flakiness
    const alicePeers = await bridge(alice.page, (api, a) => api.getPeers(a.spaceId), { spaceId });
    expect(alicePeers.length).toBeGreaterThanOrEqual(1);
    const bobInAlice = alicePeers.find(
      (p: { data: unknown }) => (p.data as { cursor: string }).cursor === "doc-2",
    );
    expect(bobInAlice).toBeDefined();

    const bobPeers = await bridge(bob.page, (api, a) => api.getPeers(a.spaceId), { spaceId });
    expect(bobPeers.length).toBeGreaterThanOrEqual(1);
    const aliceInBob = bobPeers.find(
      (p: { data: unknown }) => (p.data as { cursor: string }).cursor === "doc-1",
    );
    expect(aliceInBob).toBeDefined();
  });

  test("peer count reflects active peers", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Bob sets presence
    await bridge(bob.page, (api, a) => api.setPresence(a.spaceId, { status: "online" }), {
      spaceId,
    });

    // Alice polls until she sees Bob
    await alice.page.waitForFunction((sid) => window.__test.getPeerCount(sid) >= 1, spaceId, {
      timeout: 15_000,
    });

    const count = await bridge(alice.page, (api, a) => api.getPeerCount(a.spaceId), { spaceId });
    expect(count).toBe(1);
  });

  test("clear presence removes peer", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Bob sets then clears presence
    await bridge(bob.page, (api, a) => api.setPresence(a.spaceId, { status: "online" }), {
      spaceId,
    });

    // Wait for Alice to see Bob first
    await alice.page.waitForFunction((sid) => window.__test.getPeerCount(sid) >= 1, spaceId, {
      timeout: 15_000,
    });

    // Bob clears presence
    await bridge(bob.page, (api, a) => api.clearPresence(a.spaceId), { spaceId });

    // Wait for Alice to see 0 peers (server stale timeout removes the peer)
    await alice.page.waitForFunction((sid) => window.__test.getPeerCount(sid) === 0, spaceId, {
      timeout: 60_000,
    });

    const count = await bridge(alice.page, (api, a) => api.getPeerCount(a.spaceId), { spaceId });
    expect(count).toBe(0);
  });
});
