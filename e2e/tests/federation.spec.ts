import { test, expect, bridge, setupSharedSpace, removeMember, pollUntil } from "./fixtures";

test.describe("Federation — Dual-Server Discovery", () => {
  test("Server A discovery includes federation metadata", async ({ page }) => {
    const response = await page.request.get("http://localhost:25377/.well-known/less-platform");
    expect(response.ok()).toBe(true);

    const metadata = await response.json();
    expect(metadata.version).toBe(1);
    expect(metadata.federation).toBe(true);
    expect(metadata.federation_ws).toBeTruthy();
    expect(metadata.accounts_endpoint).toBe("http://localhost:25377");
    expect(metadata.sync_endpoint).toBe("http://localhost:25379/api/v1");
  });

  test("Server B discovery includes federation metadata", async ({ page }) => {
    const response = await page.request.get("http://localhost:25387/.well-known/less-platform");
    expect(response.ok()).toBe(true);

    const metadata = await response.json();
    expect(metadata.version).toBe(1);
    expect(metadata.federation).toBe(true);
    expect(metadata.federation_ws).toBeTruthy();
    expect(metadata.accounts_endpoint).toBe("http://localhost:25387");
    expect(metadata.sync_endpoint).toBe("http://localhost:25389/api/v1");
  });
});

test.describe("Federation — JWKS Endpoints", () => {
  test("sync-a publishes Ed25519 federation key via JWKS", async ({ page }) => {
    const response = await page.request.get("http://localhost:25379/.well-known/jwks.json");
    expect(response.ok()).toBe(true);

    const jwks = await response.json();
    expect(jwks.keys).toBeDefined();
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);

    const fedKey = jwks.keys.find((k: { use?: string }) => k.use === "federation");
    expect(fedKey).toBeTruthy();
    expect(fedKey.kty).toBe("OKP");
    expect(fedKey.crv).toBe("Ed25519");
    expect(fedKey.kid).toBeTruthy();
    expect(fedKey.x).toBeTruthy();
  });

  test("sync-b publishes Ed25519 federation key via JWKS", async ({ page }) => {
    const response = await page.request.get("http://localhost:25389/.well-known/jwks.json");
    expect(response.ok()).toBe(true);

    const jwks = await response.json();
    expect(jwks.keys).toBeDefined();

    const fedKey = jwks.keys.find((k: { use?: string }) => k.use === "federation");
    expect(fedKey).toBeTruthy();
    expect(fedKey.kty).toBe("OKP");
    expect(fedKey.crv).toBe("Ed25519");
  });

  test("servers have different federation public keys", async ({ page }) => {
    const [respA, respB] = await Promise.all([
      page.request.get("http://localhost:25379/.well-known/jwks.json"),
      page.request.get("http://localhost:25389/.well-known/jwks.json"),
    ]);

    const jwksA = await respA.json();
    const jwksB = await respB.json();

    const keyA = jwksA.keys.find((k: { use?: string }) => k.use === "federation");
    const keyB = jwksB.keys.find((k: { use?: string }) => k.use === "federation");

    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    // Each server generates its own keypair — public keys should differ
    expect(keyA.x).not.toBe(keyB.x);
  });
});

test.describe("Federation — Health Endpoints", () => {
  test("sync-a health reports federation enabled", async ({ page }) => {
    const response = await page.request.get("http://localhost:25379/health");
    expect(response.ok()).toBe(true);

    const health = await response.json();
    expect(health.status).toBe("healthy");
    expect(health.federation).toBeDefined();
    expect(health.federation.enabled).toBe(true);
    expect(health.federation.peer_count).toBeGreaterThanOrEqual(1);
  });

  test("sync-b health reports federation enabled", async ({ page }) => {
    const response = await page.request.get("http://localhost:25389/health");
    expect(response.ok()).toBe(true);

    const health = await response.json();
    expect(health.status).toBe("healthy");
    expect(health.federation).toBeDefined();
    expect(health.federation.enabled).toBe(true);
    expect(health.federation.peer_count).toBeGreaterThanOrEqual(1);
  });
});

