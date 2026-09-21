/**
 * Adversarial flows — operations that must FAIL to take effect, verified
 * against the receiving side after full sync cycles on both ends (the SDK's
 * sync() resolves rather than throwing on per-record push rejections —
 * failures land in the sync failure/quarantine path — so the enforcement
 * surface is delivery, and we assert it with positive controls).
 *
 * Observation recorded in the audit trail: the revoked/non-member push is
 * rejected SERVER-side, but the client surfaces no error — the record stays
 * silently local. That UX gap is tracked as an audit follow-up, not tested
 * here as desired behavior.
 */

import { test, expect, bridge, setupSharedSpace, removeMember } from "./fixtures";

test.describe("Adversarial — revocation enforcement", () => {
  test("removed member's writes never reach the space; both sides' other work unaffected", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId, bobDID } = await setupSharedSpace(alice, bob);

    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Shared Record", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    await removeMember(alice, spaceId, bobDID);

    // The removed member writes to the shared space and syncs repeatedly.
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob Ghost Write", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(bob.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());

    // Positive control 1: the removed member's personal space still syncs —
    // the connection and session are not bricked by the revocation.
    await bridge(bob.page, (api) => api.put("items", { title: "Bob Personal", value: 3, tags: [] }));
    await bridge(bob.page, (api) => api.sync());

    // Positive control 2: the admin keeps working in the shared space.
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Alice Still Writes", value: 4, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );

    // Full convergence attempt: several cycles on both sides. If the
    // revocation were unenforced, Bob's ghost write would appear here.
    for (let i = 0; i < 3; i++) {
      await bridge(alice.page, (api) => api.sync());
      await bridge(bob.page, (api) => api.sync());
    }

    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    const titles = aliceItems.map((r: Record<string, unknown>) => r.title);
    expect(titles).toContain("Shared Record");
    expect(titles).toContain("Alice Still Writes");
    expect(titles).not.toContain("Bob Ghost Write");

    // Bob's personal write persisted for Bob.
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.map((r: Record<string, unknown>) => r.title)).toContain("Bob Personal");
  });
});

test.describe("Adversarial — cross-account boundaries", () => {
  test("a non-member's writes into a foreign space never reach its members", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const mallory = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Mallory learns the space ID and targets it directly.
    await bridge(
      mallory.page,
      (api, a) =>
        api.put("items", { title: "Mallory Injection", value: 9, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    for (let i = 0; i < 3; i++) {
      await bridge(mallory.page, (api) => api.sync());
      await bridge(alice.page, (api) => api.sync());
    }

    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    expect(
      aliceItems.some((r: Record<string, unknown>) => r.title === "Mallory Injection"),
    ).toBe(false);

    // Positive control: Mallory's own personal space works.
    await bridge(mallory.page, (api) =>
      api.put("items", { title: "Mallory Personal", value: 1, tags: [] }),
    );
    await bridge(mallory.page, (api) => api.sync());
    const malloryItems = await bridge(mallory.page, (api) => api.query("items"));
    expect(malloryItems.map((r: Record<string, unknown>) => r.title)).toContain(
      "Mallory Personal",
    );
  });
});
