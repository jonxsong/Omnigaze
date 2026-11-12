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

    await expect(page.getByRole("link", { name: "Omnigaze home" })).toBeVisible();
    await expect(page.getByText("Core holdings", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/OMNIGAZE VIEW/).first()).toBeVisible();
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
