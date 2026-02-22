import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Edit History — Edit Chain Tracking", () => {
  test("single edit has one chain entry with correct author", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, aliceDID } = await setupSharedSpace(alice, bob);

    // Alice creates a record in the shared space
    const recordId = await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Chain Test", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob pulls — poll until edit chain is populated
    await bridge(bob.page, (api) => api.sync());
    await bob.page.waitForFunction(
      async (id) => {
        const r = await window.__test.get("items", id);
        return r && Array.isArray(r._editChain) && r._editChain.length > 0;
      },
      recordId,
      { timeout: 15_000 },
    );

    const record = await bridge(bob.page, (api, a) => api.get("items", a.id), { id: recordId });

    const chain = record!._editChain as Array<{
      author: string;
      timestamp: number;
    }>;
    expect(chain.length).toBe(1);
    expect(chain[0]!.author).toBe(aliceDID);
    expect(record!._editChainValid).toBe(true);
  });

  test("multiple edits build a chain", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, aliceDID } = await setupSharedSpace(alice, bob);

    // Alice creates a record
    const recordId = await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Multi Edit", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Alice patches twice, syncing after each (sync = push + pull, which
    // updates _lastServerView so the next push diffs from the correct baseline)
    await bridge(alice.page, (api, a) => api.patch("items", { id: a.id, value: 2 }), {
      id: recordId,
    });
    await bridge(alice.page, (api) => api.sync());

    await bridge(alice.page, (api, a) => api.patch("items", { id: a.id, value: 3 }), {
      id: recordId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Bob pulls — poll until chain has all entries
    await bridge(bob.page, (api) => api.sync());
    await bob.page.waitForFunction(
      async (id) => {
        const r = await window.__test.get("items", id);
        return r && Array.isArray(r._editChain) && r._editChain.length >= 2;
      },
      recordId,
      { timeout: 15_000 },
    );

    const record = await bridge(bob.page, (api, a) => api.get("items", a.id), { id: recordId });

    const chain = record!._editChain as Array<{
      author: string;
      timestamp: number;
    }>;
    // At least 2 entries: initial create + patches (consecutive same-author
    // pushes may coalesce if _lastServerView hasn't updated between pushes)
    expect(chain.length).toBeGreaterThanOrEqual(2);
    for (const entry of chain) {
      expect(entry.author).toBe(aliceDID);
    }
    expect(record!._editChainValid).toBe(true);
  });

  test("multi-author chain tracks both authors", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, aliceDID, bobDID } = await setupSharedSpace(alice, bob);

    // Alice creates a record
    const recordId = await bridge(
      alice.page,
      (api, a) => api.put("items", { title: "Collab", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob pulls, patches, and syncs
    await bridge(bob.page, (api) => api.sync());
    await bridge(bob.page, (api, a) => api.patch("items", { id: a.id, title: "Collab by Bob" }), {
      id: recordId,
    });
    await bridge(bob.page, (api) => api.sync());

    // Alice pulls — poll until chain has 2 entries
    await bridge(alice.page, (api) => api.sync());
    await alice.page.waitForFunction(
      async (id) => {
        const r = await window.__test.get("items", id);
        return r && Array.isArray(r._editChain) && r._editChain.length >= 2;
      },
      recordId,
      { timeout: 15_000 },
    );

    const record = await bridge(alice.page, (api, a) => api.get("items", a.id), { id: recordId });

    const chain = record!._editChain as Array<{
      author: string;
      timestamp: number;
    }>;
    expect(chain.length).toBe(2);
    expect(chain[0]!.author).toBe(aliceDID);
    expect(chain[1]!.author).toBe(bobDID);
    expect(record!._editChainValid).toBe(true);
  });
});
