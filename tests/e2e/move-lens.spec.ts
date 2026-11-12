import { expect, test, type Page } from "@playwright/test";
import {
  MARKET_CONTEXT_NOTICE,
  marketContextProxies,
} from "@/lib/market-context";

type ProxyStatus = "live" | "stale" | "demo" | "unavailable";

function snapshotEnvelope(requestUrl: string, asOf: string) {
  const symbols = new URL(requestUrl).searchParams.get("symbols")?.split(",") ?? [];
  const data = symbols.map((symbol) =>
    symbol === "NASDAQ:NVDA"
      ? {
          symbolId: symbol,
          status: "ready" as const,
          data: {
            symbolId: symbol,
            asOf,
            session: "regular",
            price: 104,
            previousClose: 100,
            change: 4,
            changePercent: 4,
            volume: 1_000_000,
            marketCap: "$2.5T",
            isDelayed: false,
            delaySeconds: 0,
            provider: "Test IEX",
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
            notice: "Current provider quote.",
          },
        }
      : {
          symbolId: symbol,
          status: "error" as const,
          code: "market_data_unavailable",
          error: "Market data is unavailable for this symbol.",
        },
  );
  return {
    data,
    meta: {
      requestedCount: data.length,
      readyCount: data.filter((item) => item.status === "ready").length,
      errorCount: data.filter((item) => item.status === "error").length,
      partial: data.some((item) => item.status === "error"),
      generatedAt: asOf,
    },
  };
}

function contextEnvelope(asOf: string, statuses: ProxyStatus[] = []) {
  const data = marketContextProxies.map((proxy, index) => {
    const status = statuses[index] ?? "live";
    if (status === "demo") {
      return { ...proxy, status, reason: "demo_suppressed" as const };
    }
    if (status === "unavailable") {
      return { ...proxy, status, reason: "provider_unavailable" as const };
    }
    const move = index === 0 ? 1 : index === 1 ? 2 : 0.5;
    return {
      ...proxy,
      status,
      snapshot: {
        symbolId: proxy.symbolId,
        asOf,
        session: "regular" as const,
        price: 100 + move,
        previousClose: 100,
        change: move,
        changePercent: move,
        volume: 2_000_000 + index,
        isDelayed: false,
        delaySeconds: 0,
        provider: "Test IEX",
        marketCoverage: "limited-exchange" as const,
      },
    };
  });
  const liveCount = data.filter((item) => item.status === "live").length;
  const staleCount = data.filter((item) => item.status === "stale").length;
  const demoCount = data.filter((item) => item.status === "demo").length;
  const unavailableCount = data.length - liveCount - staleCount - demoCount;
  const available = liveCount + staleCount;
  return {
    data,
    meta: {
      status:
        liveCount === data.length
          ? "live"
          : liveCount > 0
            ? "partial"
            : staleCount > 0
              ? "stale"
              : demoCount > 0
                ? "demo"
                : "unavailable",
      requestedCount: data.length,
      liveCount,
      staleCount,
      demoCount,
      unavailableCount,
      availabilityCoverage:
        available === data.length
          ? "complete"
          : available > 0
            ? "partial"
            : "none",
      marketCoverage: available > 0 ? "partial" : "none",
      generatedAt: asOf,
      notice: MARKET_CONTEXT_NOTICE,
    },
  };
}

