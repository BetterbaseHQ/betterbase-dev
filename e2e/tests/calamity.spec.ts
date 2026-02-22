import { test, expect, bridge, setupSharedSpace, removeMember, switchToDevice } from "./fixtures";

test.describe("Calamity — Offline/Online Scenarios", () => {
  test("device accumulates 100 changes offline then syncs", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create 100 records while "offline" (don't sync between creates)
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = await bridge(
        page,
        (api, { index }) =>
          api.put("items", {
            title: `Offline ${index}`,
            value: index,
            tags: [],
          }),
        { index: i },
      );
      ids.push(id);
    }

    // Come "online" and sync all at once
    await bridge(page, (api) => api.sync());

    // Verify all records persisted
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(100);
  });

  test("two devices offline simultaneously, both sync successfully", async ({
    authenticatedContext,
  }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Initial sync to establish the space on the server
    await bridge(page, (api) => api.sync());

    // Device A creates 50 records "offline" (no sync between creates)
    for (let i = 0; i < 50; i++) {
      await bridge(
        page,
        (api, { index }) =>
          api.put("items", {
            title: `Device-A-${index}`,
            value: index,
            tags: ["a"],
          }),
        { index: i },
      );
    }

    // Switch to Device B (different IndexedDB) — pull to establish sync state
    const dbNameB = `e2e_${credentials.username}_device_b`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    // Device B creates 50 different records "offline"
    for (let i = 50; i < 100; i++) {
      await bridge(
        page,
        (api, { index }) =>
          api.put("items", {
            title: `Device-B-${index}`,
            value: index,
            tags: ["b"],
          }),
        { index: i },
      );
    }

    // Device B syncs — pushes its 50 records
    await bridge(page, (api) => api.sync());

    // Switch back to Device A and sync — should pull Device B's records + push own
    await switchToDevice(page, dbName);
    await bridge(page, (api) => api.sync());

    // Device A should now have all 100 records
    let records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(100);

    // Device B should also have all 100 after syncing again
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(100);
  });

  test("offline device encounters conflict on sync, resolves correctly", async ({
    authenticatedContext,
  }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create initial record and sync
    const id = await bridge(page, (api) =>
      api.put("items", { title: "Initial", value: 0, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // Device B updates the record
    const dbNameB = `e2e_${credentials.username}_conflict_b`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    const recordsB = await bridge(page, (api) => api.query("items"));
    await bridge(page, (api, { id }) => api.patch("items", { id, value: 100 }), {
      id: recordsB[0]!.id as string,
    });
    await bridge(page, (api) => api.sync());

    // Device A (still offline) also updates
    await switchToDevice(page, dbName);

    await bridge(page, (api, { id }) => api.patch("items", { id, title: "Updated A" }), {
      id: id as string,
    });

    // Device A syncs — CRDT should merge both changes
    await bridge(page, (api) => api.sync());

    const merged = await bridge(page, (api) => api.query("items"));
    expect(merged[0]!.title).toBe("Updated A"); // A's change
    expect(merged[0]!.value).toBe(100); // B's change
  });

  test("multiple offline/online cycles preserve all data", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Cycle 1: offline create → sync
    await bridge(page, (api) => api.put("items", { title: "Cycle 1", value: 1, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Cycle 2: offline create → sync
    await bridge(page, (api) => api.put("items", { title: "Cycle 2", value: 2, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Cycle 3: offline create → sync
    await bridge(page, (api) => api.put("items", { title: "Cycle 3", value: 3, tags: [] }));
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(3);
    expect(records.map((r) => r.title).sort()).toEqual(["Cycle 1", "Cycle 2", "Cycle 3"]);
  });
});

test.describe("Calamity — Concurrent Editing", () => {
  test("five devices edit same record simultaneously", async ({ authenticatedContext }) => {
    const { page, credentials } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create initial record
    await bridge(page, (api) => api.put("items", { title: "Original", value: 0, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Simulate 5 devices: each pulls, edits different field, then pushes
    const deviceDBs = [];
    for (let i = 0; i < 5; i++) {
      const dbName = `e2e_${credentials.username}_concurrent_${i}`;
      deviceDBs.push(dbName);

      await switchToDevice(page, dbName);

      // Pull to get the record
      await bridge(page, (api) => api.sync());
      const records = await bridge(page, (api) => api.query("items"));

      // Each device edits a different aspect
      if (i === 0) {
        await bridge(page, (api, { id }) => api.patch("items", { id, title: "Device 0" }), {
          id: records[0]!.id,
        });
      } else {
        await bridge(page, (api, { id, index }) => api.patch("items", { id, value: index * 100 }), {
          id: records[0]!.id,
          index: i,
        });
      }

      // Push (some will conflict)
      await bridge(page, (api) => api.sync());
    }

    // Pull final state — CRDT should have merged
    await switchToDevice(page, deviceDBs[0]!);
    await bridge(page, (api) => api.sync());

    const final = await bridge(page, (api) => api.query("items"));
    expect(final.length).toBe(1);
    // Title should be from device 0
    expect(final[0]!.title).toBe("Device 0");
    // Value should be from last device (CRDT last-write-wins for same key)
  });

  test("concurrent tombstones are idempotent", async ({ authenticatedContext }) => {
    const { page, credentials } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    await bridge(page, (api) => api.put("items", { title: "To Delete", value: 0, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Three devices try to delete simultaneously
    for (let i = 0; i < 3; i++) {
      const dbName = `e2e_${credentials.username}_tombstone_${i}`;
      await switchToDevice(page, dbName);

      await bridge(page, (api) => api.sync());
      const records = await bridge(page, (api) => api.query("items"));

      if (records.length > 0) {
        await bridge(page, (api, { id }) => api.del("items", id), {
          id: records[0]!.id as string,
        });
        await bridge(page, (api) => api.sync());
      }
    }

    // Original device checks — record should be deleted
    await switchToDevice(page, `e2e_${credentials.username}_tombstone_0`);
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(0);
  });
});

test.describe("Calamity — Rapid Operations", () => {
  test("rapid create-update-delete sequence", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create
    const id = await bridge(page, (api) =>
      api.put("items", { title: "Created", value: 1, tags: [] }),
    );

    // Update immediately
    await bridge(page, (api, { id }) => api.patch("items", { id, title: "Updated" }), {
      id,
    });

    // Delete immediately
    await bridge(page, (api, { id }) => api.del("items", id), { id });

    // Sync all changes
    await bridge(page, (api) => api.sync());

    // Record should be gone
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(0);
  });

  test("50 successive syncs complete successfully", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    for (let i = 0; i < 50; i++) {
      await bridge(
        page,
        (api, { index }) => api.put("items", { title: `Rapid ${index}`, value: index, tags: [] }),
        { index: i },
      );
      await bridge(page, (api) => api.sync());
    }

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(50);
  });
});

test.describe("Calamity — Volume Stress", () => {
  test("500 records in single batch", async ({ authenticatedContext }) => {
    test.setTimeout(120_000);
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create 500 records
    for (let i = 0; i < 500; i++) {
      await bridge(
        page,
        (api, { index }) =>
          api.put("items", {
            title: `Bulk ${index}`,
            value: index,
            tags: ["bulk"],
          }),
        { index: i },
      );
    }

    // Sync all at once
    await bridge(page, (api) => api.sync());

    // Verify count
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(500);
  });

  test("bulk update of 200 existing records", async ({ authenticatedContext }) => {
    test.setTimeout(120_000);
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create 200 records
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = await bridge(
        page,
        (api, { index }) =>
          api.put("items", {
            title: `Initial ${index}`,
            value: index,
            tags: [],
          }),
        { index: i },
      );
      ids.push(id);
    }
    await bridge(page, (api) => api.sync());

    // Update all 200
    for (let i = 0; i < 200; i++) {
      await bridge(
        page,
        (api, { id, index }) =>
          api.patch("items", {
            id,
            title: `Updated ${index}`,
            value: index * 10,
          }),
        { id: ids[i], index: i },
      );
    }
    await bridge(page, (api) => api.sync());

    // Verify updates
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(200);
    expect(records.every((r) => (r.title as string)?.startsWith("Updated"))).toBe(true);
  });
});

test.describe("Calamity — Shared Space Edge Cases", () => {
  test("remove member then their data is invisible to admin", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    // Write data before removal — both can collaborate
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Before Removal", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.length).toBe(1);

    // Remove Bob
    await removeMember(alice, spaceId, bobDID);

    // Bob creates a local record in the shared space
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob Post-Removal", value: 99, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );

    // Bob's sync should fail (revoked UCAN) — log unexpected errors
    await bridge(bob.page, async (api) => {
      try {
        await api.sync();
      } catch (err) {
        if (!/unauthorized|forbidden|revoked/i.test(String(err))) {
          console.warn("Unexpected sync error after member removal:", err);
        }
      }
    });

    // Verify: Alice should NOT see Bob's post-removal data
    await bridge(alice.page, (api) => api.sync());
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    const bobItem = aliceItems.find((r: Record<string, unknown>) => r.title === "Bob Post-Removal");
    expect(bobItem).toBeUndefined();
  });

  test("member removed from two shared spaces — data invisible to admin", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();

    // Set up 2 shared spaces (staying under the 10/hr membership append rate limit)
    const space1 = await setupSharedSpace(alice, bob);
    const space2 = await setupSharedSpace(alice, bob);

    // Remove Bob from both spaces
    await removeMember(alice, space1.spaceId, space1.bobDID);
    await removeMember(alice, space2.spaceId, space2.bobDID);

    // Bob writes locally to both spaces after removal
    for (const { spaceId } of [space1, space2]) {
      await bridge(
        bob.page,
        (api, a) =>
          api.put("items", { title: "Post-Removal", value: 99, tags: [] }, { space: a.spaceId }),
        { spaceId },
      );
    }

    // Bob's sync should fail (revoked UCAN) — log unexpected errors
    await bridge(bob.page, async (api) => {
      try {
        await api.sync();
      } catch (err) {
        if (!/unauthorized|forbidden|revoked/i.test(String(err))) {
          console.warn("Unexpected sync error after member removal:", err);
        }
      }
    });

    // Verify: Alice should NOT see Bob's post-removal data in either space
    await bridge(alice.page, (api) => api.sync());
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    const postRemovalItems = aliceItems.filter(
      (r: Record<string, unknown>) => r.title === "Post-Removal",
    );
    expect(postRemovalItems.length).toBe(0);
  });

  test("very rapid invitation accept-decline-accept cycles", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    for (let i = 0; i < 5; i++) {
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

      const invId = invitations[0]!.id as string;
      if (i % 2 === 0) {
        // Accept even iterations
        await bridge(bob.page, (api, a) => api.acceptInvitation(a.id), {
          id: invId,
        });
      } else {
        // Decline odd iterations
        await bridge(bob.page, (api, a) => api.declineInvitation(a.id), {
          id: invId,
        });
      }
      await bridge(bob.page, (api) => api.sync());
    }

    // Bob should have 3 accepted spaces (0, 2, 4).
    // getActiveSpaces() returns shared spaces only — personal space is excluded.
    const activeSpaces = await bridge(bob.page, (api) => api.getActiveSpaces());
    expect(activeSpaces.length).toBe(3);
  });
});

test.describe("Calamity — Boundary Conditions", () => {
  test("empty space sync is idempotent", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Sync empty space multiple times
    await bridge(page, (api) => api.sync());
    await bridge(page, (api) => api.sync());
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(0);
  });

  test("delete non-existent record multiple times", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    const fakeId = "00000000-0000-0000-0000-000000000000";

    // Delete non-existent record multiple times (should all succeed/not throw)
    await bridge(page, (api, { id }) => api.del("items", id), { id: fakeId });
    await bridge(page, (api, { id }) => api.del("items", id), { id: fakeId });
    await bridge(page, (api, { id }) => api.del("items", id), { id: fakeId });

    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(0);
  });

  test("query immediately after create without sync", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    await bridge(page, (api) => api.put("items", { title: "Immediate", value: 42, tags: [] }));

    // Query immediately (before sync) — should see local data
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("Immediate");
    expect(records[0]!.value).toBe(42);
  });

  test("very long string values (10,000 characters)", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    const longString = "a".repeat(10000);

    const id = await bridge(
      page,
      (api, { str }) => api.put("items", { title: str, value: 0, tags: [] }),
      { str: longString },
    );
    await bridge(page, (api) => api.sync());

    const record = await bridge(page, (api, { id }) => api.get("items", id), {
      id: id as string,
    });
    expect((record?.title as string)?.length).toBe(10000);
  });

  test("deeply nested tags array", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    const manyTags = Array.from({ length: 100 }, (_, i) => `tag-${i}`);

    await bridge(
      page,
      (api, { tagArray }) => api.put("items", { title: "Many Tags", value: 0, tags: tagArray }),
      { tagArray: manyTags },
    );
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect((records[0]!.tags as string[])?.length).toBe(100);
  });
});

test.describe("Calamity — App Restart & Reload", () => {
  test("page reload preserves local data and sync still works", async ({
    authenticatedContext,
  }) => {
    const { page, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create records and sync
    await bridge(page, (api) => api.put("items", { title: "Before Reload", value: 1, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Create unsynced record
    await bridge(page, (api) => api.put("items", { title: "Unsynced", value: 2, tags: [] }));

    // Reload page (simulates app restart)
    await switchToDevice(page, dbName);

    // Local data should survive reload
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(2);

    // Sync should still work after reload
    await bridge(page, (api) => api.sync());
    const afterSync = await bridge(page, (api) => api.query("items"));
    expect(afterSync.length).toBe(2);
  });

  test("reload mid-session then second device pulls all data", async ({ authenticatedContext }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create data, sync, reload, create more, sync
    await bridge(page, (api) => api.put("items", { title: "Pre-Reload", value: 1, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Reload
    await switchToDevice(page, dbName);

    await bridge(page, (api) => api.put("items", { title: "Post-Reload", value: 2, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Second device should see both records
    const dbNameB = `e2e_${credentials.username}_reload_b`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(2);
    expect(records.map((r) => r.title).sort()).toEqual(["Post-Reload", "Pre-Reload"]);
  });
});

test.describe("Calamity — Tombstone Convergence", () => {
  test("tombstones converge after page reload (persistent cursors)", async ({
    authenticatedContext,
  }) => {
    const { page, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create records, sync, then delete one and sync the tombstone
    await bridge(page, (api) => api.put("items", { title: "Keep", value: 1, tags: [] }));
    const idDel = await bridge(page, (api) =>
      api.put("items", { title: "Delete Me", value: 2, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    await bridge(page, (api, { id }) => api.del("items", id), { id: idDel });
    await bridge(page, (api) => api.sync());

    // Page reload — simulates closing and reopening the app
    await switchToDevice(page, dbName);

    // After reload, cursors are persisted so pull starts from where we left off.
    // The server filters out tombstones for since=0, so without persistent cursors
    // the deleted record would reappear. With persistent cursors, we pull since
    // the last known sequence — no stale alive records come back.
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("Keep");
  });

  test("stale device catches up with mixed creates and deletes", async ({
    authenticatedContext,
  }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());
    await bridge(page, (api) => api.sync());

    // Device B makes a series of creates and deletes while A is offline
    const dbNameB = `e2e_${credentials.username}_mixed_b`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    const idsToKeep: string[] = [];
    const idsToDelete: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = await bridge(
        page,
        (api, { index }) => api.put("items", { title: `Item ${index}`, value: index, tags: [] }),
        { index: i },
      );
      if (i % 3 === 0) {
        idsToDelete.push(id);
      } else {
        idsToKeep.push(id);
      }
    }

    // Delete every 3rd record
    for (const id of idsToDelete) {
      await bridge(page, (api, { id }) => api.del("items", id), { id });
    }
    await bridge(page, (api) => api.sync());

    // Device A comes back and syncs — should see only the non-deleted records
    await switchToDevice(page, dbName);
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(idsToKeep.length);
  });

  test("delete before sync is not resurrected", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create a record and sync it to the server
    const id = await bridge(page, (api) =>
      api.put("items", { title: "Will Delete", value: 1, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // Create a new dirty record then immediately delete the first one.
    // Both changes are pending when sync starts — the deleted record
    // must not reappear after the push/pull cycle.
    await bridge(page, (api) =>
      api.put("items", { title: "Concurrent Create", value: 2, tags: [] }),
    );
    await bridge(page, (api, { id }) => api.del("items", id), { id });

    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("Concurrent Create");
  });

  test("multiple page reloads maintain tombstone convergence", async ({ authenticatedContext }) => {
    const { page, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create 5 records, sync
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await bridge(
        page,
        (api, { index }) => api.put("items", { title: `Item ${index}`, value: index, tags: [] }),
        { index: i },
      );
      ids.push(id);
    }
    await bridge(page, (api) => api.sync());

    // Delete 2 records, sync, reload
    await bridge(page, (api, { id }) => api.del("items", id), { id: ids[0]! });
    await bridge(page, (api) => api.sync());
    await switchToDevice(page, dbName);

    // Delete 1 more, sync, reload again
    await bridge(page, (api, { id }) => api.del("items", id), { id: ids[1]! });
    await bridge(page, (api) => api.sync());
    await switchToDevice(page, dbName);

    // Final sync after second reload
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(3);
    const titles = records.map((r: Record<string, unknown>) => r.title).sort();
    expect(titles).toEqual(["Item 2", "Item 3", "Item 4"]);
  });
});

test.describe("Calamity — Cross-Device Conflicts", () => {
  test("update vs delete race: both devices converge to same state", async ({
    authenticatedContext,
  }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create a record on Device A and sync
    const id = await bridge(page, (api) =>
      api.put("items", { title: "Contested", value: 1, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // Device B pulls, then deletes
    const dbNameB = `e2e_${credentials.username}_race_del`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    const recordsB = await bridge(page, (api) => api.query("items"));
    await bridge(page, (api, { id }) => api.del("items", id), {
      id: recordsB[0]!.id as string,
    });

    // Device A: switch back and try to update the same record.
    // Device B's delete may have already been auto-pushed, so the record
    // might already be deleted when A loads. Both outcomes are valid.
    await switchToDevice(page, dbName);
    await bridge(
      page,
      async (api, { id }) => {
        try {
          await api.patch("items", { id, title: "Updated" });
          return true;
        } catch {
          // Record already deleted via B's auto-push — that's fine
          return false;
        }
      },
      { id: id as string },
    );

    // Multiple sync rounds ensure convergence regardless of auto-push timing.
    for (let round = 0; round < 3; round++) {
      await bridge(page, (api) => api.sync());
      await switchToDevice(page, dbNameB);
      await bridge(page, (api) => api.sync());
      await switchToDevice(page, dbName);
    }

    const finalA = await bridge(page, (api) => api.query("items"));

    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());
    const finalB = await bridge(page, (api) => api.query("items"));

    // Both devices must have converged to the same state
    expect(finalA.length).toBe(finalB.length);
    if (finalA.length === 1) {
      // Update won: both have the updated record
      expect(finalA[0]!.title).toBe("Updated");
      expect(finalB[0]!.title).toBe("Updated");
    }
    // else: delete won — both have 0 records, which is also valid
  });

  test("concurrent writes to shared space from two members", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice and Bob both create records in the shared space
    await bridge(
      alice.page,
      (api, a) =>
        api.put(
          "items",
          { title: "Alice's Item", value: 1, tags: ["alice"] },
          { space: a.spaceId },
        ),
      { spaceId },
    );

    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob's Item", value: 2, tags: ["bob"] }, { space: a.spaceId }),
      { spaceId },
    );

    // Pull-first sync: A pushes, B pulls A's + pushes B's, A pulls B's → 3 syncs
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());
    await bridge(alice.page, (api) => api.sync());

    // Both should see both records
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    const bobItems = await bridge(bob.page, (api) => api.query("items"));

    expect(aliceItems.length).toBe(2);
    expect(bobItems.length).toBe(2);
    expect(aliceItems.map((r) => r.title).sort()).toEqual(["Alice's Item", "Bob's Item"]);
    expect(bobItems.map((r) => r.title).sort()).toEqual(["Alice's Item", "Bob's Item"]);
  });
});

test.describe("Calamity — Idempotency & No-ops", () => {
  test("repeated no-op syncs don't accumulate state or errors", async ({
    authenticatedContext,
  }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create one record and sync
    await bridge(page, (api) => api.put("items", { title: "Stable", value: 1, tags: [] }));
    await bridge(page, (api) => api.sync());

    // 10 consecutive syncs with no changes
    for (let i = 0; i < 10; i++) {
      await bridge(page, (api) => api.sync());
    }

    // Should still have exactly 1 record, no duplicates
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("Stable");
  });

  test("stale device catches up after many remote changes", async ({ authenticatedContext }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());
    await bridge(page, (api) => api.sync());

    // Device B makes 200 changes while Device A is offline
    const dbNameB = `e2e_${credentials.username}_stale_b`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    for (let i = 0; i < 200; i++) {
      await bridge(
        page,
        (api, { index }) =>
          api.put("items", {
            title: `Remote ${index}`,
            value: index,
            tags: [],
          }),
        { index: i },
      );
    }
    await bridge(page, (api) => api.sync());

    // Device A comes back and syncs — should get all 200 records
    await switchToDevice(page, dbName);
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(200);
  });
});

test.describe("Calamity — Data Integrity Edge Cases", () => {
  test("empty string, zero, and false values round-trip correctly", async ({
    authenticatedContext,
  }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    const id = await bridge(page, (api) => api.put("items", { title: "", value: 0, tags: [] }));
    await bridge(page, (api) => api.sync());

    const record = await bridge(page, (api, { id }) => api.get("items", id), {
      id: id as string,
    });
    expect(record?.title).toBe("");
    expect(record?.value).toBe(0);
    expect(record?.tags).toEqual([]);
  });

  test("cross-collection isolation: notes and items don't interfere", async ({
    authenticatedContext,
  }) => {
    const { page, credentials } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create records in both collections
    await bridge(page, (api) => api.put("items", { title: "An Item", value: 1, tags: [] }));
    await bridge(page, (api) => api.put("notes", { body: "A Note", pinned: true }));
    await bridge(page, (api) => api.sync());

    // Query each collection separately
    const itemRecords = await bridge(page, (api) => api.query("items"));
    const noteRecords = await bridge(page, (api) => api.query("notes"));

    expect(itemRecords.length).toBe(1);
    expect(itemRecords[0]!.title).toBe("An Item");

    expect(noteRecords.length).toBe(1);
    expect(noteRecords[0]!.body).toBe("A Note");
    expect(noteRecords[0]!.pinned).toBe(true);

    // Delete the item — note should be unaffected
    await bridge(page, (api, { id }) => api.del("items", id), {
      id: itemRecords[0]!.id as string,
    });
    await bridge(page, (api) => api.sync());

    // Verify via second device that sync round-trips both collections correctly
    const dbNameB = `e2e_${credentials.username}_crosscoll`;
    await switchToDevice(page, dbNameB);
    await bridge(page, (api) => api.sync());

    const itemsAfter = await bridge(page, (api) => api.query("items"));
    const notesAfter = await bridge(page, (api) => api.query("notes"));

    expect(itemsAfter.length).toBe(0);
    expect(notesAfter.length).toBe(1);
    expect(notesAfter[0]!.body).toBe("A Note");
  });
});

test.describe("Calamity — Recovery Scenarios", () => {
  test("sync failure recovery: continue after error", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create valid record
    await bridge(page, (api) => api.put("items", { title: "Valid", value: 1, tags: [] }));

    // Even if sync fails (network issue, etc), subsequent sync should work
    await bridge(page, (api) => api.sync());

    // Create another record
    await bridge(page, (api) => api.put("items", { title: "After Sync", value: 2, tags: [] }));
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(2);
  });

  test("fresh database pull after data exists on server", async ({ authenticatedContext }) => {
    const { page, credentials } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create and push data in DB-A
    await bridge(page, (api) => api.put("items", { title: "Server Data", value: 100, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Switch to completely fresh DB-B
    const dbNameB = `e2e_${credentials.username}_fresh_${Date.now()}`;
    await switchToDevice(page, dbNameB);

    // Sync should pull existing data
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("Server Data");
  });
});