test.describe("Federation — Server B Auth", () => {
  test("user can register and authenticate on Server B", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext({ server: "b" });

    const state = await bridge(page, (api) => api.getAuthState());
    expect(state.isAuthenticated).toBe(true);
    expect(state.personalSpaceId).toBeTruthy();
    expect(state.hasEncryptionKey).toBe(true);
    expect(state.hasKeypair).toBe(true);
  });

  test("Server B user can sync data", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext({ server: "b" });

    await bridge(page, (api) => api.waitForSync());
    const syncStatus = await bridge(page, (api) => api.getSyncStatus());
    expect(syncStatus.phase).toBe("ready");

    // Create and sync an item
    const id = await bridge(page, (api) =>
      api.put("items", { title: "server-b-test", value: 42, tags: [] }),
    );
    expect(id).toBeTruthy();
    await bridge(page, (api) => api.sync());

    // Verify round-trip
    const item = await bridge(page, (api, a) => api.get("items", a.id), {
      id,
    });
    expect(item).toBeTruthy();
    expect(item!.title).toBe("server-b-test");
  });
});

test.describe("Federation — Cross-Server Data Independence", () => {
  test("data on Server A is isolated from Server B", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext({ server: "a" });
    const bob = await authenticatedContext({ server: "b" });
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Alice creates an item on Server A
    await bridge(alice.page, (api) =>
      api.put("items", { title: "Alice on A", value: 1, tags: [] }),
    );
    await bridge(alice.page, (api) => api.sync());

    // Bob creates an item on Server B
    await bridge(bob.page, (api) => api.put("items", { title: "Bob on B", value: 2, tags: [] }));
    await bridge(bob.page, (api) => api.sync());

    // Alice only sees her own data
    const aliceItems = await bridge(alice.page, (api) => api.query("items"));
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Alice on A")).toBe(true);
    expect(aliceItems.some((r: Record<string, unknown>) => r.title === "Bob on B")).toBe(false);

    // Bob only sees his own data
    const bobItems = await bridge(bob.page, (api) => api.query("items"));
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Bob on B")).toBe(true);
    expect(bobItems.some((r: Record<string, unknown>) => r.title === "Alice on A")).toBe(false);
  });

  test("both servers support full CRUD independently", async ({ authenticatedContext }) => {
    const alice = await authenticatedContext({ server: "a" });
    const bob = await authenticatedContext({ server: "b" });
    await bridge(alice.page, (api) => api.waitForSync());
    await bridge(bob.page, (api) => api.waitForSync());

    // Both create, update, query, and delete — full CRUD cycle

    // Server A: Create
    const aliceId = await bridge(alice.page, (api) =>
      api.put("items", { title: "A-CRUD", value: 10, tags: [] }),
    );
    await bridge(alice.page, (api) => api.sync());

    // Server B: Create
    const bobId = await bridge(bob.page, (api) =>
      api.put("items", { title: "B-CRUD", value: 20, tags: [] }),
    );
    await bridge(bob.page, (api) => api.sync());

    // Server A: Update
    await bridge(alice.page, (api, a) => api.patch("items", { id: a.id, value: 11 }), {
      id: aliceId,
    });
    await bridge(alice.page, (api) => api.sync());

    // Server B: Update
    await bridge(bob.page, (api, a) => api.patch("items", { id: a.id, value: 21 }), { id: bobId });
    await bridge(bob.page, (api) => api.sync());

    // Verify updates
    const aliceItem = await bridge(alice.page, (api, a) => api.get("items", a.id), { id: aliceId });
    expect(aliceItem!.value).toBe(11);

    const bobItem = await bridge(bob.page, (api, a) => api.get("items", a.id), {
      id: bobId,
    });
    expect(bobItem!.value).toBe(21);

    // Server A: Delete
    await bridge(alice.page, (api, a) => api.del("items", a.id), {
      id: aliceId,
    });
    await bridge(alice.page, (api) => api.sync());

    const aliceDeleted = await bridge(alice.page, (api, a) => api.get("items", a.id), {
      id: aliceId,
    });
    expect(aliceDeleted).toBeNull();

    // Server B: Delete
    await bridge(bob.page, (api, a) => api.del("items", a.id), {
      id: bobId,
    });
    await bridge(bob.page, (api) => api.sync());

    const bobDeleted = await bridge(bob.page, (api, a) => api.get("items", a.id), { id: bobId });
    expect(bobDeleted).toBeNull();
  });
});

