import { expect, test } from "@playwright/test";

function dailyBriefEnvelope(cacheState: "generated" | "hit" = "generated") {
  return {
    data: {
      briefDate: "2026-11-12",
      window: {
        since: "2026-11-11T18:00:00.000Z",
        through: "2026-11-12T18:00:00.000Z",
      },
      headline: "AI infrastructure and cloud demand shape today’s watchlist",
      summary:
        "Fresh company and regulatory evidence creates a mixed setup across NVIDIA and Microsoft; Apple was not represented in this bounded brief.",
      developments: [
        {
          title: "NVIDIA addresses a new export-policy constraint",
          whyItMatters:
            "The restriction could change near-term data-center expectations, while management’s response adds important context to the market reaction.",
          direction: "mixed",
          symbolIds: ["NASDAQ:NVDA"],
          evidenceIds: ["evidence:news-nvda"],
        },
        {
          title: "Microsoft reports sustained cloud AI demand",
          whyItMatters:
            "The update supports infrastructure demand but does not establish how long the current spending cycle will persist.",
          direction: "positive",
          symbolIds: ["NASDAQ:MSFT"],
          evidenceIds: ["evidence:filing-msft"],
        },
      ],
      watchNext: [
        "Watch for formal export-policy guidance and company confirmation.",
        "Compare the next cloud growth update with capital-spending guidance.",
      ],
      unknowns: [
        "The durability of the market response cannot yet be established.",
      ],
    },
    meta: {
      dataMode: "live",
      providerCoverage: "partial",
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      trackedSymbolCount: 3,
      trackedSymbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT", "NASDAQ:AAPL"],
      includedSymbolCount: 2,
      omittedSymbolCount: 1,
      evidenceCount: 2,
      sourceCount: 2,
      evidenceCoverage: { score: 0.68, label: "moderate" },
      citations: [
        {
          id: "evidence:news-nvda",
          title: "NVIDIA comments on updated export policy",
          publisher: "Reuters",
          publishedAt: "2026-11-12T17:59:00.000Z",
          url: "https://example.test/nvda-policy",
          symbolIds: ["NASDAQ:NVDA"],
          materiality: "high",
          claimStatus: "reported",
          isControversial: true,
        },
        {
          id: "evidence:filing-msft",
          title: "Microsoft publishes its latest cloud update",
          publisher: "SEC EDGAR",
          publishedAt: "2026-11-12T17:58:00.000Z",
          url: "https://example.test/msft-cloud",
          symbolIds: ["NASDAQ:MSFT"],
          materiality: "medium",
          claimStatus: "confirmed",
          isControversial: false,
        },
      ],
      promptVersion: "daily-brief-2026-11-12.1",
      generatedAt: "2026-11-12T18:00:02.000Z",
      cache: {
        state: cacheState,
        cachedAt: "2026-11-12T18:00:02.000Z",
        expiresAt: "2026-11-12T18:15:02.000Z",
      },
      budget:
        cacheState === "generated"
          ? {
              consumed: true,
              remaining: 4,
              limit: 5,
              resetsAt: "2026-11-13T00:00:00.000Z",
            }
          : {
              consumed: false,
              remaining: null,
              limit: null,
              resetsAt: null,
            },
      confidenceMeaning: "evidence_synthesis_not_return_probability",
      disclaimer: "Research support only. This is not investment advice.",
    },
  };
}

function chineseDailyBriefEnvelope() {
  const envelope = dailyBriefEnvelope();
  return {
    ...envelope,
    data: {
      ...envelope.data,
      headline: "人工智能基础设施与云需求影响今日自选股",
      summary: "最新公司与监管证据显示，NVIDIA 与 Microsoft 面临相互矛盾的信号。",
      developments: envelope.data.developments.map((development, index) => ({
        ...development,
        title:
          index === 0
            ? "NVIDIA 回应新的出口政策限制"
            : "Microsoft 报告云端人工智能需求持续",
        whyItMatters:
          index === 0
            ? "该限制可能改变近期数据中心预期，但现有证据尚不能证明市场波动的单一原因。"
            : "这项更新支持基础设施需求，但目前无法确认本轮支出周期会持续多久。",
      })),
      watchNext: ["关注正式政策指引与公司的后续确认。"],
      unknowns: ["市场反应能否持续仍不确定。"],
    },
    meta: { ...envelope.meta, promptVersion: "2026-11-12.2.zh-CN" },
  };
}

