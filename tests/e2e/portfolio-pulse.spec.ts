import { expect, test } from "@playwright/test";

type Holding = {
  symbolId: string;
  quantity: string;
  averageCost: string | null;
  costCurrency: string;
  quantityAsOf: string;
  version: number;
};

function snapshotEnvelope(requestUrl: string, asOf: string) {
  const symbols = new URL(requestUrl).searchParams.get("symbols")?.split(",") ?? [];
  const data = symbols.map((symbol) =>
    symbol === "NASDAQ:NVDA"
      ? {
          symbolId: symbol,
          status: "ready",
          data: {
            symbolId: symbol,
            asOf,
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
            generatedAt: asOf,
            freshness: { state: "fresh", asOf, ageSeconds: 0 },
            providers: [],
            notice: "Live provider data.",
          },
        }
      : {
          symbolId: symbol,
          status: "error",
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

test.describe("Portfolio Pulse", () => {
  test("calculates a signed-out device-local holding without calling the owner API", async ({
    page,
  }) => {
    const asOf = new Date().toISOString();
    let ownerPulseRequests = 0;
    await page.route("**/api/portfolio/pulse", async (route) => {
      ownerPulseRequests += 1;
      await route.abort();
    });
    await page.route("**/api/market/snapshots?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshotEnvelope(route.request().url(), asOf)),
      });
    });
    await page.addInitScript((completedAt) => {
      const extraSymbols = Array.from(
        { length: 8 },
        (_, index) => `NASDAQ:T${index.toString().padStart(2, "0")}`,
      );
      localStorage.setItem(
        "omnigaze:onboarding-draft",
        JSON.stringify({
          version: 2,
          currentStep: 3,
          highestStep: 3,
          symbols: ["NASDAQ:NVDA", ...extraSymbols],
          instruments: [
            {
              id: "NASDAQ:NVDA",
              ticker: "NVDA",
              exchange: "NASDAQ",
              name: "NVIDIA Corporation",
              sector: "Technology",
              currency: "USD",
            },
            ...extraSymbols.map((symbol, index) => ({
              id: symbol,
              ticker: `T${index.toString().padStart(2, "0")}`,
              exchange: "NASDAQ",
              name: `Test Holding ${index}`,
              sector: "Technology",
              currency: "USD",
            })),
          ],
          positions: [
            {
              symbolId: "NASDAQ:NVDA",
              owned: true,
              shares: "15",
              averageCost: "147.25",
            },
            ...extraSymbols.map((symbol) => ({
              symbolId: symbol,
              owned: true,
              shares: "1",
              averageCost: "10",
            })),
          ],
          goals: ["portfolio-context"],
          horizon: "one-three-years",
          riskProfile: "balanced",
          liquidityNeed: "prefer-not-to-say",
          holdingsSkipped: false,
          preferencesSkipped: false,
          updatedAt: completedAt,
          completedAt,
        }),
      );
    }, asOf);

    await page.goto("/dashboard");
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    const pulse = page.getByTestId("portfolio-pulse");
    await expect(pulse.getByText("$2,400.00", { exact: true }).first()).toBeVisible();
    await expect(pulse.getByText("15", { exact: true })).toBeVisible();
    await expect(pulse).toContainText("Limited-exchange coverage");
    const showAll = pulse.getByRole("button", {
      name: "Show all 9 position rows",
    });
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
    await expect(pulse.getByTestId("portfolio-pulse-position-T07")).toHaveCount(0);
    await showAll.click();
    await expect(showAll).toHaveCount(0);
    const showLess = pulse.getByRole("button", {
      name: "Show fewer position rows",
    });
    await expect(showLess).toHaveAttribute("aria-expanded", "true");
    await expect(pulse.getByTestId("portfolio-pulse-position-T07")).toBeVisible();
    await expect(
      pulse
        .getByTestId("portfolio-pulse-position-NVDA")
        .locator('th[scope="row"]'),
    ).toHaveCount(1);
    await showLess.click();
    await expect(pulse.getByTestId("portfolio-pulse-position-T07")).toHaveCount(0);
    await page.getByRole("button", { name: "中文" }).click();
    await expect(
      pulse.getByRole("button", { name: "显示全部 9 个持仓行" }),
    ).toBeVisible();
    expect(ownerPulseRequests).toBe(0);
  });

  test("shows exact authenticated position impact in English and Chinese", async ({
    context,
    page,
  }) => {
    test.setTimeout(75_000);
    await page.goto("/signin-with-chatgpt?return_to=/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);

    const portfolioResponse = await context.request.get("/api/portfolio");
    expect(portfolioResponse.status()).toBe(200);
    const portfolio = (await portfolioResponse.json()) as {
      data: { holdings: Holding[] };
    };
    const original = portfolio.data.holdings.find(
      ({ symbolId }) => symbolId === "NASDAQ:NVDA",
    );
    const mutation = await context.request.put(
      "/api/portfolio/holdings/NASDAQ%3ANVDA",
      {
        data: {
          quantity: "15",
          average_cost: "147.25",
          cost_currency: "USD",
          quantity_as_of: new Date().toISOString(),
          expected_version: original?.version ?? 0,
        },
      },
    );
    expect(mutation.status()).toBe(200);
    const mutated = (await mutation.json()) as { data: { version: number } };

    const asOf = new Date().toISOString();
    let ownerPulseRequests = 0;
    await page.route("**/api/portfolio/pulse", async (route) => {
      ownerPulseRequests += 1;
      await route.abort();
    });
    await page.route("**/api/market/snapshots?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshotEnvelope(route.request().url(), asOf)),
      });
    });

    try {
      await page.reload();
      await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

      const pulse = page.getByTestId("portfolio-pulse");
      await expect(pulse).toBeVisible();
      await expect(
        pulse.getByRole("heading", { name: "What moved your money today" }),
      ).toBeVisible();
      await expect(
        pulse.getByText("$2,400.00", { exact: true }).first(),
      ).toBeVisible();
      await expect(pulse.getByText("+$30.00", { exact: true }).first()).toBeVisible();
      await expect(pulse.getByText("+1.27%", { exact: true })).toBeVisible();
      await expect(
        pulse.getByText("+$191.25", { exact: true }).first(),
      ).toBeVisible();
      await expect(pulse).toContainText("1 of 1 positions covered");
      await expect(pulse).toContainText("Alpaca iex quotes");
      const selectPosition = pulse
        .getByTestId("portfolio-pulse-position-NVDA")
        .getByRole("button", { name: "Select NVDA in the dashboard" });
      await expect(selectPosition).toBeVisible();
      await selectPosition.focus();
      await selectPosition.press("Enter");
      const selectedHeading = page.locator("#market-symbol-detail h2");
      await expect(selectedHeading).toContainText("NVDA");
      await expect(selectedHeading).toBeFocused();

      await page.getByRole("button", { name: "中文" }).click();
      await expect(
        pulse.getByRole("heading", { name: "今天是什么推动了你的资产变化" }),
      ).toBeVisible();
      await expect(pulse).toContainText("已覆盖 1/1 个持仓");

      await page.setViewportSize({ width: 390, height: 844 });
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
      expect(ownerPulseRequests).toBe(0);
    } finally {
      if (original) {
        const restore = await context.request.put(
          "/api/portfolio/holdings/NASDAQ%3ANVDA",
          {
            data: {
              quantity: original.quantity,
              average_cost: original.averageCost,
              cost_currency: "USD",
              quantity_as_of: original.quantityAsOf,
              expected_version: mutated.data.version,
            },
          },
        );
        expect(restore.status()).toBe(200);
      } else {
        const remove = await context.request.delete(
          `/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=${mutated.data.version}`,
        );
        expect(remove.status()).toBe(200);
      }
    }
  });
});