test.describe("Federation — Server B Multiplayer", () => {
  test("two Server B users can create and join a shared space", async ({
    authenticatedContext,
  }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId } = await setupSharedSpace(charlie, dana);

    expect(spaceId).toBeTruthy();

    // Both users see the shared space in their active spaces
    const charlieSpaces = await bridge(charlie.page, (api) => api.getActiveSpaces());
    expect(charlieSpaces.some((s: { spaceId: string }) => s.spaceId === spaceId)).toBe(true);

    const danaSpaces = await bridge(dana.page, (api) => api.getActiveSpaces());
    expect(danaSpaces.some((s: { spaceId: string }) => s.spaceId === spaceId)).toBe(true);
  });

  test("Server B shared space data syncs between members", async ({ authenticatedContext }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId } = await setupSharedSpace(charlie, dana);

    // Charlie creates a record in the shared space
    const recordId = await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "Shared on B", value: 42, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());

    // Dana syncs and sees Charlie's record
    await bridge(dana.page, (api) => api.sync());
    const danaRecord = await bridge(dana.page, (api, a) => api.get("items", a.id), {
      id: recordId,
    });
    expect(danaRecord).toBeTruthy();
    expect(danaRecord!.title).toBe("Shared on B");
    expect(danaRecord!.value).toBe(42);
  });

  test("Server B concurrent edits merge via CRDT", async ({ authenticatedContext }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId } = await setupSharedSpace(charlie, dana);

    // Charlie creates a record
    const recordId = await bridge(
      charlie.page,
      (api, a) => api.put("items", { title: "Original", value: 0, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());
    await bridge(dana.page, (api) => api.sync());

    // Concurrent edits: Charlie patches title, Dana patches value
    await bridge(
      charlie.page,
      (api, a) => api.patch("items", { id: a.id, title: "Charlie Edit" }),
      { id: recordId },
    );

    await bridge(dana.page, (api, a) => api.patch("items", { id: a.id, value: 777 }), {
      id: recordId,
    });

    // Three rounds for reliable convergence
    for (let i = 0; i < 3; i++) {
      await bridge(charlie.page, (api) => api.sync());
      await bridge(dana.page, (api) => api.sync());
    }

    // Both should see merged result
    const charlieRecord = await bridge(charlie.page, (api, a) => api.get("items", a.id), {
      id: recordId,
    });
    expect(charlieRecord!.title).toBe("Charlie Edit");
    expect(charlieRecord!.value).toBe(777);

    const danaRecord = await bridge(dana.page, (api, a) => api.get("items", a.id), {
      id: recordId,
    });
    expect(danaRecord!.title).toBe("Charlie Edit");
    expect(danaRecord!.value).toBe(777);
  });
});

// ---------------------------------------------------------------------------
// Epoch rotation on Server B (epoch.begin, epoch.complete, deks.rewrap)
// ---------------------------------------------------------------------------

