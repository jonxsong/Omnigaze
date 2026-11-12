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
    await expect(dashboardCta).toHaveAttribute("href", "/onboarding");
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

  test("a failed quote refresh labels retained data as last known", async ({
    page,
  }) => {
    let failRefresh = false;
    await page.route("**/api/market/snapshot?*", async (route) => {
      const symbol = new URL(route.request().url()).searchParams.get("symbol");
      if (symbol !== "NASDAQ:NVDA") return route.continue();
      if (failRefresh) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "market_data_unavailable",
            error: "Market data is temporarily unavailable.",
          }),
        });
        return;
      }

      const asOf = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            symbolId: "NASDAQ:NVDA",
            asOf,
            session: "regular",
            price: 181.25,
            previousClose: 179.5,
            change: 1.75,
            changePercent: 0.97,
            volume: 1_200_000,
            marketCap: "$4.4T",
            isDelayed: false,
            delaySeconds: 0,
            provider: "Test provider",
            marketCoverage: "limited-exchange",
          },
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage: "partial",
            coverage: "partial",
            generatedAt: asOf,
            freshness: { state: "fresh", asOf, ageSeconds: 0 },
            providers: [],
            notice: "Test provider quote.",
          },
        }),
      });
    });

    await page.goto("/dashboard");
    await expect(page.locator(".demo-banner.provider")).toContainText(
      "Test provider",
    );
    await page.getByRole("button", { name: "View data status" }).click();
    failRefresh = true;
    await page.getByRole("button", { name: "Refresh now" }).click();

    await expect(page.locator(".demo-banner.stale")).toContainText(
      /last known quote.*refresh failed/i,
    );
    await expect(page.locator(".demo-banner.provider")).toHaveCount(0);
    await expect(page.getByText("Provider quote · stale")).toBeVisible();
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

  test("universal stock search persists metadata without cross-company fixture fallback", async ({
    page,
  }) => {
    await page.route("**/api/assets/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: "asset-ibm",
              symbolId: "NYSE:IBM",
              symbol: "IBM",
              name: "International Business Machines Corporation",
              exchange: "NYSE",
              status: "active",
              tradable: true,
              marginable: true,
              shortable: true,
              fractionable: true,
              attributes: [],
              provider: "alpaca",
            },
          ],
          meta: {
            source: "alpaca",
            catalogAsOf: "2026-11-12T06:00:00.000Z",
            totalMatches: 1,
            freshness: { state: "stale", ageSeconds: 7_200 },
            fallbackReason: "provider_unavailable",
          },
        }),
      });
    });
    await page.route("**/api/market/snapshot?*", async (route) => {
      const symbol = new URL(route.request().url()).searchParams.get("symbol");
      if (symbol !== "NYSE:IBM") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Market data is unavailable for this symbol." }),
      });
    });
    await page.route("**/api/market/bars?*", async (route) => {
      const symbol = new URL(route.request().url()).searchParams.get("symbol");
      if (symbol !== "NYSE:IBM") return route.continue();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Historical market data is temporarily unavailable." }),
      });
    });
    await page.route("**/api/intelligence?*", async (route) => {
      const symbol = new URL(route.request().url()).searchParams.get("symbol");
      if (symbol !== "NYSE:IBM") return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [],
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage: "partial",
            coverage: "partial",
            generatedAt: "2026-11-12T08:00:00.000Z",
            freshness: { state: "fresh", asOf: null, ageSeconds: null },
            providers: [],
            notice: "No recent events.",
          },
        }),
      });
    });

    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByTestId("overview-add-stock").click();
    await page.getByTestId("stock-search-input").fill("IBM");
    await expect(page.getByText(/Catalog refresh delayed/)).toBeVisible();
    await page.getByRole("option").filter({ hasText: "IBM" }).click();

    const identity = page.locator(".symbol-header");
    await expect(identity.getByRole("heading", { name: "IBM" })).toBeVisible();
    await expect(identity).toContainText("International Business Machines Corporation");
    await expect(identity).not.toContainText("NVIDIA");
    await expect(identity).not.toContainText("NVDA");
    await expect(page.getByText("Historical data unavailable")).toBeVisible();
    await expect(page.getByText("Omnigaze View awaiting evidence")).toBeVisible();
    await expect(page.getByText(/No fixture events are substituted for IBM/)).toBeVisible();

    const preferences = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("omnigaze:dashboard-preferences") ?? "null"),
    );
    expect(preferences).toMatchObject({
      version: 2,
      selectedSymbol: "NYSE:IBM",
    });
    expect(preferences.instruments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "NYSE:IBM",
          ticker: "IBM",
          exchange: "NYSE",
          name: "International Business Machines Corporation",
        }),
      ]),
    );

    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(page.getByRole("button", { name: "Remove IBM from watchlist" })).toBeVisible();
    await expect(page.locator(".symbol-header")).toContainText("International Business Machines Corporation");
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

  test("signed-in onboarding adds account symbols without replacing local setup", async ({
    context,
    page,
  }) => {
    test.setTimeout(75_000);
    await page.goto("/signin-with-chatgpt?return_to=/onboarding");
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem(
        "omnigaze:dashboard-preferences",
        JSON.stringify({
          version: 2,
          instruments: [],
          selectedSymbol: "NASDAQ:NVDA",
          timeframe: "1M",
        }),
      );
    });
    await page.reload();

    await page.getByRole("button", { name: /MSFT Microsoft Corporation/ }).click();
    await page.getByRole("button", { name: /continue/i }).click();
    await page.getByRole("button", { name: "Skip holdings" }).click();
    await page.getByRole("button", { name: "Use neutral defaults" }).click();
    await expect(page.getByText("Ready to sync safely")).toBeVisible();

    const syncResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/onboarding/complete") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Build my dashboard" }).click();
    expect((await syncResponse).status()).toBe(200);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("button", { name: "Remove MSFT from watchlist" }),
    ).toBeVisible();

    const localPreferences = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("omnigaze:dashboard-preferences") ?? "null"),
    );
    expect(localPreferences).toMatchObject({
      version: 2,
      instruments: [],
      selectedSymbol: "NASDAQ:NVDA",
      timeframe: "1M",
    });

    const current = await context.request.get("/api/watchlists");
    const body = (await current.json()) as {
      data: Array<{ id: string; items: Array<{ symbolId: string }> }>;
    };
    for (const list of body.data) {
      if (!list.items.some((item) => item.symbolId === "NASDAQ:MSFT")) continue;
      const cleanup = await context.request.post("/api/watchlists", {
        data: {
          operation: "remove",
          watchlist_id: list.id,
          symbol_id: "NASDAQ:MSFT",
        },
      });
      expect(cleanup.status()).toBe(200);
    }
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
