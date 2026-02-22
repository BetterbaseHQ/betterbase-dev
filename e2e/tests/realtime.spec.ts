import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Realtime — WebSocket Events", () => {
  test("Alice pushes, Bob pulls via WS notification", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Setup: Alice creates space, invites Bob, Bob accepts
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

    // Alice creates a record directly in the shared space
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Realtime Test", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Wait for Bob's WS to trigger a pull (give some time for the event)
    // Poll until Bob sees the data (WS should trigger automatic sync)
    await bob.page.waitForFunction(
      async () => {
        const records = await window.__test.query("items");
        return records.some((r: Record<string, unknown>) => r.title === "Realtime Test");
      },
      undefined,
      { timeout: 15_000 },
    );

    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    const realtimeItem = bobItems.find((r: Record<string, unknown>) => r.title === "Realtime Test");
    expect(realtimeItem).toBeTruthy();
  });

  test("Alice deletes, Bob sees tombstone via WS without manual sync", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice creates a record in the shared space and syncs
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Will Be Deleted", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob pulls to get the record
    await bridge(bob.page, (api) => api.sync());
    const bobBefore = await bridge(bob.page, (api) => api.query("items"));
    expect(bobBefore.length).toBe(1);

    // Alice deletes the record and syncs — this pushes the tombstone
    await bridge(alice.page, (api, { id }) => api.del("items", id), {
      id: bobBefore[0]!.id as string,
    });
    await bridge(alice.page, (api) => api.sync());

    // Wait for Bob's WS to receive the tombstone and auto-apply it
    await bob.page.waitForFunction(
      async () => {
        const records = await window.__test.query("items");
        return records.length === 0;
      },
      undefined,
      { timeout: 15_000 },
    );

    const bobAfter = await bridge(bob.page, (api) => api.query("items"));
    expect(bobAfter.length).toBe(0);
  });
});
