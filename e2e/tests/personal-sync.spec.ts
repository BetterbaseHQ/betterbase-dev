import { test, expect, bridge, waitForBridge } from "./fixtures";

test.describe("Personal Space Sync", () => {
  test("create record, sync, and query it back", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();

    // Wait for initial sync
    await bridge(page, (api) => api.waitForSync());

    // Create a record
    const id = await bridge(page, (api) =>
      api.put("items", { title: "Test Item", value: 42, tags: ["a", "b"] }),
    );
    expect(id).toBeTruthy();

    // Push to server
    await bridge(page, (api) => api.sync());

    // Query it back
    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("Test Item");
    expect(records[0]!.value).toBe(42);
    expect(records[0]!.tags).toEqual(["a", "b"]);
  });

  test("update record persists through sync", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    await bridge(page, (api) => api.put("items", { title: "Original", value: 1, tags: [] }));
    await bridge(page, (api) => api.sync());

    // Update — query inside the bridge to avoid closure capture
    await bridge(page, async (api) => {
      const items = await api.query("items");
      await api.patch("items", { id: items[0]!.id, title: "Updated", value: 2 });
    });
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records[0]!.title).toBe("Updated");
    expect(records[0]!.value).toBe(2);
  });

  test("delete record persists through sync", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    const id = await bridge(page, (api) =>
      api.put("items", { title: "To Delete", value: 0, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // Delete — pass id via args
    await bridge(page, (api, a) => api.del("items", a.id), { id });
    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(0);
  });

  test("data syncs to a fresh local database", async ({ authenticatedContext }) => {
    // Session A creates data and pushes
    const { page, credentials } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    await bridge(page, (api) =>
      api.put("items", { title: "From A", value: 100, tags: ["session-a"] }),
    );
    await bridge(page, (api) => api.sync());

    // Reload with a different DB name — session restores from localStorage,
    // but IndexedDB is fresh so data must be pulled from the server.
    const dbNameB = `e2e_${credentials.username}_session_b`;
    await page.goto(`/?db=${encodeURIComponent(dbNameB)}`);
    await page.waitForSelector("#status");
    await expect(page.locator("#status")).toHaveText("ready", {
      timeout: 30_000,
    });
    await waitForBridge(page);

    await bridge(page, (api) => api.sync());

    const records = await bridge(page, (api) => api.query("items"));
    expect(records.length).toBe(1);
    expect(records[0]!.title).toBe("From A");
    expect(records[0]!.value).toBe(100);
  });

  test("CRDT merge: concurrent edits to different fields", async ({ authenticatedContext }) => {
    const { page, credentials, dbName } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create record in DB-A and push
    const id = await bridge(page, (api) =>
      api.put("items", { title: "Original", value: 0, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // Switch to DB-B — pull the record, edit value, push
    const dbNameB = `e2e_${credentials.username}_merge_b`;
    await page.goto(`/?db=${encodeURIComponent(dbNameB)}`);
    await page.waitForSelector("#status");
    await expect(page.locator("#status")).toHaveText("ready", {
      timeout: 30_000,
    });
    await waitForBridge(page);
    // Force a sync cycle to pull data from server
    await bridge(page, (api) => api.sync());

    // DB-B should have the record
    const recordsB = await bridge(page, (api) => api.query("items"));
    expect(recordsB.length).toBe(1);
    const idB = recordsB[0]!.id as string;

    // Edit value in DB-B and push
    await bridge(page, (api, a) => api.patch("items", { id: a.id, value: 999 }), { id: idB });
    await bridge(page, (api) => api.sync());

    // Switch back to DB-A — edit title (without pulling B's changes first)
    await page.goto(`/?db=${encodeURIComponent(dbName)}`);
    await page.waitForSelector("#status");
    await expect(page.locator("#status")).toHaveText("ready", {
      timeout: 30_000,
    });
    await waitForBridge(page);

    // Edit title BEFORE syncing (so it's a local-only change)
    await bridge(page, (api, a) => api.patch("items", { id: a.id, title: "From A" }), { id });

    // Now sync — push local title edit, pull B's value edit, CRDT merge
    await bridge(page, (api) => api.sync());

    // DB-A should see merged result
    const mergedA = await bridge(page, (api) => api.query("items"));
    expect(mergedA[0]!.title).toBe("From A");
    expect(mergedA[0]!.value).toBe(999);

    // Switch to DB-B and pull — should also see merged result
    await page.goto(`/?db=${encodeURIComponent(dbNameB)}`);
    await page.waitForSelector("#status");
    await expect(page.locator("#status")).toHaveText("ready", {
      timeout: 30_000,
    });
    await waitForBridge(page);
    await bridge(page, (api) => api.sync());

    const mergedB = await bridge(page, (api) => api.query("items"));
    expect(mergedB[0]!.title).toBe("From A");
    expect(mergedB[0]!.value).toBe(999);
  });
});