function intelligenceEnvelope(symbol: string, asOf: string) {
  const data =
    symbol === "NASDAQ:NVDA"
      ? [
          {
            id: "news:move-lens-governance",
            symbolIds: ["NASDAQ:NVDA"],
            source: "Licensed News Test",
            sourceKind: "licensed_news",
            headline: "NVIDIA board reviews a disputed executive disclosure",
            summary:
              "The review is current relevant evidence; it is not proof of what caused the price move.",
            publishedAt: asOf,
            receivedAt: asOf,
            sourceUrl: "https://example.test/nvda-governance",
            materiality: "high",
            isLive: true,
            category: "governance",
            claimStatus: "allegation",
            causalLink: "supported",
            topicTags: ["governance", "executive"],
            isControversial: true,
          },
        ]
      : [];
  return {
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: asOf,
      freshness: { state: "fresh", asOf, ageSeconds: 0 },
      providers: [],
      notice: "Current provider evidence.",
      readPlane: {
        strategy: "durable_plus_request_time",
        requestTimeFailed: false,
        collectedReadFailed: false,
        collectedTruncated: false,
        origins: {
          requestTime: {
            status: "live",
            candidateCount: data.length,
            selectedCount: data.length,
          },
          durable: { status: "ready", candidateCount: 0, selectedCount: 0 },
        },
      },
    },
  };
}

async function installPublicMoveLensRoutes(
  page: Page,
  getContext: () => ReturnType<typeof contextEnvelope>,
) {
  let contextRequests = 0;
  let aiRequests = 0;
  await page.route("**/api/market/context", async (route) => {
    contextRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(getContext()),
    });
  });
  await page.route("**/api/market/snapshots?**", async (route) => {
    const asOf = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshotEnvelope(route.request().url(), asOf)),
    });
  });
  await page.route("**/api/intelligence?**", async (route) => {
    const asOf = new Date().toISOString();
    const symbol = new URL(route.request().url()).searchParams.get("symbol") ?? "";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(intelligenceEnvelope(symbol, asOf)),
    });
  });
  await page.route("**/api/ai/**", async (route) => {
    aiRequests += 1;
    await route.abort("failed");
  });
  return {
    contextRequests: () => contextRequests,
    aiRequests: () => aiRequests,
  };
}

