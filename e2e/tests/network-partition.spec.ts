/**
 * True network partitions (context.setOffline) — cutting the browser's
 * real network, unlike the "offline by not syncing" simulation in
 * calamity.spec.ts. Verifies loss-free, duplicate-free recovery.
 */

import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Network partition — mid-flight cut", () => {
  test("partition during an active sync recovers without loss or duplication", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // A record is pushed, then the network is cut the moment the cycle is
    // in flight. NOTE: an in-flight sync whose WS connect is cut never
    // settles (no connect timeout — recorded as an audit observation), so
    // the cycle is raced, not awaited; the explicit post-reconnect sync
    // drives convergence.
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "In Flight", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    const inFlight = bridge(alice.page, (api) => api.sync()).catch(() => undefined);
    await alice.context.setOffline(true);
    await Promise.race([inFlight, new Promise((r) => setTimeout(r, 2_000))]);

    // Both sides accumulate writes while truly offline.
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Alice Offline 1", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Alice Offline 2", value: 3, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bob.context.setOffline(true);
    await bridge(
      bob.page,
      (api, a) =>
        api.put("items", { title: "Bob Offline 1", value: 4, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );

    // Reconnect: both converge with every offline record exactly once.
    await alice.context.setOffline(false);
    await bob.context.setOffline(false);
    await bridge(alice.page, (api) => api.sync());
    await bridge(bob.page, (api) => api.sync());
    await bridge(alice.page, (api) => api.sync());

    for (const user of [alice, bob]) {
      const items = await bridge(user.page, (api) => api.query("items"));
      const titles = items.map((r: Record<string, unknown>) => r.title);
      for (const expected of [
        "In Flight",
        "Alice Offline 1",
        "Alice Offline 2",
        "Bob Offline 1",
      ]) {
        const count = titles.filter((t: unknown) => t === expected).length;
        expect(count, `${user.credentials.username} must see "${expected}" exactly once`).toBe(1);
      }
    }
  });

  test("repeated partition cycles during continuous writes converge", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Three cut/reconnect cycles with writes on both sides each time. The
    // cycle counter must travel through args — bridge functions are
    // serialized into the page and cannot close over test scope.
    for (const cycle of [1, 2, 3]) {
      await alice.context.setOffline(true);
      await bob.context.setOffline(true);
      await bridge(
        alice.page,
        (api, a) =>
          api.put("items", { title: `Alice Cycle ${a.cycle}`, value: a.cycle, tags: [] }, { space: a.spaceId }),
        { spaceId, cycle },
      );
      await bridge(
        bob.page,
        (api, a) =>
          api.put("items", { title: `Bob Cycle ${a.cycle}`, value: a.cycle + 10, tags: [] }, { space: a.spaceId }),
        { spaceId, cycle },
      );
      await alice.context.setOffline(false);
      await bob.context.setOffline(false);
      await bridge(alice.page, (api) => api.sync());
      await bridge(bob.page, (api) => api.sync());
    }
    await bridge(alice.page, (api) => api.sync());

    for (const user of [alice, bob]) {
      const items = await bridge(user.page, (api) => api.query("items"));
      expect(items.length, `${user.credentials.username} sees all 6 cycle records`).toBe(6);
    }
  });
});