test.describe("Personal Daily Brief", () => {
  test("is manual, sign-in gated, and mobile safe for anonymous visitors", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let briefRequests = 0;
    await page.route("**/api/ai/daily-brief", async (route) => {
      briefRequests += 1;
      await route.abort("failed");
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    const card = page.getByTestId("daily-brief-card");
    await expect(card).toBeVisible();
    await expect(card.getByText("Manual only", { exact: true })).toBeVisible();
    await expect(card.getByText("Sign in to brief your watchlist")).toBeVisible();
    await expect(
      card.getByText("It never runs in the background.", { exact: false }),
    ).toBeVisible();
    await expect(
      card.getByRole("link", { name: "Sign in for Daily Brief" }),
    ).toHaveAttribute("href", /\/signin-with-chatgpt\?return_to=%2Fdashboard/);
    expect(briefRequests).toBe(0);

    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
      card: document.querySelector('[data-testid="daily-brief-card"]')?.scrollWidth ?? 0,
      cardClient:
        document.querySelector('[data-testid="daily-brief-card"]')?.clientWidth ?? 0,
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.card).toBeLessThanOrEqual(overflow.cardClient);
  });

  test("renders a cited multi-symbol brief and preserves safe retry identity", async ({
    page,
  }) => {
    await page.goto("/signin-with-chatgpt?return_to=/dashboard", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");

    const requestBodies: Array<{ request_id?: unknown; locale?: unknown }> = [];
    let briefRequests = 0;
    let rateLimitNext = false;
    await page.route("**/api/ai/daily-brief", async (route) => {
      briefRequests += 1;
      requestBodies.push(
        (route.request().postDataJSON() ?? {}) as {
          request_id?: unknown;
          locale?: unknown;
        },
      );
      if (briefRequests === 1) {
        await route.abort("failed");
        return;
      }
      if (rateLimitNext) {
        rateLimitNext = false;
        await route.fulfill({
          status: 429,
          contentType: "application/json",
          headers: {
            "Retry-After": "120",
            "X-Omnigaze-AI-Budget-Retry-At": "2099-11-12T18:02:00.000Z",
          },
          body: JSON.stringify({
            error: "The Daily Brief AI budget is temporarily exhausted.",
            code: "ai_rate_limited",
            retryAt: "2099-11-12T18:02:00.000Z",
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          dailyBriefEnvelope(briefRequests >= 3 ? "hit" : "generated"),
        ),
      });
    });

    const card = page.getByTestId("daily-brief-card");
    await expect(card.getByText("Turn today’s evidence into a clear market read.")).toBeVisible();
    await expect(card).toContainText("No scheduled or background generation");
    expect(briefRequests).toBe(0);

    await card.getByRole("button", { name: "Build my Daily Brief" }).click();
    await expect(card.getByRole("button", { name: "Resume brief safely" })).toBeVisible();
    await card.getByRole("button", { name: "Resume brief safely" }).click();

    await expect(
      card.getByRole("heading", {
        name: "AI infrastructure and cloud demand shape today’s watchlist",
      }),
    ).toBeVisible();
    await expect(card.getByText("NVIDIA addresses a new export-policy constraint")).toBeVisible();
    await expect(card.getByText("Microsoft reports sustained cloud AI demand")).toBeVisible();
    await expect(card.getByText("2 of 3 symbols")).toBeVisible();
    await expect(card.getByText("1 not represented in this bounded brief")).toBeVisible();
    await expect(card.getByText("2 citations · 2 sources")).toBeVisible();
    await expect(card.getByText("68%")).toBeVisible();
    await expect(card.getByText(/not investment confidence/)).toBeVisible();
    await expect(card.getByText("New analysis generated")).toBeVisible();
    await expect(card.getByText("4 of 5 requests remain")).toBeVisible();
    await expect(card.getByText("Research support only. This is not investment advice.")).toBeVisible();
    expect(requestBodies[0]?.request_id).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
    expect(requestBodies[0]?.locale).toBe("en");
    expect(requestBodies[1]?.request_id).toBe(requestBodies[0]?.request_id);

    await card.getByRole("button", { name: "Refresh brief" }).click();
    await expect(card.getByText("Verified cached brief reused")).toBeVisible();
    await expect(card.getByText("No additional model request used")).toBeVisible();
    expect(requestBodies[2]?.request_id).not.toBe(requestBodies[1]?.request_id);

    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await card.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await page.screenshot({
      path: "outputs/omnigaze-daily-brief-mobile.png",
      fullPage: true,
    });

    rateLimitNext = true;
    await card.getByRole("button", { name: "Refresh brief" }).click();
    await expect(card.getByText(/temporarily at its limit/)).toBeVisible();
    await expect(card.getByText(/not investment confidence or a market signal/)).toBeVisible();
    await expect(card.getByText(/New model requests reset around/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Try a new brief" })).toBeDisabled();
    expect(requestBodies[3]?.request_id).not.toBe(requestBodies[2]?.request_id);
    expect(briefRequests).toBe(4);
  });

  test("rejects an envelope with unrecognized client fields", async ({ page }) => {
    await page.goto("/signin-with-chatgpt?return_to=/dashboard", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/dashboard$/);

    const invalidEnvelope = dailyBriefEnvelope();
    await page.route("**/api/ai/daily-brief", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...invalidEnvelope,
          meta: { ...invalidEnvelope.meta, investmentConfidence: 0.99 },
        }),
      });
    });

    const card = page.getByTestId("daily-brief-card");
    await card.getByRole("button", { name: "Build my Daily Brief" }).click();
    await expect(card.getByText(/failed its integrity checks/)).toBeVisible();
    await expect(card.getByRole("button", { name: "Try a new brief" })).toBeEnabled();
    await expect(card.getByText("99%")).toHaveCount(0);
  });

  test("requests Chinese generation and never retains it after switching to English", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("omnigaze:app-locale:v1", "zh-CN");
    });
    let requestBody: { request_id?: unknown; locale?: unknown } | null = null;
    await page.route("**/api/ai/daily-brief", async (route) => {
      requestBody = (route.request().postDataJSON() ?? {}) as {
        request_id?: unknown;
        locale?: unknown;
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(chineseDailyBriefEnvelope()),
      });
    });

    await page.goto("/signin-with-chatgpt?return_to=/dashboard", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(/\/dashboard$/);
    const card = page.getByTestId("daily-brief-card");
    await card.getByRole("button", { name: "生成我的每日简报" }).click();

    await expect(
      card.getByRole("heading", {
        name: "人工智能基础设施与云需求影响今日自选股",
      }),
    ).toBeVisible();
    expect(requestBody).toMatchObject({ locale: "zh-CN" });
    await expect(card).toContainText("NVIDIA comments on updated export policy");

    await page
      .getByRole("group", { name: "仪表盘语言" })
      .getByRole("button", { name: "EN" })
      .click();
    await expect(card.getByRole("button", { name: "Build my Daily Brief" })).toBeVisible();
    await expect(
      card.getByText("人工智能基础设施与云需求影响今日自选股"),
    ).toHaveCount(0);
  });
});
