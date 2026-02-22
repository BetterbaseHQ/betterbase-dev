import { test, expect, bridge, setupSharedSpace, removeMember } from "./fixtures";

test.describe("Revocation — Member Removal", () => {
  test("after removal, Bob is no longer a member", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    const membersBefore = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersBefore.length).toBe(2);

    await removeMember(alice, spaceId, bobDID);

    const membersAfter = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersAfter.length).toBe(1);
  });

  test("after removal, Alice's new data is invisible to Bob (forward secrecy)", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Pre-removal: both can see shared data
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Before Removal", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    const bobItemsBefore = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItemsBefore.some((r: Record<string, unknown>) => r.title === "Before Removal")).toBe(
      true,
    );

    // Remove Bob (triggers key rotation + DEK re-wrap)
    await removeMember(alice, spaceId, bobDID);

    // Post-removal: Alice writes new data under rotated key
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "After Removal", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob syncs — revoked UCAN means pull fails or returns nothing
    try {
      await bridge(bob.page, (api) => api.sync());
    } catch {
      // Expected: sync may throw due to revoked UCAN
    }

    const bobItemsAfter = await bridge(bob.page, (api) => api.query("items"));
    const postRemovalItem = bobItemsAfter.find(
      (r: Record<string, unknown>) => r.title === "After Removal",
    );
    expect(postRemovalItem).toBeUndefined();
  });

  test("Bob's push fails after removal (revoked UCAN)", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    await removeMember(alice, spaceId, bobDID);

    // Bob creates a local record in the shared space
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob Post-Removal", value: 99, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );

    // Bob's sync should fail — UCAN is revoked, server returns 401
    await bridge(bob.page, async (api) => {
      try {
        await api.sync();
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    });

    // Sync may throw or silently fail (multipull skips errored spaces).
    // Either way, the record should NOT appear on Alice's side.
    await bridge(alice.page, (api) => api.sync());
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    const bobItem = aliceItems.find((r: Record<string, unknown>) => r.title === "Bob Post-Removal");
    expect(bobItem).toBeUndefined();
  });

  test("non-admin cannot remove a member", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, aliceDID } = await setupSharedSpace(alice, bob);

    // Bob (write role) tries to remove Alice — should fail client-side
    const error = await bridge(
      bob.page,
      async (api, a) => {
        try {
          await api.removeMember(a.spaceId, a.did);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      { spaceId, did: aliceDID },
    );

    expect(error).toBeTruthy();
    expect(error).toContain("admin");
  });

  test("Bob's personal space is unaffected by shared space removal", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Bob has personal data
    await bridge(bob.page, (api) =>
      api.put("items", { title: "Bob Personal", value: 42, tags: ["mine"] }),
    );
    await bridge(bob.page, (api) => api.sync());

    // Alice removes Bob from the shared space
    await removeMember(alice, spaceId, bobDID);

    // Bob syncs — shared space pull may fail, but personal space should be fine
    try {
      await bridge(bob.page, (api) => api.sync());
    } catch {
      // Shared space sync error is expected
    }

    // Bob's personal data is still intact
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    const personalItem = bobItems.find((r: Record<string, unknown>) => r.title === "Bob Personal");
    expect(personalItem).toBeTruthy();
    expect(personalItem!.value).toBe(42);
  });
});

test.describe("Revocation — Edge Cases", () => {
  test("removeMember succeeds on space with no files", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Write records only (no files) — removeMember must not throw on getFileDEKs 404
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "No Files Here", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Remove Bob — should succeed without error
    await removeMember(alice, spaceId, bobDID);

    // Verify member count dropped to 1
    const members = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), { spaceId });
    expect(members.length).toBe(1);

    // Alice writes new data under rotated key — must succeed
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Post-Removal Write", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Post-Removal Write")).toBe(
      true,
    );
  });

  test("removeMember re-wraps file DEKs and revokes file access", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Alice creates a record and uploads a file in the shared space
    const recordId = await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "File Record", value: 0, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    const originalData = [10, 20, 30, 40, 50];
    const fileId = crypto.randomUUID();

    await bridge(alice.page, (api, a) => api.uploadFile(a.fileId, a.data, a.recordId, a.spaceId), {
      fileId,
      data: originalData,
      recordId,
      spaceId,
    });

    // Bob syncs and downloads the file (verify access before removal)
    await bridge(bob.page, (api) => api.sync());
    const bobDownload = await bridge(bob.page, (api, a) => api.downloadFile(a.fileId, a.spaceId), {
      fileId,
      spaceId,
    });
    expect(bobDownload).toEqual(originalData);

    // Alice removes Bob (triggers key rotation + file DEK re-wrap)
    await removeMember(alice, spaceId, bobDID);

    // Alice can still download the pre-removal file (DEK re-wrapped under new epoch)
    const aliceDownload = await bridge(
      alice.page,
      (api, a) => api.downloadFile(a.fileId, a.spaceId),
      { fileId, spaceId },
    );
    expect(aliceDownload).toEqual(originalData);

    // Alice uploads a NEW file under the rotated key — must succeed
    const postRemovalData = [99, 88, 77];
    const postRemovalFileId = crypto.randomUUID();
    const recordId2 = await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Post-Removal File", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(alice.page, (api, a) => api.uploadFile(a.fileId, a.data, a.recordId, a.spaceId), {
      fileId: postRemovalFileId,
      data: postRemovalData,
      recordId: recordId2,
      spaceId,
    });

    // Alice can download the new file too
    const aliceNewDownload = await bridge(
      alice.page,
      (api, a) => api.downloadFile(a.fileId, a.spaceId),
      { fileId: postRemovalFileId, spaceId },
    );
    expect(aliceNewDownload).toEqual(postRemovalData);

    // Bob processes the revocation (sync triggers handleRevocation → destroySyncStack)
    try {
      await bridge(bob.page, (api) => api.sync());
    } catch {
      // Expected: sync may throw due to revoked UCAN
    }

    // Evict Bob's cached FileStore so the next download attempt re-checks
    // SyncClient availability (which was destroyed by handleRevocation)
    await bridge(bob.page, (api, a) => api._evictFileStoreCache(a.spaceId), {
      spaceId,
    });

    // Bob cannot download — SyncClient was destroyed by revocation
    const bobError = await bridge(
      bob.page,
      async (api, a) => {
        try {
          await api.downloadFile(a.fileId, a.spaceId);
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      { fileId: postRemovalFileId, spaceId },
    );
    expect(bobError).toBeTruthy();
  });
});

