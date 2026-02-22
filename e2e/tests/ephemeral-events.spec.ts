import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Ephemeral Events — Encrypted Event Delivery", () => {
  test("event is delivered to subscriber", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Bob subscribes to "typing" events
    const key = await bridge(bob.page, (api, a) => api.subscribeToEvent(a.spaceId, "typing"), {
      spaceId,
    });

    // Alice sends a typing event
    await bridge(alice.page, (api, a) => api.sendEvent(a.spaceId, "typing", { field: "title" }), {
      spaceId,
    });

    // Wait for Bob to receive the event
    await bob.page.waitForFunction(
      async (k) => {
        const events = window.__test.getReceivedEvents(k);
        return events.length > 0;
      },
      key,
      { timeout: 15_000 },
    );

    const events = await bridge(bob.page, (api, a) => api.getReceivedEvents(a.key), { key });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.data).toEqual({ field: "title" });
    expect(events[0]!.peer).toBeTruthy();

    // Cleanup
    await bridge(bob.page, (api, a) => api.unsubscribeEvent(a.key), { key });
  });

  test("events are isolated to their space", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId: space1 } = await setupSharedSpace(alice, bob);

    // Create a second shared space
    const space2 = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId: space2,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());
    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    const inv = invitations.find((i: { spaceId: string }) => i.spaceId === space2);
    if (!inv) throw new Error("Invitation for space2 not found");
    await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
      id: inv.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Bob subscribes to "ping" in both spaces
    const key1 = await bridge(bob.page, (api, a) => api.subscribeToEvent(a.spaceId, "ping"), {
      spaceId: space1,
    });
    const key2 = await bridge(bob.page, (api, a) => api.subscribeToEvent(a.spaceId, "ping"), {
      spaceId: space2,
    });

    // Alice sends event only to space1
    await bridge(alice.page, (api, a) => api.sendEvent(a.spaceId, "ping", { v: 1 }), {
      spaceId: space1,
    });

    // Wait for Bob to receive the event in space1
    await bob.page.waitForFunction(
      async (k) => {
        const events = window.__test.getReceivedEvents(k);
        return events.length > 0;
      },
      key1,
      { timeout: 15_000 },
    );

    // Verify space2 subscription has no events
    const events2 = await bridge(bob.page, (api, a) => api.getReceivedEvents(a.key), { key: key2 });
    expect(events2.length).toBe(0);

    // Cleanup
    await bridge(bob.page, (api, a) => api.unsubscribeEvent(a.key), {
      key: key1,
    });
    await bridge(bob.page, (api, a) => api.unsubscribeEvent(a.key), {
      key: key2,
    });
  });
});
