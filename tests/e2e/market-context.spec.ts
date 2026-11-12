import { expect, test } from "@playwright/test";
import {
  MARKET_CONTEXT_NOTICE,
  marketContextProxies,
} from "@/lib/market-context";

function liveEnvelope() {
  return {
    data: marketContextProxies.map((proxy, index) => ({
      ...proxy,
      status: "live",
      snapshot: {
        symbolId: proxy.symbolId,
        asOf: "2026-11-12T20:00:00.000Z",
        session: "regular",
        price: 100 + index * 10.25,
        previousClose: 99 + index * 10.25,
        change: 1,
        changePercent: index % 2 === 0 ? 1.01 : -0.72,
        volume: 1_000_000 + index,
        isDelayed: index === 0,
        delaySeconds: index === 0 ? 900 : 0,
        provider: "Alpaca iex",
        marketCoverage: "limited-exchange",
      },
    })),
    meta: {
      status: "live",
      requestedCount: 6,
      liveCount: 6,
      staleCount: 0,
      demoCount: 0,
      unavailableCount: 0,
      availabilityCoverage: "complete",
      marketCoverage: "partial",
      generatedAt: "2026-11-12T20:00:01.000Z",
      notice: MARKET_CONTEXT_NOTICE,
    },
  };
}

type ContextItemStatus = "live" | "stale" | "demo" | "unavailable";

function stateEnvelope(statuses: ContextItemStatus[]) {
  const base = liveEnvelope();
  const data = base.data.map((item, index) => {
    const status = statuses[index] ?? "unavailable";
    const proxy = marketContextProxies[index];
    if (status === "live" || status === "stale") {
      return { ...item, status };
    }
    return status === "demo"
      ? { ...proxy, status, reason: "demo_suppressed" }
      : { ...proxy, status, reason: "provider_unavailable" };
  });
  const liveCount = statuses.filter((status) => status === "live").length;
  const staleCount = statuses.filter((status) => status === "stale").length;
  const demoCount = statuses.filter((status) => status === "demo").length;
  const unavailableCount = marketContextProxies.length - liveCount - staleCount - demoCount;
  const available = liveCount + staleCount;
  return {
    data,
    meta: {
      ...base.meta,
      status:
        liveCount === marketContextProxies.length
          ? "live"
          : liveCount > 0
            ? "partial"
            : staleCount > 0
              ? "stale"
              : demoCount > 0
                ? "demo"
                : "unavailable",
      liveCount,
      staleCount,
      demoCount,
      unavailableCount,
      availabilityCoverage:
        available === marketContextProxies.length
          ? "complete"
          : available > 0
            ? "partial"
            : "none",
      marketCoverage: available > 0 ? "partial" : "none",
    },
  };
}

