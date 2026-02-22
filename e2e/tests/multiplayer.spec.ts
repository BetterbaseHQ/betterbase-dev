import { test, expect, bridge, setupSharedSpace, removeMember, switchToDevice } from "./fixtures";

test.describe("Multiplayer — Shared Spaces", () => {
  test("Alice creates shared space and invites Bob", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice creates a shared space
    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    expect(spaceId).toBeTruthy();
    expect(spaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    // Alice syncs the space creation
    await bridge(alice.page, (api) => api.sync());

    // Alice invites Bob
    await bridge(
      alice.page,
      (api, a) => api.invite(a.spaceId, a.handle, { spaceName: "Test Space" }),
      { spaceId, handle: bob.credentials.handle },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob checks for invitations
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());

    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    expect(invitations.length).toBeGreaterThanOrEqual(1);
    expect(invitations[0]!.spaceId).toBe(spaceId);
  });

  test("Bob accepts invitation and sees shared data", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice creates space, adds data, invites Bob
    const spaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());

    // Alice creates a record directly in the shared space
    await bridge(
      alice.page,
      (api, a) =>
        api.put(
          "items",
          { title: "Shared Item", value: 42, tags: ["shared"] },
          { space: a.spaceId },
        ),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Alice invites Bob
    await bridge(alice.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: bob.credentials.handle,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob checks and accepts
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());

    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    expect(invitations.length).toBeGreaterThanOrEqual(1);

    await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
      id: invitations[0]!.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Bob should see Alice's shared data
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    const sharedItem = bobItems.find((r: Record<string, unknown>) => r.title === "Shared Item");
    expect(sharedItem).toBeTruthy();
    expect(sharedItem!.value).toBe(42);
  });

  test("Bob creates record in shared space, Alice sees it", async ({ authenticatedContext }) => {
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

    // Bob creates a record directly in the shared space
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob's Item", value: 99, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(bob.page, (api) => api.sync());

    // Alice syncs and should see Bob's item
    await bridge(alice.page, (api) => api.sync());
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    const bobItem = aliceItems.find((r: Record<string, unknown>) => r.title === "Bob's Item");
    expect(bobItem).toBeTruthy();
    expect(bobItem!.value).toBe(99);
  });

  test("decline invitation prevents space join", async ({ authenticatedContext }) => {
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

    // Bob declines
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());
    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    expect(invitations.length).toBeGreaterThanOrEqual(1);

    await bridge(bob.page, (api, a) => api.declineInvitation(a.id), {
      id: invitations[0]!.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Bob's invitations should be empty now
    const remaining = await bridge(bob.page, (api) => api.getInvitations());
    expect(remaining.length).toBe(0);

    // Bob should not see any active shared spaces for this spaceId
    const activeSpaces = await bridge(bob.page, (api) => api.getActiveSpaces());
    const joined = activeSpaces.find((s: Record<string, unknown>) => s.spaceId === spaceId);
    expect(joined).toBeUndefined();
  });

  test("three members collaborate in a shared space", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const carol = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());
    await bridge(carol.page, (api) => api.waitForSync());

    // Alice creates space and invites Bob and Carol
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

    // Bob accepts
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());
    const bobInvs = await bridge(bob.page, (api) => api.getInvitations());
    await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
      id: bobInvs[0]!.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Carol accepts
    await bridge(carol.page, (api) => api.checkInvitations());
    await bridge(carol.page, (api) => api.sync());
    const carolInvs = await bridge(carol.page, (api) => api.getInvitations());
    await bridge(carol.page, (api, a) => api.acceptInvitation(a.id), {
      id: carolInvs[0]!.id,
    });
    await bridge(carol.page, (api) => api.sync());

    // Verify 3 members
    const members = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), { spaceId });
    expect(members.length).toBe(3);

    // Each user creates a record in the shared space
    await bridge(
      alice.page,
      (api, a) => api.put("items", { title: "Alice's", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    await bridge(
      bob.page,
      (api, a) => api.put("items", { title: "Bob's", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(bob.page, (api) => api.sync());

    await bridge(
      carol.page,
      (api, a) => api.put("items", { title: "Carol's", value: 3, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(carol.page, (api) => api.sync());

    // Sync all and verify everyone sees all 3 records
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());
    await bridge(carol.page, (api) => api.sync());

    for (const user of [alice, bob, carol]) {
      const items = await bridge(user.page, (api) => api.query("items"));
      const titles = items.map((r: Record<string, unknown>) => r.title).sort();
      expect(titles).toContain("Alice's");
      expect(titles).toContain("Bob's");
      expect(titles).toContain("Carol's");
    }
  });

  test("getActiveSpaces shows joined spaces", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Bob starts with no active shared spaces
    const before = await bridge(bob.page, (api) => api.getActiveSpaces());
    const sharedBefore = before.filter((s: Record<string, unknown>) => s.status === "active");

    // Alice creates space, invites Bob, Bob accepts
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

    // Bob now has an active shared space
    const after = await bridge(bob.page, (api) => api.getActiveSpaces());
    const sharedAfter = after.filter((s: Record<string, unknown>) => s.status === "active");
    expect(sharedAfter.length).toBe(sharedBefore.length + 1);

    const joined = sharedAfter.find((s: Record<string, unknown>) => s.spaceId === spaceId);
    expect(joined).toBeTruthy();
  });

  test("getSpaceForRecord returns correct spaceId", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Create a record in personal space
    const personalId = await bridge(alice.page, (api) =>
      api.put("items", { title: "Personal", value: 1, tags: [] }),
    );
    const personalSpaceId = await bridge(alice.page, (api) => api.getAuthState());

    const recordSpace = await bridge(alice.page, (api, a) => api.getSpaceForRecord("items", a.id), {
      id: personalId,
    });
    expect(recordSpace).toBe(personalSpaceId.personalSpaceId);

    // Create a shared space and a record in it
    const sharedSpaceId = await bridge(alice.page, (api) => api.createSpace());
    await bridge(alice.page, (api) => api.sync());

    const sharedRecordId = await bridge(
      alice.page,
      (api, a) => api.put("items", { title: "Shared", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId: sharedSpaceId },
    );

    const sharedRecordSpace = await bridge(
      alice.page,
      (api, a) => api.getSpaceForRecord("items", a.id),
      { id: sharedRecordId },
    );
    expect(sharedRecordSpace).toBe(sharedSpaceId);
  });
});

test.describe("Multiplayer — Member Status", () => {
  test("getMembers shows pending status before acceptance", async ({ authenticatedContext }) => {
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

    const members = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), { spaceId });

    const aliceDID = await bridge(alice.page, (api) => api.getSelfDID());
    const aliceMember = members.find((m: { did: string }) => m.did === aliceDID);
    const bobMember = members.find((m: { did: string }) => m.did !== aliceDID);

    expect(aliceMember!.status).toBe("joined");
    expect(bobMember!.status).toBe("pending");
  });

  test("getMembers shows active status after acceptance", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    const members = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), { spaceId });

    expect(members.length).toBe(2);
    expect(members.every((m: { status: string }) => m.status === "joined")).toBe(true);
  });

  test("decline records declined status visible to admin", async ({ authenticatedContext }) => {
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

    // Bob declines
    await bridge(bob.page, (api) => api.checkInvitations());
    await bridge(bob.page, (api) => api.sync());
    const invitations = await bridge(bob.page, (api) => api.getInvitations());
    await bridge(bob.page, (api, a) => api.declineInvitation(a.id), {
      id: invitations[0]!.id,
    });
    await bridge(bob.page, (api) => api.sync());

    // Alice syncs and checks members
    await bridge(alice.page, (api) => api.sync());
    const members = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), { spaceId });

    const aliceDID = await bridge(alice.page, (api) => api.getSelfDID());
    const bobMember = members.find((m: { did: string }) => m.did !== aliceDID);
    expect(bobMember!.status).toBe("declined");
  });

  test("revocation removes member from getMembers", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    const membersBefore = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersBefore.length).toBe(2);

    await removeMember(alice, spaceId, bobDID);

    // After key rotation, Bob's membership entry (encrypted under old epoch key)
    // is no longer decryptable — getMembers returns only Alice
    const membersAfter = await bridge(alice.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersAfter.length).toBe(1);
    expect(membersAfter[0]!.did).not.toBe(bobDID);
  });
});

