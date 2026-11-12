import { expect, test } from "@playwright/test";

test.describe("Omnigaze public experience", () => {
  test("landing page exposes its primary navigation and dashboard CTA", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation")).toBeVisible();
    await expect(page.getByRole("link", { name: "Omnigaze home" })).toBeVisible();

    const dashboardCta = page
      .getByRole("link", { name: /open alpha/i })
      .first();
    await expect(dashboardCta).toBeVisible();
    await expect(dashboardCta).toHaveAttribute("href", "/dashboard");
  });

  test("How It Works steps disclose the selected evidence workflow", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    const heading = page.getByRole("heading", {
      name: /from market noise to a view you can verify/i,
    });
    await expect(heading).toBeVisible();

    const step = page.getByRole("button", {
      name: /evidence arrives continuously/i,
    });
    await expect(step).toHaveAttribute("aria-expanded", "false");
    await step.click();
    await expect(step).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("region", { name: /evidence arrives continuously/i }),
    ).toContainText("Live provider pipeline");
    await expect(
      page.getByRole("heading", { name: "Signals become structured context" }),
    ).toBeVisible();
  });

  test("dashboard route loads the market workspace", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    await expect(page.getByRole("link", { name: "Omnigaze home" })).toBeVisible();
    await expect(page.getByText("Core holdings", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/OMNIGAZE VIEW/).first()).toBeVisible();
  });

  test("anonymous watchlists stay device-local and advertise account sync", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    await expect(page.getByText("Saved on this device")).toBeVisible();
    const syncLink = page.getByRole("link", { name: "Sync across devices" });
    await expect(syncLink).toHaveAttribute(
      "href",
      /\/signin-with-chatgpt\?return_to=%2Fdashboard/,
    );

    await page.getByRole("button", { name: "Remove TSLA from watchlist" }).click();
    await expect(
      page.getByRole("button", { name: "Remove TSLA from watchlist" }),
    ).toHaveCount(0);
    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByText("Saved on this device")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove TSLA from watchlist" }),
    ).toHaveCount(0);
  });

  test("signed-in watchlists round-trip through D1 without local storage", async ({
    browser,
    context,
    page,
  }) => {
    test.setTimeout(75_000);
    await page.goto("/signin-with-chatgpt?return_to=/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByText("Synced across your devices")).toBeVisible();
    const origin = new URL(page.url()).origin;

    const current = await context.request.get("/api/watchlists");
    expect(current.status()).toBe(200);
    const currentBody = (await current.json()) as {
      data: Array<{ id: string; items: Array<{ symbolId: string }> }>;
    };
    for (const list of currentBody.data) {
      for (const item of list.items) {
        const cleanup = await context.request.post("/api/watchlists", {
          data: {
            operation: "remove",
            watchlist_id: list.id,
            symbol_id: item.symbolId,
          },
        });
        expect(cleanup.status()).toBe(200);
      }
    }
    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    await page.getByTestId("overview-add-stock").click();
    const addResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/watchlists") &&
        response.request().method() === "POST",
    );
    await page.getByRole("option").filter({ hasText: "NVDA" }).click();
    expect((await addResponse).status()).toBe(200);
    await expect(page.getByText("Synced across your devices")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove NVDA from watchlist" }),
    ).toBeVisible();

    const authCookies = await context.cookies();
    const freshContext = await browser.newContext({
      storageState: { cookies: authCookies, origins: [] },
    });
    const freshPage = await freshContext.newPage();
    await freshPage.goto(`${origin}/dashboard`);
    await expect(freshPage.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(freshPage.getByText("Synced across your devices")).toBeVisible();
    await expect(
      freshPage.getByRole("button", { name: "Remove NVDA from watchlist" }),
    ).toBeVisible();

    const removeResponse = freshPage.waitForResponse(
      (response) =>
        response.url().includes("/api/watchlists") &&
        response.request().method() === "POST",
    );
    await freshPage
      .getByRole("button", { name: "Remove NVDA from watchlist" })
      .click();
    expect((await removeResponse).status()).toBe(200);
    await freshContext.close();

    const verifyContext = await browser.newContext({
      storageState: { cookies: authCookies, origins: [] },
    });
    const verifyPage = await verifyContext.newPage();
    await verifyPage.goto(`${origin}/dashboard`);
    await expect(verifyPage.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(verifyPage.getByRole("heading", { name: "Start your watchlist" })).toBeVisible();
    await expect(
      verifyPage.getByRole("button", { name: "Remove NVDA from watchlist" }),
    ).toHaveCount(0);
    await verifyContext.close();
  });

  test("landing page does not overflow a 390px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));

    expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(
      dimensions.viewport + 1,
    );
    expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(
      dimensions.viewport + 1,
    );
  });

  test("Chinese landing preference is complete and persists", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "中文" }).click();

    await expect(page.locator("main")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "洞察股票为何波动",
    );
    await expect(page.getByRole("link", { name: /体验 Alpha 版/ }).first()).toBeVisible();

    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(page.locator("main")).toHaveAttribute("lang", "zh-CN");
    await expect(page.getByRole("button", { name: "中文" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