test.describe("provider-backed Market Pulse", () => {
  test("loads once, never invokes AI, refreshes explicitly, and localizes proxy truth", async ({
    page,
  }) => {
    let contextRequests = 0;
    let aiRequests = 0;
    await page.route("**/api/market/context", async (route) => {
      contextRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveEnvelope()),
      });
    });
    await page.route("**/api/ai/**", async (route) => {
      aiRequests += 1;
      await route.abort("failed");
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    const ticker = page.getByTestId("market-context-ticker");
    await expect(ticker).toHaveAttribute("data-status", "live");
    await expect(ticker).toContainText("LIVE ETF PROXIES");
    await expect(ticker).toContainText("SPY");
    await expect(ticker).toContainText("QQQ");
    await expect(ticker).toContainText("$100.00");
    await expect(ticker).toContainText("+1.01%");
    await expect(ticker).toContainText("-0.72%");
    await expect(ticker.locator(".ticker-time")).toHaveAttribute(
      "title",
      /not index levels, yields, volatility, or spot commodities/,
    );
    await expect(ticker.locator(".ticker-time")).toContainText("Alpaca iex");
    await expect(ticker.locator(".ticker-time")).toContainText(
      "limited-exchange coverage",
    );
    await expect(ticker.locator(".ticker-time")).toContainText(
      "provider observation",
    );
    await expect(ticker.locator(".ticker-time")).toContainText("delayed 15m");
    await expect(
      ticker.getByRole("group", { name: /SPY.*S&P 500 ETF proxy.*delayed 15m/ }),
    ).toBeVisible();
    await expect(ticker).not.toContainText("DEMO CONTEXT");
    await expect(ticker).not.toContainText("7,141.20");
    expect(contextRequests).toBe(1);
    expect(aiRequests).toBe(0);

    await page.waitForTimeout(750);
    expect(contextRequests).toBe(1);

    await page
      .getByTestId("market-overview")
      .getByRole("button", { name: "Data status", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh displayed data and status" })
      .click();
    await expect.poll(() => contextRequests).toBe(2);
    expect(aiRequests).toBe(0);

    await page
      .getByRole("group", { name: "Dashboard language" })
      .getByRole("button", { name: "中文" })
      .click();
    await expect(ticker).toHaveAttribute("aria-label", "ETF 代理提供的实时市场背景");
    await expect(ticker).toContainText("实时 ETF 代理");
    await expect(ticker.locator(".ticker-item").first()).toHaveAttribute(
      "title",
      "标普 500 ETF 代理 · 延迟 15 分钟",
    );
  });

  test("retains the last verified pulse after an explicit refresh failure on mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let fail = false;
    await page.route("**/api/market/context", async (route) => {
      if (fail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "market_context_unavailable",
            error: "Raw provider failure must not render.",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(liveEnvelope()),
      });
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const ticker = page.getByTestId("market-context-ticker");
    await expect(ticker).toHaveAttribute("data-status", "live");
    fail = true;
    await page
      .getByTestId("market-overview")
      .getByRole("button", { name: "Data status", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Refresh displayed data and status" })
      .click();
    await expect(ticker).toHaveAttribute("data-status", "error");
    await expect(ticker).toContainText("REFRESH DELAYED");
    await expect(ticker.locator(".ticker-status .status-dot")).toHaveClass(
      /stale/,
    );
    await expect(ticker).toContainText("$100.00");
    await expect(ticker).not.toContainText("Raw provider failure must not render.");

    const overflow = await ticker.evaluate((element) => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      ticker: element.scrollWidth,
      tickerWidth: element.clientWidth,
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.ticker).toBeLessThanOrEqual(overflow.tickerWidth);
  });

  test("renders partial, stale-only, demo-suppressed, and unavailable states without fabricated fallback", async ({
    page,
  }) => {
    let envelope = stateEnvelope([
      "live",
      "stale",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    await page.route("**/api/market/context", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(envelope),
      });
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    const ticker = page.getByTestId("market-context-ticker");
    await expect(ticker).toHaveAttribute("data-status", "partial");
    await expect(ticker).toContainText("PARTIAL ETF PROXIES");
    await expect(ticker.getByText("stale", { exact: true })).toBeVisible();
    await expect(
      ticker.getByRole("group", { name: /QQQ.*Nasdaq-100 ETF proxy.*stale/ }),
    ).toBeVisible();

    await page
      .getByTestId("market-overview")
      .getByRole("button", { name: "Data status", exact: true })
      .click();
    const refresh = page.getByRole("button", {
      name: "Refresh displayed data and status",
    });

    envelope = stateEnvelope(Array(6).fill("stale"));
    await refresh.click();
    await expect(ticker).toHaveAttribute("data-status", "stale");
    await expect(ticker).toContainText("STALE ETF PROXIES");

    envelope = stateEnvelope(Array(6).fill("demo"));
    await refresh.click();
    await expect(ticker).toHaveAttribute("data-status", "demo");
    await expect(ticker).toContainText("MARKET CONTEXT UNAVAILABLE");
    await expect(ticker).not.toContainText("$100.00");

    envelope = stateEnvelope(Array(6).fill("unavailable"));
    await refresh.click();
    await expect(ticker).toHaveAttribute("data-status", "unavailable");
    await expect(ticker).toContainText("MARKET CONTEXT UNAVAILABLE");
    await expect(ticker).not.toContainText("DEMO CONTEXT");
  });
});
