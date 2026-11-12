import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.describe("Omnigaze saved-data snapshot", () => {
  test("downloads the authenticated JSON snapshot without mutating account data", async ({
    page,
  }) => {
    let requestBody: unknown = null;
    let deletionCalled = false;

    await page.goto("/signin-with-chatgpt?return_to=/data-and-deletion", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/data-and-deletion$/);
    await expect(page.locator("main")).toHaveAttribute(
      "data-hydrated",
      "true",
      { timeout: 30_000 },
    );

    await page.route("**/api/account/data-export", async (route) => {
      requestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition":
            'attachment; filename="omnigaze-saved-data-snapshot-2026-11-12.json"',
        },
        body: JSON.stringify({
          schemaVersion: "omnigaze.saved-data-snapshot.v1",
          exportedAt: "2026-11-12T12:00:00.000Z",
          sections: {},
        }),
      });
    });
    await page.route("**/api/account/data", async (route) => {
      deletionCalled = true;
      await route.abort();
    });

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON snapshot" }).click();
    const download = await downloadPromise;

    expect(requestBody).toEqual({ format: "json" });
    expect(download.suggestedFilename()).toBe(
      "omnigaze-saved-data-snapshot-2026-11-12.json",
    );
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(JSON.parse(await readFile(downloadPath!, "utf8"))).toEqual({
      schemaVersion: "omnigaze.saved-data-snapshot.v1",
      exportedAt: "2026-11-12T12:00:00.000Z",
      sections: {},
    });
    expect(deletionCalled).toBe(false);
    await expect(page).toHaveURL(/\/data-and-deletion$/);
    await expect(page.getByRole("status")).toContainText("Download started");
    await expect(page.getByRole("status")).toContainText(
      "without changing your saved Omnigaze data",
    );
  });

  test("reports export failure honestly and rejects an unsafe response filename", async ({
    page,
  }) => {
    let shouldFail = true;
    const safeBody = {
      schemaVersion: "omnigaze.saved-data-snapshot.v1",
      exportedAt: "2026-11-12T12:00:00.000Z",
      sections: {},
    };

    await page.goto("/signin-with-chatgpt?return_to=/data-and-deletion", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("main")).toHaveAttribute(
      "data-hydrated",
      "true",
      { timeout: 30_000 },
    );
    await page.route("**/api/account/data-export", async (route) => {
      if (shouldFail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ code: "data_export_failed" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="../../outside.json"',
        },
        body: JSON.stringify(safeBody),
      });
    });

    const action = page.getByRole("button", { name: "Download JSON snapshot" });
    await action.click();
    await expect(page.getByRole("alert")).toContainText(
      "The snapshot could not be prepared",
    );

    shouldFail = false;
    const downloadPromise = page.waitForEvent("download");
    await action.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("omnigaze-saved-data-snapshot.json");
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(JSON.parse(await readFile(downloadPath!, "utf8"))).toEqual(safeBody);
    await expect(page.getByRole("status")).toContainText("Download started");
  });
});
