import { test, expect, bridge, setupSharedSpace } from "./fixtures";

test.describe("Encrypted Files", () => {
  test("file round-trip: upload data matches download data", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    // Create a record to associate the file with
    const recordId = await bridge(page, (api) =>
      api.put("items", { title: "File Test", value: 0, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // Upload known data
    const originalData = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const fileId = crypto.randomUUID();

    await bridge(page, (api, a) => api.uploadFile(a.fileId, a.data, a.recordId), {
      fileId,
      data: originalData,
      recordId,
    });

    // Download and verify round-trip
    const downloaded = await bridge(page, (api, a) => api.downloadFile(a.fileId), { fileId });
    expect(downloaded).toEqual(originalData);
  });

  test("upload text file and download it back", async ({ authenticatedContext }) => {
    const { page } = await authenticatedContext();
    await bridge(page, (api) => api.waitForSync());

    const recordId = await bridge(page, (api) =>
      api.put("items", { title: "Text File", value: 0, tags: [] }),
    );
    await bridge(page, (api) => api.sync());

    // "Hello, encrypted world!" as bytes
    const textBytes = Array.from(new TextEncoder().encode("Hello, encrypted world!"));
    const fileId = crypto.randomUUID();

    await bridge(page, (api, a) => api.uploadFile(a.fileId, a.data, a.recordId), {
      fileId,
      data: textBytes,
      recordId,
    });

    const downloaded = await bridge(page, (api, a) => api.downloadFile(a.fileId), { fileId });
    expect(downloaded).toEqual(textBytes);
  });

  test("shared-space file round-trip: upload and download in shared space", async ({
    authenticatedContext,
  }) => {
    const alice = await authenticatedContext();
    const bob = await authenticatedContext();
    const { spaceId } = await setupSharedSpace(alice, bob);

    // Alice creates a record in the shared space
    const recordId = await bridge(
      alice.page,
      (api, a) =>
        api.put("items", { title: "Shared File Test", value: 0, tags: [] }, { space: a.spaceId }),
      { spaceId },
    );
    await bridge(alice.page, (api) => api.sync());

    // Alice uploads a file in the shared space
    const originalData = [10, 20, 30, 40, 50];
    const fileId = crypto.randomUUID();

    await bridge(alice.page, (api, a) => api.uploadFile(a.fileId, a.data, a.recordId, a.spaceId), {
      fileId,
      data: originalData,
      recordId,
      spaceId,
    });

    // Alice can download her own upload
    const aliceDownload = await bridge(
      alice.page,
      (api, a) => api.downloadFile(a.fileId, a.spaceId),
      { fileId, spaceId },
    );
    expect(aliceDownload).toEqual(originalData);

    // Bob syncs and downloads the same file
    await bridge(bob.page, (api) => api.sync());
    const bobDownload = await bridge(bob.page, (api, a) => api.downloadFile(a.fileId, a.spaceId), {
      fileId,
      spaceId,
    });
    expect(bobDownload).toEqual(originalData);
  });
});
