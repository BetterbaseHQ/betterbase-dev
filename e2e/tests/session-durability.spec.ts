/**
 * Cross-session durability.
 *
 * Guards the epoch-labeling bug class: a fresh session once labeled the
 * login-delivered epoch key 0 while the server reports epoch 1 for
 * a new space. The first pull's key-generation sync advanced the persisted
 * session to 1, and every DEK wrapped at epoch 0 — pushed inside the
 * ready-transition window — became permanently undecryptable in later
 * sessions (backward derivation is forbidden by forward secrecy).
 *
 * The spec writes a record *at the moment sync first reports ready* (the
 * same window real apps write in), then verifies it survives a reload and a
 * fresh-device pull with zero error-level console output, and that no
 * spurious epoch advance fired on the fresh account.
 */

import {
  test,
  expect,
  bridge,
  pollUntil,
  registerUser,
  loginUser,
  waitForBridge,
  generateUser,
  switchToDevice,
  collectConsoleErrors,
} from "./fixtures";
import { INITIAL_EPOCH } from "betterbase/sync";

test.describe("Session durability", () => {
  test("a first-ready write survives reload and fresh-device pull without epoch orphaning", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const creds = generateUser();
    // Raw JSON — URLSearchParams percent-encodes it once; the harness
    // JSON.parses the decoded value. (Pre-encoding here would double-encode
    // and the arm would be silently dropped.)
    const putAtReady = JSON.stringify({
      collection: "items",
      data: { title: "window-write", value: 7, tags: ["durability"] },
    });
    // favicon/vite.svg 404s are harness noise, not app errors
    const console_ = collectConsoleErrors(page, { ignore: [/favicon|vite\.svg/] });

    try {
      await registerUser(page, creds);
      await loginUser(page, creds, `e2e_${creds.username}_durability_a`, {
        extraParams: { putAtReady },
      });
      await waitForBridge(page);

      // The armed write fired inside the ready-transition window
      const armed = await pollUntil(
        page,
        (api) => {
          const s = api.getArmedPutStatus();
          return s.fired ? s : null;
        },
        { timeout: 30_000 },
      );
      expect(armed, "armed put never fired").not.toBeNull();
      expect(armed!.fired).toBe(true);
      expect(armed!.error, "armed put failed").toBeUndefined();

      // Bootstrap settles; the record is local and pushed
      await bridge(page, (api) => api.waitForSync());
      await bridge(page, (api) => api.sync());
      const pushed = await bridge(page, (api) => api.query("items"));
      expect(pushed.length).toBe(1);
      expect(pushed[0]!.title).toBe("window-write");

      // Contract pin: a fresh account's first bootstrap must not advance the
      // epoch — the session persists the initial label at creation, which
      // already equals the server's epoch for a new space. (A spurious
      // advance here is what orphaned below-generation DEKs.)
      const epochInfo = await bridge(page, (api) => api.getEpochInfo());
      expect(epochInfo.epoch).toBe(INITIAL_EPOCH);
      expect(epochInfo.advancedAt).toBeNull();

      console_.expectNone("session A (fresh login)");

      // Session B: true page reload — same db, session restored from storage
      await page.reload();
      await expect(page.locator("#status")).toHaveText("ready", { timeout: 30_000 });
      await waitForBridge(page);
      await bridge(page, (api) => api.waitForSync());
      await bridge(page, (api) => api.sync());
      const reloaded = await bridge(page, (api) => api.query("items"));
      expect(reloaded.length).toBe(1);
      expect(reloaded[0]!.title).toBe("window-write");
      console_.expectNone("session B (page reload)");

      // Session C: fresh local db (device switch) — everything must be
      // pulled and decrypt with the restored session's key material
      await switchToDevice(page, `e2e_${creds.username}_durability_c`);
      await bridge(page, (api) => api.waitForSync());
      await bridge(page, (api) => api.sync());
      const pulled = await bridge(page, (api) => api.query("items"));
      expect(pulled.length).toBe(1);
      expect(pulled[0]!.title).toBe("window-write");
      console_.expectNone("session C (fresh device)");
    } finally {
      await context.close();
    }
  });
});
