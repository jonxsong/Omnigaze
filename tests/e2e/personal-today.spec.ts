import { expect, test } from "@playwright/test";

function event(
  id: string,
  headline: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    symbolIds: ["NASDAQ:NVDA"],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline,
    summary: `Evidence summary for ${headline}.`,
    publishedAt: "2026-11-12T17:30:00.000Z",
    receivedAt: "2026-11-12T17:30:01.000Z",
    sourceUrl: `https://example.test/${id}`,
    materiality: "medium",
    isLive: true,
    category: "market",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["governance"],
    isControversial: false,
    ...overrides,
  };
}

function todayEnvelope() {
  return {
    watchlists: [
      {
        id: "watchlist-default",
        name: "Core holdings",
        isDefault: true,
        itemCount: 1,
      },
    ],
    symbols: ["NASDAQ:NVDA"],
    data: [
      event("corrected", "NVIDIA updates its governance disclosure", {
        materiality: "high",
        providerUpdatedAt: "2026-11-12T17:55:00.000Z",
        claimStatus: "corrected",
        isControversial: true,
      }),
      event("second", "NVIDIA publishes a new infrastructure update"),
      event("third", "Regulators request additional company information", {
        materiality: "critical",
        category: "regulatory",
      }),
      event("fourth", "A supplier expands capacity for a new platform"),
      event("fifth", "This fifth development remains behind the card limit"),
    ],
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: "2026-11-12T18:00:00.000Z",
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      providers: [],
      fallbackReason: "provider_request_failed",
      notice: "Raw provider notice that the card must not render.",
      readPlane: {
        strategy: "durable_plus_request_time",
        requestTimeFailed: true,
        collectedReadFailed: false,
        collectedTruncated: false,
        origins: {
          requestTime: { status: "failed", candidateCount: 0, selectedCount: 0 },
          durable: { status: "ready", candidateCount: 5, selectedCount: 5 },
        },
      },
      scope: "personal",
      status: "ready",
    },
  };
}

function staleEnvelope() {
  const envelope = todayEnvelope();
  return {
    ...envelope,
    data: [event("stale", "NVIDIA publishes an older provider update")],
    meta: {
      ...envelope.meta,
      fallbackReason: undefined,
      freshness: {
        state: "stale",
        asOf: "2026-11-10T17:59:00.000Z",
        ageSeconds: 172_860,
      },
      readPlane: {
        ...envelope.meta.readPlane,
        requestTimeFailed: false,
        origins: {
          requestTime: { status: "live", candidateCount: 1, selectedCount: 1 },
          durable: { status: "ready", candidateCount: 0, selectedCount: 0 },
        },
      },
    },
  };
}

function unavailableEnvelope() {
  const envelope = todayEnvelope();
  return {
    ...envelope,
    data: [],
    meta: {
      ...envelope.meta,
      freshness: { state: "unknown", asOf: null, ageSeconds: null },
      readPlane: {
        ...envelope.meta.readPlane,
        requestTimeFailed: true,
        origins: {
          requestTime: { status: "failed", candidateCount: 0, selectedCount: 0 },
          durable: { status: "ready", candidateCount: 0, selectedCount: 0 },
        },
      },
    },
  };
}

