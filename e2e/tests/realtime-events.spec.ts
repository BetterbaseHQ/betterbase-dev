import { test, expect, bridge, pollUntil, setupSharedSpace } from "./fixtures";

test.describe("Realtime Events — WebSocket-Driven Flows", () => {
  test("invitation arrives via WS without manual checkInvitations", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice creates space and invites Bob
    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob does NOT call checkInvitations() — WS should deliver the invitation.
    // Poll from Node side to avoid Playwright waitForFunction serialization issues.
    const invitations = await pollUntil(bob.page, async (api) => {
      const invs = await api.getInvitations();
      return invs.length > 0 ? invs : null;
    });

    expect(invitations!.length).toBeGreaterThanOrEqual(1);
    expect(invitations![0]!.spaceId).toBe(spaceId);
  });

  test("revocation notice arrives via WS", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Bob writes data to confirm membership
    await bridge(
      bob.page,
      (api, a) => api.put("items", { title: "Bob Data", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(bob.page, (api) => api.sync());

    // Verify Bob has the shared space in active spaces
    const spacesBefore = await bridge(bob.page, (api) => api.getActiveSpaces());
    expect(spacesBefore.some((s: Record<string, unknown>) => s.spaceId === spaceId)).toBe(true);

    // Alice removes Bob
    await bridge(alice.page, (api, a) => api.removeMember(a.spaceId, a.did), {
      spaceId,
      did: bobDID,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob does NOT call sync() or checkInvitations() — WS should deliver revocation
    await bob.page.waitForFunction(
      async (sid) => {
        const spaces = await window.__test.getActiveSpaces();
        return !spaces.some((s: Record<string, unknown>) => s.spaceId === sid);
      },
      spaceId,
      { timeout: 15_000 },
    );

    const spacesAfter = await bridge(bob.page, (api) => api.getActiveSpaces());
    expect(spacesAfter.some((s: Record<string, unknown>) => s.spaceId === spaceId)).toBe(false);
  });

  test("full flow — WS invitation → accept → WS data sync", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice creates space, writes data, invites Bob
    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Initial Data", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob receives invitation via WS (no manual checkInvitations)
    const invitations = await pollUntil(bob.page, async (api) => {
      const invs = await api.getInvitations();
      return invs.length > 0 ? invs : null;
    });
    expect(invitations!.length).toBeGreaterThanOrEqual(1);

    // Bob accepts and syncs
    await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
      id: invitations![0]!.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Verify Bob sees the initial data
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Initial Data")).toBe(true);

    // Alice writes more data
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "WS Follow-Up", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob sees new data via WS (no manual sync)
    await bob.page.waitForFunction(
      async () => {
        const records = await window.__test.query("items");
        return records.some((r: Record<string, unknown>) => r.title === "WS Follow-Up");
      },
      undefined,
      { timeout: 15_000 },
    );

    const bobFinal = await bridge(bob.page, (api) => api.query("items"));
    expect(bobFinal.some((r: Record<string, unknown>) => r.title === "WS Follow-Up")).toBe(true);
  });
});