test.describe("Federation — Server B Epoch Rotation", () => {
  test("key rotation increments epoch and preserves data access", async ({
    authenticatedContext,
  }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId } = await setupSharedSpace(charlie, dana);

    // Charlie writes data before rotation
    await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "Pre-Rotation-B", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());
    await bridge(dana.page, (api) => api.sync());

    const epochBefore = await bridge(charlie.page, (api, a) => api.getSpaceEpoch(a.spaceId), {
      spaceId,
    });

    // Charlie rotates the space key
    await bridge(charlie.page, (api, a) => api.rotateSpaceKey(a.spaceId), {
      spaceId,
    });
    await bridge(charlie.page, (api) => api.sync());

    const epochAfter = await bridge(charlie.page, (api, a) => api.getSpaceEpoch(a.spaceId), {
      spaceId,
    });
    expect(epochAfter).toBeGreaterThan(epochBefore ?? 0);

    // Charlie writes data after rotation
    await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "Post-Rotation-B", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());

    // Dana sees both pre- and post-rotation data
    await bridge(dana.page, (api) => api.sync());
    const danaItems = await bridge(dana.page, (api) => api.query("items"));
    expect(danaItems.some((r: Record<string, unknown>) => r.title === "Pre-Rotation-B")).toBe(true);
    expect(danaItems.some((r: Record<string, unknown>) => r.title === "Post-Rotation-B")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Revocation on Server B (membership.revoke, epoch.begin/complete, deks.rewrap)
// ---------------------------------------------------------------------------

test.describe("Federation — Server B Revocation", () => {
  test("member removal revokes access and provides forward secrecy", async ({
    authenticatedContext,
  }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId, bobDID: danaDID } = await setupSharedSpace(charlie, dana);

    // Pre-removal: both see shared data
    await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "Before-Revoke-B", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());
    await bridge(dana.page, (api) => api.sync());

    const danaItemsBefore = await bridge(dana.page, (api) => api.query("items"));
    expect(
      danaItemsBefore.some((r: Record<string, unknown>) => r.title === "Before-Revoke-B"),
    ).toBe(true);

    // Remove Dana
    await removeMember(charlie, spaceId, danaDID);

    // Verify member list shrunk
    const membersAfter = await bridge(charlie.page, (api, a) => api.getMembers(a.spaceId), {
      spaceId,
    });
    expect(membersAfter.length).toBe(1);

    // Charlie writes new data under rotated key
    await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "After-Revoke-B", value: 2, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());

    // Dana can't see post-removal data (forward secrecy)
    try {
      await bridge(dana.page, (api) => api.sync());
    } catch {
      // Expected: sync may throw due to revoked UCAN
    }

    const danaItemsAfter = await bridge(dana.page, (api) => api.query("items"));
    expect(
      danaItemsAfter.find((r: Record<string, unknown>) => r.title === "After-Revoke-B"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Files on Server B (file HTTP endpoints, deks.getFiles)
// ---------------------------------------------------------------------------

test.describe("Federation — Server B Files", () => {
  test("personal space file round-trip on Server B", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext({ server: "b" });
    await bridge(page, (api) => api.waitForSync());

    const recordId = await bridge(page, (api) =>
      api.put("items", { title: "File-Test-B", value: 0, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    const originalData = [11, 22, 33, 44, 55];
    const fileId = crypto.randomUUID();

    await bridge(page, (api, a) => api.uploadFile(a.fileId, a.data, a.recordId), {
      fileId,
      data: originalData,
      recordId,
    });

    const downloaded = await bridge(page, (api, a) => api.downloadFile(a.fileId), { fileId });
    expect(downloaded).toEqual(originalData);
  });

  test("shared-space file round-trip on Server B", async ({ authenticatedContext }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId } = await setupSharedSpace(charlie, dana);

    // Charlie creates a record and uploads a file
    const recordId = await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "Shared-File-B", value: 0, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());

    const originalData = [99, 88, 77, 66, 55];
    const fileId = crypto.randomUUID();

    await bridge(
      charlie.page,
      (api, a) => api.uploadFile(a.fileId, a.data, a.recordId, a.spaceId),
      { fileId, data: originalData, recordId, spaceId },
    );

    // Charlie can download
    const charlieDownload = await bridge(
      charlie.page,
      (api, a) => api.downloadFile(a.fileId, a.spaceId),
      { fileId, spaceId },
    );
    expect(charlieDownload).toEqual(originalData);

    // Dana syncs and downloads the same file
    await bridge(dana.page, (api) => api.sync());
    const danaDownload = await bridge(
      dana.page,
      (api, a) => api.downloadFile(a.fileId, a.spaceId),
      { fileId, spaceId },
    );
    expect(danaDownload).toEqual(originalData);
  });
});

// ---------------------------------------------------------------------------
// Realtime WS on Server B (sync notification, invitation notification,
// revoked notification)
// ---------------------------------------------------------------------------

test.describe("Federation — Server B Realtime", () => {
  test("WS sync notification: push triggers automatic pull on Server B", async ({
    authenticatedContext,
  }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId } = await setupSharedSpace(charlie, dana);

    // Charlie pushes a record
    await bridge(
      charlie.page,
      (api, a) =>
        api.put("items", { title: "WS-Sync-B", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(charlie.page, (api) => api.sync());

    // Dana should receive via WS without manual sync
    await dana.page.waitForFunction(
      async () => {
        const records = await window.__test.query("items");
        return records.some((r: Record<string, unknown>) => r.title === "WS-Sync-B");
      },
      undefined,
      { timeout: 15_000 },
    );

    const danaItems = await bridge(dana.page, (api) => api.query("items"));
    expect(danaItems.find((r: Record<string, unknown>) => r.title === "WS-Sync-B")).toBeTruthy();
  });

  test("WS invitation notification on Server B", async ({ authenticatedContext }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    await bridge(charlie.page, (api) => api.waitForSync());
    await bridge(dana.page, (api) => api.waitForSync());

    // Charlie creates space and invites Dana
    const spaceId = await bridge(charlie.page, (api) => api.createSpace());
    await bridge(charlie.page, (api) => api.sync());
    await bridge(charlie.page, (api, a) => api.invite(a.spaceId, a.handle), {
      spaceId,
      handle: dana.credentials.handle,
    });
    await bridge(charlie.page, (api) => api.sync());

    // Dana does NOT call checkInvitations — WS should deliver it
    const invitations = await pollUntil(dana.page, async (api) => {
      const invs = await api.getInvitations();
      return invs.length > 0 ? invs : null;
    });

    expect(invitations!.length).toBeGreaterThanOrEqual(1);
    expect(invitations![0]!.spaceId).toBe(spaceId);
  });

  test("WS revocation notification on Server B", async ({ authenticatedContext }) => {
    const charlie = await authenticatedContext({ server: "b" });
    const dana = await authenticatedContext({ server: "b" });
    const { spaceId, bobDID: danaDID } = await setupSharedSpace(charlie, dana);

    // Dana writes data to confirm membership
    await bridge(
      dana.page,
      (api, a) =>
        api.put("items", { title: "Dana-WS-B", value: 1, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(dana.page, (api) => api.sync());

    // Verify Dana has the space
    const spacesBefore = await bridge(dana.page, (api) => api.getActiveSpaces());
    expect(spacesBefore.some((s: Record<string, unknown>) => s.spaceId === spaceId)).toBe(true);

    // Charlie removes Dana
    await bridge(charlie.page, (api, a) => api.removeMember(a.spaceId, a.did), {
      spaceId,
      did: danaDID,
    });
    await bridge(charlie.page, (api) => api.sync());

    // Dana does NOT call sync — WS should deliver revocation
    await dana.page.waitForFunction(
      async (sid) => {
        const spaces = await window.__test.getActiveSpaces();
        return !spaces.some((s: Record<string, unknown>) => s.spaceId === sid);
      },
      spaceId,
      { timeout: 15_000 },
    );

    const spacesAfter = await bridge(dana.page, (api) => api.getActiveSpaces());
    expect(spacesAfter.some((s: Record<string, unknown>) => s.spaceId === spaceId)).toBe(false);
  });
});
