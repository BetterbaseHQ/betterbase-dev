import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Epoch Rotation — Key Rotation in Shared Spaces", () => {
  test("manual rotation increments epoch and preserves data access", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice writes data before rotation
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Pre-Rotation", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    // Verify Bob sees pre-rotation data
    let bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Pre-Rotation")).toBe(true);

    // Get epoch before rotation
    const epochBefore = await bridge(alice.page, (api, a) => api.getSpaceEpoch(a.spaceId), {
      spaceId,
    });

    // Alice rotates the space key
    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), {
      spaceId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Epoch should have advanced
    const epochAfter = await bridge(alice.page, (api, a) => api.getSpaceEpoch(a.spaceId), {
      spaceId,
    });
    expect(epochAfter).toBeGreaterThan(epochBefore ?? 0);

    // Alice writes data after rotation (encrypted under new epoch key)
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Post-Rotation", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob syncs — should see both pre- and post-rotation data
    await bridge(bob.page, (api) => api.sync());
    bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Pre-Rotation")).toBe(true);
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Post-Rotation")).toBe(true);
  });

  test("multiple rotations maintain data continuity", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Write data at epoch N
    await bridge(
      alice.page,
      (api, a) => api.put("items", { title: "Epoch-N", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Rotate twice: N → N+1 → N+2
    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), {
      spaceId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Write data at epoch N+1
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Epoch-N+1", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), {
      spaceId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Write data at epoch N+2
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Epoch-N+2", value: 3, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob syncs and sees all data across all epochs
    await bridge(bob.page, (api) => api.sync());
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Epoch-N")).toBe(true);
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Epoch-N+1")).toBe(true);
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Epoch-N+2")).toBe(true);
  });

  test("Bob can still write after Alice rotates", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice rotates
    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), {
      spaceId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob syncs to pick up new epoch
    await bridge(bob.page, (api) => api.sync());

    // Bob writes under the new epoch
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob Post-Rotate", value: 42, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(bob.page, (api) => api.sync());

    // Alice sees Bob's data
    await bridge(alice.page, (api) => api.sync());
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Bob Post-Rotate")).toBe(
      true,
    );
  });

  test("three members: rotation preserves access for all", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const carol = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());
    await bridge(carol.page, (api) => api.waitForSync());

    // Alice creates space, invites Bob and Carol
    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());

    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: carol.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob and Carol accept
    for (const user of [bob, carol]) {
      await bridge(user.page, (api) => api.checkInvitations());
      await bridge(user.page, (api) => api.sync());
      const invs = await bridge(user.page, (api) => api.getInvitations());
      await bridge(user.page, (api, a) => api.acceptInvitation(a.id), {
        id: invs[0]!.id,
      });
      await bridge(user.page, (api) => api.sync());
    }

    // Alice writes pre-rotation data
    await bridge(
      alice.page,
      (api, a) => api.put("items", { title: "Before", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Alice rotates
    await bridge(alice.page, (api, a) => api.rotateSpaceKey(a.spaceId), {
      spaceId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Carol writes post-rotation data
    await bridge(carol.page, (api) => api.sync());
    await bridge(
      carol.page,
      (api, a) => api.put("items", { title: "After", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(carol.page, (api) => api.sync());

    // All three sync and see everything
    for (const user of [alice, bob, carol]) {
      await bridge(user.page, (api) => api.sync());
    }

    for (const user of [alice, bob, carol]) {
      const items = await bridge(user.page, (api) => api.query("items"));
      expect(items.some((r: Record<string, unknown>) => r.title === "Before")).toBe(true);
      expect(items.some((r: Record<string, unknown>) => r.title === "After")).toBe(true);
    }
  });
});