test.describe("Move Lens", () => {
  test("shares one context load, renders truth metadata, localizes, and retains verified context after refresh failure", async ({
    page,
  }) => {
    const asOf = new Date().toISOString();
    let failContext = false;
    let contextRequests = 0;
    let aiRequests = 0;
    await page.route("**/api/market/context", async (route) => {
      contextRequests += 1;
      if (failContext) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "market_context_unavailable",
            error: "Raw upstream detail must not render.",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(contextEnvelope(asOf)),
      });
    });
    await page.route("**/api/market/snapshots?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshotEnvelope(route.request().url(), asOf)),
      });
    });
    await page.route("**/api/intelligence?**", async (route) => {
      const symbol = new URL(route.request().url()).searchParams.get("symbol") ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(intelligenceEnvelope(symbol, asOf)),
      });
    });
    await page.route("**/api/ai/**", async (route) => {
      aiRequests += 1;
      await route.abort("failed");
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    const card = page.getByTestId("move-lens-card");
    await expect(card).toHaveAttribute("data-status", "complete");
    await expect(card.getByText("NVDA versus market proxies")).toBeVisible();
    await expect(card.getByText("+4.00%", { exact: true })).toBeVisible();
    await expect(card.getByText("+3.00 pts", { exact: true })).toBeVisible();
    await expect(card.getByText("+2.00 pts", { exact: true })).toBeVisible();
    await expect(card.getByText("S&P 500 ETF proxy", { exact: true })).toBeVisible();
    await expect(card.getByText("Nasdaq-100 ETF proxy", { exact: true })).toBeVisible();
    await expect(card.getByText("Test IEX", { exact: false }).first()).toBeVisible();
    await expect(card.getByText("Latest relevant evidence")).toBeVisible();
    await expect(card.getByText("Allegation", { exact: true })).toBeVisible();
    await expect(card.getByText("Causal link unassessed", { exact: true })).toBeVisible();
    await expect(card.getByText("Supported contributor", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Plausible contributor", { exact: true })).toHaveCount(0);
    await expect(card.getByText("Controversial", { exact: true })).toBeVisible();
    await expect(
      card.getByRole("link", {
        name: "Open source: NVIDIA board reviews a disputed executive disclosure",
      }),
    ).toHaveAttribute("href", "https://example.test/nvda-governance");
    await expect(card).toContainText(
      "correlation and context, not proof of causation",
    );
    const timeline = page.locator(".event-list");
    await expect(timeline.getByText("Governance", { exact: true })).toBeVisible();
    await expect(timeline.getByText("Allegation", { exact: true })).toBeVisible();
    await expect(timeline.getByText("Supported contributor", { exact: true })).toBeVisible();
    await expect(timeline.getByText("Controversial", { exact: true })).toBeVisible();
    expect(contextRequests).toBe(1);
    expect(aiRequests).toBe(0);

    await page
      .getByRole("group", { name: "Dashboard language" })
      .getByRole("button", { name: "中文" })
      .click();
    await expect(card.getByText("走势透镜", { exact: true })).toBeVisible();
    await expect(card.getByText("标普 500 ETF 代理", { exact: true })).toBeVisible();
    await expect(card).toContainText("并不能证明因果关系");
    await expect(card).toContainText(
      "NVIDIA board reviews a disputed executive disclosure",
    );
    expect(contextRequests).toBe(1);

    await page.locator(".watchlist-row .watchlist-select").nth(1).click();
    await expect(card).toContainText("MSFT");
    expect(contextRequests).toBe(1);
    await page.locator(".watchlist-row .watchlist-select").first().click();
    await expect(card).toContainText("NVDA");
    expect(contextRequests).toBe(1);

    failContext = true;
    await page
      .getByTestId("market-overview")
      .getByRole("button", { name: "数据状态", exact: true })
      .click();
    await page
      .getByRole("button", { name: "刷新显示的数据和状态" })
      .click();
    await expect.poll(() => contextRequests).toBe(2);
    await expect(card).toHaveAttribute("data-status", "refresh-delayed");
    await expect(card.getByText("刷新延迟", { exact: true })).toBeVisible();
    await expect(card.getByText("+3.00 个百分点", { exact: true })).toBeVisible();
    await expect(card).not.toContainText("Raw upstream detail must not render.");
    expect(aiRequests).toBe(0);
  });

  test("withholds stale and demo comparisons and remains overflow-safe on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const asOf = new Date().toISOString();
    let envelope = contextEnvelope(asOf, [
      "live",
      "stale",
      "demo",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    const counters = await installPublicMoveLensRoutes(page, () => envelope);

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const card = page.getByTestId("move-lens-card");
    await expect(card).toHaveAttribute("data-status", "partial");
    await expect(card.getByText("+3.00 pts", { exact: true })).toBeVisible();
    await expect(card.getByText("Comparison withheld", { exact: true })).toBeVisible();
    await expect(card).toContainText("stale or not current");
    await expect(card).not.toContainText("+2.00 pts");
    expect(counters.contextRequests()).toBe(1);
    expect(counters.aiRequests()).toBe(0);

    const ticker = page.getByTestId("market-context-ticker");
    await expect(ticker.locator(".ticker-item strong").first()).toBeVisible();
    await expect(ticker.locator(".ticker-item strong").nth(1)).toBeVisible();
    await expect(ticker.locator(".ticker-item strong").first()).toHaveText("SPY");
    await expect(ticker.locator(".ticker-item strong").nth(1)).toHaveText("QQQ");

    const overflow = await card.evaluate((element) => ({
      card: element.scrollWidth,
      cardWidth: element.clientWidth,
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    expect(overflow.card).toBeLessThanOrEqual(overflow.cardWidth);
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);

    envelope = contextEnvelope(asOf, Array(6).fill("demo"));
    await page
      .getByTestId("market-overview")
      .getByRole("button", { name: "Data status", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh displayed data and status" })
      .click();
    await expect.poll(() => counters.contextRequests()).toBe(2);
    await expect(card).toContainText("Illustrative fixture values are never used");
    await expect(card.getByText("Comparison withheld", { exact: true })).toHaveCount(2);
    expect(counters.aiRequests()).toBe(0);
  });
});