test.describe("Today across your watchlist", () => {
  test("makes no owner or AI request for an anonymous mobile visitor", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let todayRequests = 0;
    let aiRequests = 0;
    await page.route("**/api/intelligence/today?limit=12", async (route) => {
      todayRequests += 1;
      await route.abort("failed");
    });
    await page.route("**/api/ai/**", async (route) => {
      aiRequests += 1;
      await route.abort("failed");
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    const card = page.getByTestId("personal-today-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Sign in to see your cross-watchlist Today feed")).toBeVisible();
    await expect(card.getByText("No AI request", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Sign in for Today" })).toHaveAttribute(
      "href",
      /\/signin-with-chatgpt\?return_to=%2Fdashboard/,
    );
    expect(todayRequests).toBe(0);
    expect(aiRequests).toBe(0);

    const overflow = await card.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
  });

  test("loads once, preserves source truth, refreshes explicitly, and keeps verified data on failure", async ({
    page,
  }) => {
    let todayRequests = 0;
    let aiRequests = 0;
    let failNext = false;
    await page.route("**/api/intelligence/today?limit=12", async (route) => {
      todayRequests += 1;
      if (failNext) {
        failNext = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "intelligence_unavailable",
            error: "Arbitrary upstream detail that must not render.",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(todayEnvelope()),
      });
    });
    await page.route("**/api/ai/**", async (route) => {
      aiRequests += 1;
      await route.abort("failed");
    });

    await page.goto("/signin-with-chatgpt?return_to=/dashboard", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    const card = page.getByTestId("personal-today-card");

    await expect(
      card.getByRole("heading", { name: "NVIDIA updates its governance disclosure" }),
    ).toBeVisible();
    await expect(card.getByText("4 of 5 developments")).toBeVisible();
    await expect(card.getByText("This fifth development remains behind the card limit")).toHaveCount(0);
    await expect(card.getByText("Retained provider evidence")).toBeVisible();
    await expect(card.getByText("Corrected", { exact: true })).toBeVisible();
    await expect(card.getByText("Controversial", { exact: true })).toBeVisible();
    await expect(card.getByText("Raw provider notice that the card must not render.")).toHaveCount(0);
    await expect(
      card.getByRole("link", {
        name: "Open source: NVIDIA updates its governance disclosure",
      }),
    ).toHaveAttribute("href", "https://example.test/corrected");
    expect(todayRequests).toBe(1);
    expect(aiRequests).toBe(0);

    await page.waitForTimeout(750);
    expect(todayRequests).toBe(1);

    await card.getByRole("button", { name: "Open NVDA in the market workspace" }).first().click();
    await expect(page.locator("#market-symbol-detail h2")).toHaveText("NVDA");

    await page
      .getByTestId("market-overview")
      .getByRole("button", { name: "Data status", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh displayed data and status" })
      .click();
    await expect.poll(() => todayRequests).toBe(2);

    failNext = true;
    await card.getByRole("button", { name: "Refresh Today" }).click();
    await expect(card.getByText("Refresh delayed")).toBeVisible();
    await expect(
      card.getByRole("heading", { name: "NVIDIA updates its governance disclosure" }),
    ).toBeVisible();
    await expect(card.getByText("Arbitrary upstream detail that must not render.")).toHaveCount(0);
    expect(todayRequests).toBe(3);
    expect(aiRequests).toBe(0);

    await page
      .getByRole("group", { name: "Dashboard language" })
      .getByRole("button", { name: "中文" })
      .click();
    await expect(card.getByRole("heading", { name: "自选股今日动态" })).toBeVisible();
    await expect(
      card.getByRole("heading", { name: "NVIDIA updates its governance disclosure" }),
    ).toBeVisible();
    await expect(card.getByText("标题与来源文字保留原始语言。")).toBeVisible();

    await card.getByRole("button", { name: "打开情报收件箱" }).click();
    await expect(page.getByTestId("intelligence-inbox-drawer")).toBeVisible();
  });

  test("labels stale evidence and does not present a failed empty read as verified empty", async ({
    page,
  }) => {
    let response: ReturnType<typeof staleEnvelope> | ReturnType<typeof unavailableEnvelope> =
      staleEnvelope();
    await page.route("**/api/intelligence/today?limit=12", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    });

    await page.goto("/signin-with-chatgpt?return_to=/dashboard", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/dashboard$/);
    const card = page.getByTestId("personal-today-card");

    await expect(card.getByText("Stale provider evidence")).toBeVisible();
    await expect(
      card.getByRole("heading", { name: "NVIDIA publishes an older provider update" }),
    ).toBeVisible();

    response = unavailableEnvelope();
    await card.getByRole("button", { name: "Refresh Today" }).click();
    await expect(card.getByText("Current evidence could not be verified")).toBeVisible();
    await expect(card.getByText("No recent matching evidence")).toHaveCount(0);
    await expect(card.getByText("Provider evidence", { exact: true })).toHaveCount(0);
  });
});