test.describe("Revocation — Re-invitation", () => {
  test("re-invitation after removal works", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Remove Bob (sends revocation notice to Bob's mailbox)
    await removeMember(alice, spaceId, bobDID);

    // Alice re-invites Bob
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob checks invitations — discovers both:
    // 1. Revocation notice → verifies via test pull → marks space "removed"
    // 2. Re-invitation → sees space is "removed" → creates fresh "invited" record
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());
    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    expect(invitations.length).toBeGreaterThanOrEqual(1);
    const reinvite = invitations.find((inv: { spaceId: string }) => inv.spaceId === spaceId);
    expect(reinvite).toBeTruthy();

    // Bob accepts and can see new data
    await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
      id: reinvite!.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Alice writes post-reinvite data
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "After Reinvite", value: 100, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "After Reinvite")).toBe(true);
  });
});

test.describe("Revocation — Multi-Space Isolation", () => {
  test("removal from one space does not affect another shared space", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice creates two shared spaces
    const spaceA = await bridge(alice.page, (api) => api.createSpace());
    const spaceB = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());

    // Invite Bob to both spaces
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId: spaceA,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId: spaceB,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob accepts both invitations
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());
    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    expect(invitations.length).toBeGreaterThanOrEqual(2);

    for (const inv of invitations) {
      await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
        id: (inv as { id: string }).id,
      });
    }
    await bridge(bob.page, (api) => api.sync());

    // Alice puts data in both spaces
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Space A Item", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId: spaceA },
    );
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Space B Item", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId: spaceB },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    // Verify Bob sees both
    let bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Space A Item")).toBe(true);
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Space B Item")).toBe(true);

    // Remove Bob from Space A only
    const aliceDID = await bridge(alice.page, (api) => api.getSelfDID());
    const membersA = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId: spaceA,
    });
    const bobDID = membersA.find((m: { did: string }) => m.did !== aliceDID)!.did;
    await removeMember(alice, spaceA, bobDID);

    // Alice writes new data in both spaces
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Space A New", value: 3, tags: [] }, { space: a.spaceId }),
      { spaceId: spaceA },
    );
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Space B New", value: 4, tags: [] }, { space: a.spaceId }),
      { spaceId: spaceB },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob syncs — Space A may error, Space B should work
    try {
      await bridge(bob.page, (api) => api.sync());
    } catch {
      // Space A sync error expected
    }

    bobItems = await bridge(bob.page, (api) => api.query("items"));

    // Bob should NOT see new Space A data (removed + key rotated)
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Space A New")).toBe(false);

    // Bob SHOULD see new Space B data (still a member)
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Space B New")).toBe(true);
  });

  test("three members: remove one, others continue collaborating", async ({
    authenticatedContext,
  }) => {
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

    // Verify 3 members
    const membersBefore = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersBefore.length).toBe(3);

    // Identify Bob's DID
    const aliceDID = await bridge(alice.page, (api) => api.getSelfDID());
    const carolDID = await bridge(carol.page, (api) => api.getSelfDID());
    const bobDID = membersBefore.find(
      (m: { did: string }) => m.did !== aliceDID && m.did !== carolDID,
    )!.did;

    // Remove Bob
    await removeMember(alice, spaceId, bobDID);

    // Verify 2 members remain (Alice + Carol)
    const membersAfter = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersAfter.length).toBe(2);

    // Carol writes new data (under rotated key)
    await bridge(
      carol.page,
      (api, a) =>
        api.put("items", { title: "Carol Post-Removal", value: 7, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(carol.page, (api) => api.sync());

    // Alice sees Carol's data
    await bridge(alice.page, (api) => api.sync());
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Carol Post-Removal")).toBe(
      true,
    );

    // Bob does NOT see Carol's post-removal data
    try {
      await bridge(bob.page, (api) => api.sync());
    } catch {
      // Expected
    }
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Carol Post-Removal")).toBe(
      false,
    );
  });
});
