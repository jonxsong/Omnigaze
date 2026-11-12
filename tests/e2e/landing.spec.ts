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
    await expect(page.locator(".chart-wrap .recharts-wrapper svg")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Rendering price history", { exact: true })).toBeHidden();
  });

  test("Ask Omnigaze opens the explicit, sign-in-gated live analysis flow", async ({
    page,
  }) => {
    let analysisRequests = 0;
    await page.route("**/api/ai/analyze", async (route) => {
      analysisRequests += 1;
      await route.abort();
    });

    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "Ask Omnigaze", exact: true }).click();

    const dialog = page.getByTestId("omnigaze-view-dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Sign in for a live evidence-backed view"),
    ).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Sign in to analyze" })).toHaveAttribute(
      "href",
      /\/signin-with-chatgpt\?return_to=%2Fdashboard/,
    );
    expect(analysisRequests).toBe(0);
  });

  test("renders a cited live Omnigaze View only after explicit analysis", async ({
    context,
    page,
  }) => {
    await page.goto("/signin-with-chatgpt?return_to=/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    const watchlistsResponse = await context.request.get("/api/watchlists");
    expect(watchlistsResponse.status()).toBe(200);
    const watchlists = (await watchlistsResponse.json()) as {
      data: Array<{
        id: string;
        isDefault: boolean;
        items: Array<{ symbolId: string }>;
      }>;
    };
    const primary =
      watchlists.data.find((watchlist) => watchlist.isDefault) ?? watchlists.data[0];
    if (!primary) throw new Error("Expected an authenticated default watchlist.");
    const addedForTest = !primary.items.some(
      ({ symbolId }) => symbolId === "NASDAQ:NVDA",
    );
    if (addedForTest) {
      const add = await context.request.post("/api/watchlists", {
        data: {
          operation: "add",
          watchlist_id: primary.id,
          symbol_id: "NASDAQ:NVDA",
        },
      });
      expect(add.status()).toBe(200);
      await page.reload();
      await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    }

    const generatedAt = "2026-11-12T18:00:02.000Z";
    let analysisRequests = 0;
    let abortNextAnalysis = false;
    let rateLimitNextAnalysis = false;
    const analysisBodies: Array<{
      symbol_id?: unknown;
      request_id?: unknown;
      locale?: unknown;
    }> = [];
    await page.route("**/api/ai/analyze", async (route) => {
      analysisRequests += 1;
      analysisBodies.push(
        (route.request().postDataJSON() ?? {}) as {
          symbol_id?: unknown;
          request_id?: unknown;
          locale?: unknown;
        },
      );
      if (abortNextAnalysis) {
        abortNextAnalysis = false;
        await route.abort("failed");
        return;
      }
      if (rateLimitNextAnalysis) {
        rateLimitNextAnalysis = false;
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: {
            "Retry-After": "120",
            "X-Omnigaze-AI-Budget-Retry-At": "2026-11-12T18:02:00.000Z",
          },
          body: JSON.stringify({
            error: "The AI analysis budget is temporarily exhausted.",
            code: "ai_rate_limited",
          }),
        });
        return;
      }
      const cacheHit = analysisRequests > 2;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            stance: "mixed",
            confidence: 0.58,
            headline: "Current evidence is mixed",
            summary: "The latest evidence contains supportive and limiting signals.",
            whyNow: "A new company update changed the evidence set.",
            drivers: [{
              label: "Company update",
              direction: "mixed",
              explanation: "The update adds current context.",
              evidenceIds: ["evidence:alpaca:news-1"],
            }],
            unknowns: ["The durability of the development remains unknown."],
          },
          meta: {
            symbolId: "NASDAQ:NVDA",
            dataCutoff: "2026-11-12T18:00:00.000Z",
            generatedAt,
            promptVersion: "2026-11-12.1:en",
            dataMode: "live",
            providerCoverage: "partial",
            freshness: {
              state: "fresh",
              asOf: "2026-11-12T17:59:00.000Z",
              ageSeconds: 60,
            },
            evidenceCount: 1,
            eventCount: 1,
            sources: ["alpaca"],
            evidenceCoverage: {
              score: 0.4,
              label: "limited",
              evidenceCount: 1,
              sourceCount: 1,
            },
            citations: [{
              id: "evidence:alpaca:news-1",
              title: "NVIDIA publishes a material update",
              publisher: "alpaca",
              publishedAt: "2026-11-12T17:59:00.000Z",
              url: "https://example.test/nvda",
              classification: "fact",
            }],
            ai: {
              source: cacheHit ? "cache" : "generated",
              deduplicated: false,
              modelConfig: "openai-agents-sdk-default",
              evidenceFingerprint: "a".repeat(64),
              cacheExpiresAt: "2026-11-12T18:05:02.000Z",
              servedAt: "2026-11-12T18:00:03.000Z",
              budget: cacheHit
                ? {
                    charged: false,
                    remaining: null,
                    limit: null,
                    resetAt: null,
                  }
                : {
                    charged: true,
                    remaining: 19,
                    limit: 20,
                    resetAt: "2026-11-13T00:00:00.000Z",
                  },
            },
            confidenceMeaning: "evidence_interpretation_not_return_probability",
            disclaimer: "Research support only. This is not investment advice.",
          },
        }),
      });
    });

    await page
      .locator(".watchlist-row")
      .filter({ hasText: "NVDA" })
      .getByRole("button")
      .first()
      .click();
    await page.getByRole("button", { name: "Ask Omnigaze", exact: true }).click();
    const dialog = page.getByTestId("omnigaze-view-dialog");
    await expect(dialog.getByText("Generate a fresh Omnigaze View")).toBeVisible();
    expect(analysisRequests).toBe(0);

    await dialog.getByRole("button", { name: "Analyze live evidence" }).click();
    await expect(dialog.getByRole("heading", { name: "Current evidence is mixed" })).toBeVisible();
    await expect(dialog.getByText("interpretation confidence")).toBeVisible();
    await expect(dialog.getByText("NVIDIA publishes a material update")).toBeVisible();
    await expect(dialog.getByText("Fresh model analysis generated")).toBeVisible();
    await expect(dialog.getByText(/19 of 20 remain/)).toBeVisible();
    expect(analysisRequests).toBe(1);
    expect(analysisBodies[0]).toMatchObject({
      symbol_id: "NASDAQ:NVDA",
      locale: "en",
    });
    expect(analysisBodies[0]?.request_id).toEqual(expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ));
    await page.screenshot({
      path: "outputs/omnigaze-live-view-desktop.png",
      fullPage: false,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const dialogOverflow = await dialog.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(dialogOverflow.scrollWidth).toBeLessThanOrEqual(dialogOverflow.clientWidth);
    await page.screenshot({
      path: "outputs/omnigaze-live-view-mobile.png",
      fullPage: false,
    });

    abortNextAnalysis = true;
    await dialog.getByRole("button", { name: "Refresh view" }).click();
    await expect(dialog.getByRole("button", { name: "Resume request safely" })).toBeVisible();
    expect(analysisBodies[1]?.request_id).not.toBe(analysisBodies[0]?.request_id);
    await dialog.getByRole("button", { name: "Resume request safely" }).click();
    await expect(dialog.getByText("Verified analysis cache reused")).toBeVisible();
    expect(analysisBodies[2]?.request_id).toBe(analysisBodies[1]?.request_id);
    rateLimitNextAnalysis = true;
    await dialog.getByRole("button", { name: "Refresh view" }).click();
    await expect(dialog.getByText(/Usage becomes available again around/)).toBeVisible();
    await expect(dialog.getByText(/not investment confidence/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Try a new analysis" })).toBeDisabled();
    expect(analysisBodies[3]?.request_id).not.toBe(analysisBodies[2]?.request_id);
    expect(analysisRequests).toBe(4);

    if (addedForTest) {
      const remove = await context.request.post("/api/watchlists", {
        data: {
          operation: "remove",
          watchlist_id: primary.id,
          symbol_id: "NASDAQ:NVDA",
        },
      });
      expect(remove.status()).toBe(200);
    }
  });

  test("data status does not present response receipt as provider evidence freshness", async ({
    page,
  }) => {
    await page.route("**/api/intelligence?*", async (route) => {
      const responseTime = new Date().toISOString();
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
            generatedAt: responseTime,
            freshness: { state: "unknown", asOf: null, ageSeconds: null },
            providers: [],
            notice: "The provider did not supply an evidence timestamp.",
          },
        }),
      });
    });

    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "View data status" }).click();

    const panel = page.getByRole("region", { name: "Source and provider status" });
    const intelligenceStatus = panel
      .getByText("Intelligence feed", { exact: true })
      .locator("..");
    await expect(intelligenceStatus).toContainText("Evidence time unavailable");
    await expect(intelligenceStatus).toContainText(/Response received (just now|\d+s ago)/);
    await expect(intelligenceStatus).not.toContainText("Evidence observed");

    const refreshPolicy = panel
      .getByText("Refresh policy", { exact: true })
      .locator("..");
    await expect(refreshPolicy).toContainText("Request-time while open");
    await expect(refreshPolicy).toContainText("requests time out safely");
    await expect(refreshPolicy).toContainText("Alerts are in-app only");
    await expect(panel.getByText("Polling policy", { exact: true })).toHaveCount(0);
  });

  test("data status labels provider observation and health-check times separately", async ({
    page,
  }) => {
    const checkedAt = new Date().toISOString();
    const observedAt = new Date(Date.parse(checkedAt) - 60_000).toISOString();
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          service: "Omnigaze web",
          status: "healthy",
          checkedAt,
          readiness: {
            ingestion: {
              mode: "scheduled",
              status: "healthy",
              expectedCadenceSeconds: 300,
              lastSuccessAt: checkedAt,
              latestEvidenceAt: observedAt,
              generatedAt: checkedAt,
              since: new Date(Date.parse(checkedAt) - 86_400_000).toISOString(),
              providers: [],
            },
          },
          providers: [
            {
              provider: "health-only-provider",
              status: "healthy",
              checkedAt,
              latestObservedAt: null,
              capabilities: ["market-news"],
              attempted: true,
            },
            {
              provider: "observed-provider",
              status: "healthy",
              checkedAt,
              latestObservedAt: observedAt,
              capabilities: ["market-news"],
              attempted: true,
            },
          ],
        }),
      });
    });

    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "View data status" }).click();

    const panel = page.getByRole("region", { name: "Source and provider status" });
    const applicationStatus = panel
      .getByText("Application API", { exact: true })
      .locator("..");
    await expect(applicationStatus).toContainText(/Health checked (just now|\d+s ago)/);

    const providerList = panel.getByLabel("Configured providers");
    const healthOnlyProvider = providerList
      .getByText("health-only-provider", { exact: true })
      .locator("..");
    await expect(healthOnlyProvider).toContainText("Evidence time unavailable");
    await expect(healthOnlyProvider).toContainText(/Health checked (just now|\d+s ago)/);
    await expect(healthOnlyProvider).not.toContainText("Evidence observed");

    const observedProvider = providerList
      .getByText("observed-provider", { exact: true })
      .locator("..");
    await expect(observedProvider).toContainText(/Evidence observed (\d+s|1m) ago/);
    await expect(observedProvider).toContainText(/Health checked (just now|\d+s ago)/);

    const ingestionStatus = panel.getByTestId("ingestion-status");
    await expect(ingestionStatus).toContainText("Scheduled · Healthy");
    await expect(ingestionStatus).toContainText("Recent collection runs completed.");
    await expect(ingestionStatus).toContainText(
      /Last success: (just now|\d+s ago)/,
    );
    await expect(ingestionStatus).toContainText(
      /Latest evidence: (\d+s|1m) ago/,
    );
    await expect(ingestionStatus).toContainText("Expected cadence: Every 5 minutes");
    await expect(ingestionStatus).toContainText(
      /Status calculated: (just now|\d+s ago)/,
    );
  });

  test("request-time collection transparency fits a mobile viewport without implying background alerts", async ({
    page,
  }) => {
    const checkedAt = new Date().toISOString();
    let ingestion = {
      mode: "request_time",
      status: "idle",
      expectedCadenceSeconds: null,
      lastSuccessAt: null,
      latestEvidenceAt: null,
      generatedAt: checkedAt,
      since: new Date(Date.parse(checkedAt) - 86_400_000).toISOString(),
      providers: [],
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/health", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          service: "Omnigaze web",
          status: ingestion.status === "unavailable" ? "degraded" : "healthy",
          checkedAt,
          readiness: {
            ingestion,
          },
          providers: [],
        }),
      });
    });

    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    await page.getByRole("button", { name: "View data status" }).click();

    const panel = page.getByRole("region", { name: "Source and provider status" });
    const ingestionStatus = panel.getByTestId("ingestion-status");
    await expect(ingestionStatus).toContainText("Request-time · Idle");
    await expect(ingestionStatus).toContainText("No collection run has completed yet.");
    await expect(ingestionStatus).toContainText(
      "Last success: No successful collection recorded",
    );
    await expect(ingestionStatus).toContainText(
      "Latest evidence: No collected evidence timestamp",
    );
    await expect(ingestionStatus).toContainText(
      "Expected cadence: No background cadence",
    );
    await expect(panel).toContainText("Request-time while open");
    await expect(panel).toContainText("Alerts are in-app only");
    await expect(panel).not.toContainText("Background alerts");

    ingestion = {
      ...ingestion,
      mode: "unavailable",
      status: "unavailable",
    };
    await panel
      .getByRole("button", { name: "Refresh displayed data and status" })
      .click();
    await expect(ingestionStatus).toContainText("Status unavailable");
    await expect(ingestionStatus).toContainText(
      "Collection status could not be read.",
    );
    await expect(ingestionStatus).toContainText("Last success: Unavailable");
    await expect(ingestionStatus).toContainText("Latest evidence: Unavailable");
    await expect(ingestionStatus).toContainText("Expected cadence: Unavailable");
    await expect(ingestionStatus).not.toContainText(
      "No successful collection recorded",
    );

    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      panel: document.querySelector("#data-status-panel")?.scrollWidth ?? 0,
      panelClient: document.querySelector("#data-status-panel")?.clientWidth ?? 0,
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.panel).toBeLessThanOrEqual(overflow.panelClient);
  });

  test("a failed quote refresh labels retained data as last known", async ({
    page,
  }) => {
    let failRefresh = false;
    await page.route("**/api/market/snapshots?*", async (route) => {
      const symbols = new URL(route.request().url()).searchParams.get("symbols");
      if (!symbols?.split(",").includes("NASDAQ:NVDA")) return route.continue();
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
          data: [{
            symbolId: "NASDAQ:NVDA",
            status: "ready",
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
          }],
          meta: {
            requestedCount: 1,
            readyCount: 1,
            errorCount: 0,
            partial: false,
            generatedAt: asOf,
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
    await page
      .getByRole("button", { name: "Refresh displayed data and status" })
      .click();

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
    await page.route("**/api/market/snapshots?*", async (route) => {
      const symbols = new URL(route.request().url()).searchParams.get("symbols");
      if (!symbols?.split(",").includes("NYSE:IBM")) return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{
            symbolId: "NYSE:IBM",
            status: "error",
            code: "market_data_unavailable",
            error: "Market data is unavailable for this symbol.",
          }],
          meta: {
            requestedCount: symbols.split(",").length,
            readyCount: 0,
            errorCount: 1,
            partial: true,
            generatedAt: new Date().toISOString(),
          },
        }),
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
    await page.route("**/api/market/snapshots?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [{
            symbolId: "NASDAQ:NVDA",
            status: "ready",
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
          }],
          meta: {
            requestedCount: 1,
            readyCount: 1,
            errorCount: 0,
            partial: false,
            generatedAt: now,
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
    await page.getByRole("button", { name: "Research scenarios", exact: true }).click();
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
