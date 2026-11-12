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
      name: /evidence refreshes with you/i,
    });
    await expect(step).toHaveAttribute("aria-expanded", "false");
    await step.click();
    await expect(step).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("region", { name: /evidence refreshes with you/i }),
    ).toContainText("Request-time provider pipeline");
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
    await expect(page.locator(".demo-banner.empty")).toContainText(
      "Add a stock to start provider-backed market and intelligence monitoring.",
    );
    await expect(page.locator(".overview-metrics")).toContainText(
      "0 material events",
    );
    await expect(page.locator(".watchlist-summary")).toContainText(
      /0\s*material events/,
    );

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
    await expect(verifyPage.locator(".overview-metrics")).toContainText(
      "0 material events",
    );
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

  test("signed-in positions reconcile conflicts and remove without untracking", async ({
    browser,
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    await page.goto("/signin-with-chatgpt?return_to=/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);

    const currentPortfolio = await context.request.get("/api/portfolio");
    expect(currentPortfolio.status()).toBe(200);
    const portfolioBody = (await currentPortfolio.json()) as {
      data: { holdings: Array<{ symbolId: string; version: number }> };
    };
    const existing = portfolioBody.data.holdings.find(
      ({ symbolId }) => symbolId === "NASDAQ:NVDA",
    );
    if (existing) {
      const cleanup = await context.request.delete(
        `/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=${existing.version}`,
      );
      expect([200, 404]).toContain(cleanup.status());
    }

    const seed = await context.request.put(
      "/api/portfolio/holdings/NASDAQ%3ANVDA",
      {
        data: {
          quantity: "1",
          average_cost: null,
          cost_currency: "USD",
          quantity_as_of: new Date().toISOString(),
          expected_version: 0,
        },
      },
    );
    expect(seed.status()).toBe(200);
    const seedBody = (await seed.json()) as { data: { version: number } };
    const unseed = await context.request.delete(
      `/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=${seedBody.data.version}`,
    );
    expect(unseed.status()).toBe(200);

    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "Add position" }).click();
    const workspaceA = page.getByTestId("portfolio-workspace");
    await workspaceA.getByLabel("Shares owned").fill("15");
    await workspaceA.getByLabel(/Average cost per share/).fill("147.25");
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/portfolio/holdings/") &&
        response.request().method() === "PUT",
    );
    await workspaceA.getByRole("button", { name: "Save position" }).click();
    expect((await createResponse).status()).toBe(200);
    await expect(workspaceA.getByText("Position saved to your account.")).toBeVisible();

    const authCookies = await context.cookies();
    const contextB = await browser.newContext({
      storageState: { cookies: authCookies, origins: [] },
    });
    const pageB = await contextB.newPage();
    await pageB.goto(`${new URL(page.url()).origin}/dashboard`);
    await expect(pageB.locator("main")).toHaveAttribute("data-hydrated", "true");
    await pageB.getByRole("button", { name: /Own 15 shares/ }).click();
    const workspaceB = pageB.getByTestId("portfolio-workspace");
    await workspaceB.getByLabel("Shares owned").fill("16");
    const updateResponse = pageB.waitForResponse(
      (response) =>
        response.url().includes("/api/portfolio/holdings/") &&
        response.request().method() === "PUT",
    );
    await workspaceB.getByRole("button", { name: "Save changes" }).click();
    expect((await updateResponse).status()).toBe(200);
    await expect(workspaceB.getByText("Position saved to your account.")).toBeVisible();

    await workspaceA.getByLabel("Shares owned").fill("17");
    const conflictResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/portfolio/holdings/") &&
        response.request().method() === "PUT",
    );
    await workspaceA.getByRole("button", { name: "Save changes" }).click();
    expect((await conflictResponse).status()).toBe(409);
    await expect(workspaceA.getByText("This position changed elsewhere.")).toBeVisible();
    await expect(workspaceA.getByLabel("Shares owned")).toHaveValue("17");
    await workspaceA.getByRole("button", { name: "Load latest position" }).click();
    await expect(workspaceA.getByLabel("Shares owned")).toHaveValue("16");

    await workspaceB.getByRole("button", { name: "Remove position" }).click();
    const deleteResponse = pageB.waitForResponse(
      (response) =>
        response.url().includes("/api/portfolio/holdings/") &&
        response.request().method() === "DELETE",
    );
    await workspaceB.getByRole("button", { name: "Remove", exact: true }).click();
    expect((await deleteResponse).status()).toBe(200);
    await expect(
      workspaceB.getByText("Position removed. The stock remains on your watchlist."),
    ).toBeVisible();
    await contextB.close();

    await page.getByRole("button", { name: "Close workspace" }).click();
    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await expect(
      page.getByRole("button", { name: "Remove NVDA from watchlist" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add position" })).toBeVisible();
  });

  test("research scenarios render evidence gates and cited review checkpoints", async ({
    context,
    page,
  }) => {
    test.setTimeout(75_000);
    await page.goto("/signin-with-chatgpt?return_to=/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);

    const portfolio = await context.request.get("/api/portfolio");
    const portfolioBody = (await portfolio.json()) as {
      data: { holdings: Array<{ symbolId: string; version: number }> };
    };
    const existing = portfolioBody.data.holdings.find(
      ({ symbolId }) => symbolId === "NASDAQ:NVDA",
    );
    if (existing) {
      await context.request.delete(
        `/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=${existing.version}`,
      );
    }
    const watchlists = await context.request.get("/api/watchlists");
    const watchlistBody = (await watchlists.json()) as {
      data: Array<{ items: Array<{ symbolId: string }> }>;
    };
    if (
      !watchlistBody.data.some((list) =>
        list.items.some(({ symbolId }) => symbolId === "NASDAQ:NVDA"),
      )
    ) {
      const seed = await context.request.put(
        "/api/portfolio/holdings/NASDAQ%3ANVDA",
        {
          data: {
            quantity: "1",
            average_cost: null,
            cost_currency: "USD",
            quantity_as_of: new Date().toISOString(),
            expected_version: 0,
          },
        },
      );
      expect(seed.status()).toBe(200);
      const seedBody = (await seed.json()) as { data: { version: number } };
      expect(
        (
          await context.request.delete(
            `/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=${seedBody.data.version}`,
          )
        ).status(),
      ).toBe(200);
    }

    const now = new Date().toISOString();
    await page.route("**/api/market/snapshot?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            symbolId: "NASDAQ:NVDA",
            asOf: now,
            session: "regular",
            price: 160,
            previousClose: 158,
            change: 2,
            changePercent: 1.27,
            volume: 1_000,
            marketCap: "Unavailable",
            isDelayed: false,
            delaySeconds: 0,
            provider: "Alpaca iex",
            marketCoverage: "limited-exchange",
          },
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage: "partial",
            coverage: "partial",
            generatedAt: now,
            freshness: { state: "fresh", asOf: now, ageSeconds: 0 },
            providers: [],
            notice: "Live provider data.",
          },
        }),
      });
    });

    let eligible = false;
    await page.route("**/api/portfolio/decision-support", async (route) => {
      const decision = eligible
        ? {
            eligible: true,
            symbolId: "NASDAQ:NVDA",
            asOf: now,
            preset: "tight",
            zones: [
              {
                kind: "pullback_review",
                priceMicros: 150_125_000,
                distanceBps: -300,
                explanation: "Review whether the evidence still supports the thesis.",
              },
            ],
            positionScenarios: [
              {
                kind: "add",
                label: "25% of entered budget",
                quantityMicros: 1_250_000,
                fractionBps: 2_500,
                basis: "user_budget",
              },
            ],
            evidenceConfidence: {
              score: 0.65,
              label: "moderate",
              meaning: "Evidence coverage only.",
              evidenceIds: ["news-1", "filing-1"],
            },
            assumptions: ["This review range is not a forecast."],
            tradeExecutionAllowed: false,
            modelOutputRole: "scenario_math_only",
          }
        : {
            eligible: false,
            symbolId: "NASDAQ:NVDA",
            suppressedReasons: ["insufficient_evidence"],
            tradeExecutionAllowed: false,
            modelOutputRole: "scenario_math_only",
          };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            decision,
            context: {
              horizon: "near_term",
              hasHolding: false,
              holding: null,
              evidenceCount: eligible ? 2 : 1,
              independentSourceCount: eligible ? 2 : 1,
              providerStreamCount: eligible ? 2 : 1,
              evidence: eligible
                ? [
                    {
                      id: "news-1",
                      headline: "Material company update",
                      source: "alpaca",
                      sourceKind: "licensed_news",
                      publishedAt: now,
                      sourceUrl: "https://example.test/news-1",
                      materiality: "high",
                    },
                    {
                      id: "filing-1",
                      headline: "Quarterly filing update",
                      source: "sec-edgar",
                      sourceKind: "sec_filing",
                      publishedAt: now,
                      sourceUrl: "https://example.test/filing-1",
                      materiality: "high",
                    },
                  ]
                : [],
              quote: {
                price: 160,
                asOf: now,
                freshUntil: new Date(Date.parse(now) + 20 * 60 * 1_000).toISOString(),
                provider: "Alpaca iex",
                marketCoverage: "limited-exchange",
                isDelayed: false,
                delaySeconds: 0,
              },
            },
          },
          meta: {
            purpose: "research_scenarios",
            tradeExecutionAllowed: false,
            generatedAt: now,
          },
        }),
      });
    });

    await page.reload();
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page
      .locator(".watchlist-row")
      .filter({ hasText: "NVDA" })
      .getByRole("button")
      .first()
      .click();
    await expect(page.locator(".demo-banner.provider")).toBeVisible();
    await page.getByRole("button", { name: "Ask Omnigaze", exact: true }).click();
    const workspace = page.getByTestId("portfolio-workspace");
    await workspace.getByRole("button", { name: "Check evidence & calculate" }).click();
    const output = workspace.getByTestId("decision-support-state");
    await expect(output.getByText("Numbers withheld by the evidence gate")).toBeVisible();
    await expect(output.getByText(/At least two attributable evidence items/)).toBeVisible();
    await expect(output).not.toContainText("$150.13");

    eligible = true;
    await workspace.getByRole("radio", { name: "Tight" }).check();
    await workspace.getByLabel(/Hypothetical USD budget/).fill("1000");
    await workspace.getByRole("button", { name: "Check evidence & calculate" }).click();
    await expect(output.getByText("$150.13")).toBeVisible();
    await expect(output.getByText("1.25 shares")).toBeVisible();
    await expect(output.getByText("Material company update")).toBeVisible();
    await expect(output.getByText("evidence coverage", { exact: true })).toBeVisible();
    await expect(workspace.getByText(/No trade execution/)).toBeVisible();
    await page.screenshot({
      path: "outputs/portfolio-workspace-desktop.png",
      fullPage: false,
    });
  });
});
