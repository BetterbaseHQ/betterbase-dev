import { test, expect, bridge } from "./fixtures";

test.describe("Error Paths", () => {
  test("removeMember with non-existent DID throws", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());

    const error = await bridge(
      alice.page,
      async (api, a) => {
        try {
          await api.removeMember(a.spaceId, "did:key:zFakeDIDThatDoesNotExist");
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      { spaceId },
    );

    expect(error).toBeTruthy();
    expect(error).toContain("not found");
  });

  test("cannot accept the same invitation twice", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
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
    const invId = invitations[0]!.id;

    // Accept once — should succeed
    await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
      id: invId,
    });
    await bridge(bob.page, (api) => api.sync());

    // Try to accept the same invitation again — should fail (not found)
    const error = await bridge(
      bob.page,
      async (api, a) => {
        try {
          await api.acceptInvitation(a.id);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      { id: invId },
    );

    expect(error).toBeTruthy();
    expect(error).toContain("not found");
  });

  test("get on non-existent record returns null", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    const result = await bridge(alice.page, (api) =>
      api.get("items", "00000000-0000-0000-0000-000000000000"),
    );
    expect(result).toBeNull();
  });

  test("delete non-existent record does not throw", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    // Should not throw — delete is idempotent
    await bridge(alice.page, (api) => api.del("items", "00000000-0000-0000-0000-000000000000"));
  });

  test("userExists returns true for registered user", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    const exists = await bridge(alice.page, (api, a) => api.userExists(a.handle), {
      handle: bob.credentials.handle,
    });
    expect(exists).toBe(true);
  });

  test("userExists returns false for non-existent user", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    const exists = await bridge(alice.page, (api) => api.userExists("nonexistent_xyz_123"));
    expect(exists).toBe(false);
  });

  test("invite non-existent user throws clear error", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());

    const error = await bridge(
      alice.page,
      async (api, a) => {
        try {
          await api.invite(a.spaceId, "nonexistent_xyz_123");
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      { spaceId },
    );

    expect(error).toBeTruthy();
  });
});