test.describe("Multiplayer — Data Isolation & CRDT", () => {
  test("personal space data is invisible to other users", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice puts item in personal space
    await bridge(alice.page, (api) =>
      api.put("items", { title: "Alice Secret", value: 1, tags: [] }),
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob puts item in personal space
    await bridge(bob.page, (api) => api.put("items", { title: "Bob Secret", value: 2, tags: [] }));
    await bridge(bob.page, (api) => api.sync());

    // Alice only sees her own
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Alice Secret")).toBe(true);
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Bob Secret")).toBe(false);

    // Bob only sees his own
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Bob Secret")).toBe(true);
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Alice Secret")).toBe(false);
  });

  test("concurrent edits in shared space merge via CRDT", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();

    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice creates a record in the shared space
    const recordId = await bridge(
      alice.page,
      (api, a) => api.put("items", { title: "Original", value: 0, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    // Alice patches title (no sync yet)
    await bridge(alice.page, (api, a) => api.patch("items", { id: a.id, title: "Alice Edit" }), {
      id: recordId,
    });

    // Bob patches value (no sync yet)
    await bridge(bob.page, (api, a) => api.patch("items", { id: a.id, value: 999 }), {
      id: recordId,
    });

    // Pull-first sync: A pushes, B pulls A's + pushes B's, A pulls B's → 3 syncs
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());
    await bridge(alice.page, (api) => api.sync());

    // Both should see merged result (CRDT per-field merge)
    const aliceRecord = await bridge(alice.page, (api, a) => api.get("items", a.id), {
      id: recordId,
    });
    expect(aliceRecord!.title).toBe("Alice Edit");
    expect(aliceRecord!.value).toBe(999);

    const bobRecord = await bridge(bob.page, (api, a) => api.get("items", a.id), { id: recordId });
    expect(bobRecord!.title).toBe("Alice Edit");
    expect(bobRecord!.value).toBe(999);
  });
});

test.describe("Multiplayer — Reload Convergence", () => {
  test("shared space data visible after page reload", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice creates data in shared space and syncs
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Shared Data", value: 42, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob pulls the shared data
    await bridge(bob.page, (api) => api.sync());
    let bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.length).toBe(1);

    // Bob reloads the page (simulates app restart — same IndexedDB)
    await switchToDevice(bob.page, bob.dbName);

    // Bob syncs after reload — persistent cursors should prevent re-pulling
    // stale data, and shared space data should still be accessible
    await bridge(bob.page, (api) => api.sync());

    bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.length).toBe(1);
    expect(bobItems[0]!.title).toBe("Shared Data");
  });
});

