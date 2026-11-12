import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const localeKey = "omnigaze:app-locale:v1";
const nvdaSymbolId = "NASDAQ:NVDA";

async function startInChinese(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: localeKey, value: "zh-CN" },
  );
  await page.goto("/dashboard");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
}

async function ensureNvdaTracked(request: APIRequestContext) {
  const response = await request.get("/api/watchlists");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    data: Array<{
      id: string;
      isDefault: boolean;
      items: Array<{ symbolId: string }>;
    }>;
  };
  if (
    body.data.some((watchlist) =>
      watchlist.items.some((item) => item.symbolId === nvdaSymbolId),
    )
  ) {
    return;
  }

  const primary = body.data.find((watchlist) => watchlist.isDefault) ?? body.data[0];
  expect(primary).toBeTruthy();
  const add = await request.post("/api/watchlists", {
    data: {
      operation: "add",
      watchlist_id: primary.id,
      symbol_id: nvdaSymbolId,
    },
  });
  expect(add.status()).toBe(200);
}

async function signInWithNvda(page: Page, request: APIRequestContext) {
  await page.goto("/signin-with-chatgpt?return_to=/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/);
  await ensureNvdaTracked(request);
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
}

test.describe("Omnigaze dashboard locale", () => {
  test("localizes the complete anonymous dashboard workspace and persists switching", async ({
    page,
  }) => {
    await startInChinese(page);

    await expect(page).toHaveTitle("仪表盘 — Omnigaze");
    await expect(
      page.getByRole("heading", { name: "你的市场一览" }),
    ).toBeVisible();
    await expect(page.getByTestId("daily-brief-card")).toContainText("每日简报");
    await expect(page.getByText("NVIDIA Corporation", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "董事会调查加剧高管与治理风险",
        level: 3,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Board investigation elevates executive and governance risk",
        level: 3,
      }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "打开情报收件箱" }).click();
    const inbox = page.getByTestId("intelligence-inbox-drawer");
    await expect(inbox).toContainText("情报收件箱");
    await expect(inbox).toContainText("登录以保存你的情报");
    await page.getByRole("button", { name: "关闭情报收件箱" }).click();

    await page.getByRole("button", { name: "询问 Omnigaze" }).click();
    const view = page.getByTestId("omnigaze-view-dialog");
    await expect(view).toContainText("NVDA 情报分析");
    await expect(view).toContainText("登录后查看有实时证据支撑的观点");
    await page.getByRole("button", { name: "关闭 Omnigaze 观点" }).click();

    await page.locator(".position-context-button").click();
    const portfolio = page.getByTestId("portfolio-workspace");
    await expect(portfolio).toContainText("持仓与研究工作区");
    await expect(portfolio).toContainText("研究情景");
    await page.getByRole("button", { name: "关闭工作区" }).click();

    await page
      .getByRole("group", { name: "仪表盘语言" })
      .getByRole("button", { name: "EN" })
      .click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle("Dashboard — Omnigaze");
    await expect(
      page.getByRole("heading", { name: "Your market at a glance" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Board investigation elevates executive and governance risk",
        level: 3,
      }),
    ).toBeVisible();
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), localeKey))
      .toBe("en");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByRole("heading", { name: "Your market at a glance" }),
    ).toBeVisible();
  });

  test("keeps Chinese dashboard dialogs inside a 390px viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startInChinese(page);

    const noHorizontalOverflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
    await expect.poll(noHorizontalOverflow).toBe(true);

    await page.getByRole("button", { name: "打开情报收件箱" }).click();
    await expect(page.getByTestId("intelligence-inbox-drawer")).toBeVisible();
    await expect.poll(noHorizontalOverflow).toBe(true);
    await page.getByRole("button", { name: "关闭情报收件箱" }).click();

    await page.locator(".position-context-button").click();
    await expect(page.getByTestId("portfolio-workspace")).toBeVisible();
    await expect.poll(noHorizontalOverflow).toBe(true);
  });

  test("re-renders portfolio validation state in the active language", async ({
    context,
    page,
  }) => {
    await signInWithNvda(page, context.request);
    await page.locator(".position-context-button").click();
    const portfolio = page.getByTestId("portfolio-workspace");
    await portfolio.getByLabel("Shares owned").fill("0");
    await portfolio
      .getByRole("button", { name: /Save (?:changes|position)/ })
      .click();
    await expect(portfolio).toContainText(
      "Enter a positive share quantity with up to six decimal places.",
    );

    const chineseButton = page
      .locator(".dashboard-locale-toggle button")
      .filter({ hasText: "中文" });
    await chineseButton.evaluate((button) =>
      (button as HTMLButtonElement).click(),
    );
    await expect(portfolio).toContainText("请输入正的持股数量，最多六位小数。");
    await expect(portfolio).not.toContainText(
      "Enter a positive share quantity with up to six decimal places.",
    );
  });

  test("requests a Chinese Omnigaze View and clears it after switching to English", async ({
    context,
    page,
  }) => {
    await page.addInitScript(
      ({ key, value }) => window.localStorage.setItem(key, value),
      { key: localeKey, value: "zh-CN" },
    );
    let analysisBody: {
      symbol_id?: unknown;
      request_id?: unknown;
      locale?: unknown;
    } | null = null;
    await page.route("**/api/ai/analyze", async (route) => {
      analysisBody = (route.request().postDataJSON() ?? {}) as typeof analysisBody;
      const symbolId =
        typeof analysisBody?.symbol_id === "string"
          ? analysisBody.symbol_id
          : "NASDAQ:NVDA";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            stance: "mixed",
            confidence: 0.62,
            headline: "当前证据呈现相互矛盾的信号",
            summary: "最新公开证据同时包含支持因素与限制因素。",
            whyNow: "新的公司公告改变了当前证据集。",
            drivers: [
              {
                label: "公司公告",
                direction: "mixed",
                explanation: "这项公告为近期市场背景提供了新的信息。",
                evidenceIds: ["evidence:locale-test"],
              },
            ],
            unknowns: ["相关影响能否持续仍不明确。"],
          },
          meta: {
            symbolId,
            dataCutoff: "2026-11-12T18:00:00.000Z",
            generatedAt: "2026-11-12T18:00:02.000Z",
            promptVersion: "2026-11-12.1:zh-CN",
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
            citations: [
              {
                id: "evidence:locale-test",
                title: "NVIDIA publishes a material update",
                publisher: "alpaca",
                publishedAt: "2026-11-12T17:59:00.000Z",
                url: "https://example.test/nvda",
                classification: "fact",
              },
            ],
            ai: {
              source: "generated",
              deduplicated: false,
              modelConfig: "openai-agents-sdk-default",
              evidenceFingerprint: "a".repeat(64),
              cacheExpiresAt: "2026-11-12T18:05:02.000Z",
              servedAt: "2026-11-12T18:00:03.000Z",
              budget: {
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

    await signInWithNvda(page, context.request);
    await page.getByRole("button", { name: "询问 Omnigaze" }).click();
    const dialog = page.getByTestId("omnigaze-view-dialog");
    await dialog.getByRole("button", { name: "分析实时证据" }).click();

    await expect(
      dialog.getByRole("heading", { name: "当前证据呈现相互矛盾的信号" }),
    ).toBeVisible();
    expect(analysisBody).toMatchObject({ locale: "zh-CN" });
    await expect(dialog).toContainText("NVIDIA publishes a material update");

    await page.getByRole("button", { name: "关闭 Omnigaze 观点" }).click();
    await page
      .getByRole("group", { name: "仪表盘语言" })
      .getByRole("button", { name: "EN" })
      .click();
    await page.getByRole("button", { name: "Ask Omnigaze", exact: true }).click();
    await expect(
      dialog.getByText("Generate a fresh Omnigaze View"),
    ).toBeVisible();
    await expect(
      dialog.getByText("当前证据呈现相互矛盾的信号"),
    ).toHaveCount(0);
  });

  test("keeps the server-rendered dashboard visible when hydration is unavailable", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/dashboard");

    await expect(page.locator("main.omnigaze-shell")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Your market at a glance" }),
    ).toBeVisible();

    await context.close();
  });
});
