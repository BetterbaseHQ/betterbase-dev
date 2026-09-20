import { test, expect, bridge, waitForBridge } from "./fixtures";
import type { Page } from "@playwright/test";

// The conflict-reconciliation capstone: two devices of one account diverge
// while genuinely offline (network cut at the browser-context level, so no
// auto-sync can leak edits mid-divergence), then reconcile through the real
// accounts+sync stack. Asserts not just merged values but byte-identical
// convergence — both devices must end up with exactly the same projected
// state.

/** Open a second "device" (page) bound to its own OPFS database. */
async function openDevice(
  context: { newPage: () => Promise<Page> },
  dbName: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/?db=${encodeURIComponent(dbName)}`);
  await page.waitForSelector("#status", { timeout: 30_000 });
  await expect(page.locator("#status")).toHaveText("ready", { timeout: 30_000 });
  await waitForBridge(page);
  return page;
}

/** Sync and wait until the engine settles (reconnect-tolerant after offline). */
async function syncDevice(page: Page): Promise<void> {
  await bridge(page, (api) => api.waitForSync());
  await bridge(page, (api) => api.sync());
}

/** Deterministic projection of records for convergence comparison.
 *  Volatile fields (timestamps) are excluded — only merged data matters. */
function project(records: Array<Record<string, unknown>>): string {
  return JSON.stringify(
    records
      .map((r) => ({
        id: r.id as string,
        title: (r.title as string | undefined) ?? null,
        value: (r.value as number | undefined) ?? null,
        tags: (r.tags as string[] | undefined) ?? null,
        body: (r.body as string | undefined) ?? null,
        pinned: (r.pinned as boolean | undefined) ?? null,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  );
}

async function readAll(page: Page) {
  return bridge(page, async (api) => {
    const items = await api.query("items");
    const notes = await api.query("notes");
    return { items, notes };
  });
}

test.describe("Conflict reconciliation — offline divergence", () => {
  test("text, per-field, and created records all converge identically on both devices", async ({
    authenticatedContext,
  }) => {
    test.setTimeout(150_000);
    const { page: pageA, context, dbName } = await authenticatedContext();
    const BASE = "The quick brown fox jumps over the lazy dog";

    // Device B: second page, own database
    const pageB = await openDevice(context, `${dbName}_dev_b`);

    // Seed: one note (RGA text field) + one item (atomic fields), synced to both
    await bridge(pageA, (api) => api.waitForSync());
    await bridge(pageA, (api, a) => api.put("notes", { body: a.base, pinned: false }), {
      base: BASE,
    });
    await bridge(pageA, (api) =>
      api.put("items", { title: "Original", value: 0, tags: [] }),
    );
    await syncDevice(pageA);
    await syncDevice(pageB);

    // --- Genuine offline divergence: cut the network for the whole context ---
    await context.setOffline(true);

    // B: appends to the text field, patches a different atomic field, creates a record
    const noteId = (await bridge(pageB, (api) => api.query("notes")))[0]!.id as string;
    await bridge(
      pageB,
      (api, a) => api.patch("notes", { id: a.id, body: `${a.base} — B was here.` }),
      { id: noteId, base: BASE },
    );
    const itemId = (await bridge(pageB, (api) => api.query("items")))[0]!.id as string;
    await bridge(pageB, (api, a) => api.patch("items", { id: a.id, value: 100 }), { id: itemId });
    await bridge(pageB, (api) => api.put("items", { title: "B-new", value: 2, tags: ["b"] }));

    // A: prepends to the same text field, patches a disjoint atomic field, creates a record
    await bridge(
      pageA,
      (api, a) => api.patch("notes", { id: a.id, body: `A was here — ${a.base}` }),
      { id: noteId, base: BASE },
    );
    await bridge(pageA, (api, a) => api.patch("items", { id: a.id, title: "From A" }), { id: itemId });
    await bridge(pageA, (api) => api.put("items", { title: "A-new", value: 1, tags: ["a"] }));

    // --- Back online: reconcile (A pushes, B pulls+pushes, A pulls, B confirms) ---
    await context.setOffline(false);
    await syncDevice(pageA);
    await syncDevice(pageB);
    await syncDevice(pageA);
    await syncDevice(pageB);

    const stateA = await readAll(pageA);
    const stateB = await readAll(pageB);

    // --- Assertions on BOTH devices ---
    for (const [label, state] of [
      ["A", stateA],
      ["B", stateB],
    ] as const) {
      // Creates from both sides replicated
      const titles = state.items.map((r) => r.title);
      expect(titles, `${label}: all creates replicated`).toContain("A-new");
      expect(titles, `${label}: all creates replicated`).toContain("B-new");

      // Per-field merge: A's title + B's value on the same record
      const original = state.items.find((r) => r.title === "From A");
      expect(original, `${label}: per-field merge`).toBeDefined();
      expect(original!.value, `${label}: per-field merge`).toBe(100);

      // Char-level RGA merge: both edits to the same text field survive
      const body = state.notes[0]!.body as string;
      expect(body, `${label}: actual merged body`).toContain("A was here —");
      expect(body, `${label}: actual merged body`).toContain("— B was here.");
      expect(body, `${label}: original text preserved`).toContain(BASE);
    }

    // Byte-identical convergence of the projected state
    expect(project(stateA.items) === project(stateB.items), "items converge").toBe(true);
    expect(project(stateA.notes) === project(stateB.notes), "notes converge").toBe(true);

    await pageB.close();
  });

  test("delete-vs-edit converges to the same outcome on both devices", async ({
    authenticatedContext,
  }) => {
    test.setTimeout(150_000);
    const { page: pageA, context, dbName } = await authenticatedContext();

    const pageB = await openDevice(context, `${dbName}_del_b`);

    // Seed
    await bridge(pageA, (api) => api.waitForSync());
    const itemId = await bridge(pageA, (api) =>
      api.put("items", { title: "Doomed", value: 0, tags: [] }),
    );
    await syncDevice(pageA);
    await syncDevice(pageB);

    // --- Offline divergence: A deletes, B edits ---
    await context.setOffline(true);
    await bridge(pageA, (api, a) => api.del("items", a.id), { id: itemId });
    await bridge(pageB, (api, a) => api.patch("items", { id: a.id, title: "Edited while deleted" }), {
      id: itemId,
    });

    // --- Reconcile in rounds until both devices agree ---
    // get() throws for tombstoned records — treat that as the deleted state
    const read = (page: Page) =>
      bridge(page, async (api, a) => {
        try {
          const rec = await api.get("items", a.id);
          return rec ? ((rec.title as string) ?? "untitled") : "null";
        } catch (err) {
          if (/Record deleted/i.test(String(err))) return "tombstone";
          throw err;
        }
      }, { id: itemId });

    await context.setOffline(false);
    let aState: string | null = null;
    let bState: string | null = null;
    for (let round = 0; round < 3; round++) {
      await syncDevice(pageA);
      await syncDevice(pageB);
      aState = await read(pageA);
      bState = await read(pageB);
      if (aState === bState) break;
    }
    expect(aState, "delete-vs-edit converges to one outcome").toBe(bState);

    // Stability: one more full round must not flip either device
    await syncDevice(pageA);
    expect(await read(pageA)).toBe(aState);
    await syncDevice(pageB);
    expect(await read(pageB)).toBe(aState);

    await pageB.close();
  });
});