test.describe("Multiplayer — moveToSpace", () => {
  test("moveToSpace moves record from personal to shared space", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    // Alice creates a personal record
    const personalId = await bridge(alice.page, (api) =>
      api.put("items", { title: "Move Me", value: 1, tags: [] }),
    );
    await bridge(alice.page, (api) => api.sync());

    // Create shared space
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Move record to shared space
    const newId = await bridge(
      alice.page,
      (api, a) => api.moveToSpace("items", a.recordId, a.spaceId),
      { recordId: personalId, spaceId },
    );
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(personalId);

    await bridge(alice.page, (api) => api.sync());

    // New record is in shared space with preserved fields
    const newSpace = await bridge(alice.page, (api, a) => api.getSpaceForRecord("items", a.id), {
      id: newId,
    });
    expect(newSpace).toBe(spaceId);

    const newRecord = await bridge(alice.page, (api, a) => api.get("items", a.id), { id: newId });
    expect(newRecord!.title).toBe("Move Me");
    expect(newRecord!.value).toBe(1);

    // Old record is gone
    const oldRecord = await bridge(alice.page, (api, a) => api.get("items", a.id), {
      id: personalId,
    });
    expect(oldRecord).toBeNull();
  });

  test("bulkMoveToSpace moves multiple records", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());

    // Alice creates 3 personal records
    const id1 = await bridge(alice.page, (api) =>
      api.put("items", { title: "Bulk 1", value: 1, tags: [] }),
    );
    const id2 = await bridge(alice.page, (api) =>
      api.put("items", { title: "Bulk 2", value: 2, tags: [] }),
    );
    const id3 = await bridge(alice.page, (api) =>
      api.put("items", { title: "Bulk 3", value: 3, tags: [] }),
    );
    await bridge(alice.page, (api) => api.sync());

    // Create shared space
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Bulk move
    const newIds = await bridge(
      alice.page,
      (api, a) => api.bulkMoveToSpace("items", a.ids, a.spaceId),
      { ids: [id1, id2, id3], spaceId },
    );
    expect(newIds.length).toBe(3);

    await bridge(alice.page, (api) => api.sync());

    // All 3 are in shared space with preserved fields
    const titles: string[] = [];
    for (const newId of newIds) {
      const space = await bridge(alice.page, (api, a) => api.getSpaceForRecord("items", a.id), {
        id: newId,
      });
      expect(space).toBe(spaceId);

      const record = await bridge(alice.page, (api, a) => api.get("items", a.id), { id: newId });
      titles.push(record!.title as string);
    }
    expect(titles.sort()).toEqual(["Bulk 1", "Bulk 2", "Bulk 3"]);

    // Originals are gone
    for (const oldId of [id1, id2, id3]) {
      const old = await bridge(alice.page, (api, a) => api.get("items", a.id), {
        id: oldId,
      });
      expect(old).toBeNull();
    }
  });
});
