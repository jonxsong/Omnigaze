import { expect, test } from "@playwright/test";

test.describe("Omnigaze onboarding", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/onboarding");
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Choose the stocks that matter to you" }),
    ).toBeVisible();
  });

  test("builds a local draft and hands the watchlist to the dashboard", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /NVDA NVIDIA Corporation/ }).click();
    await page.getByRole("button", { name: /MSFT Microsoft Corporation/ }).click();
    await page.getByRole("button", { name: /continue/i }).click();

    await page.getByRole("switch", { name: "Watch only" }).first().click();
    await page.getByLabel(/Shares Required/).fill("12.5");
    await page.getByLabel(/Average cost per share/).fill("104.25");
    await page.getByRole("button", { name: /continue/i }).click();

    await page.getByText("Stay ahead of material changes", { exact: true }).click();
    await page.getByRole("radio", { name: "1–3 years" }).check();
    await page.getByRole("radio", { name: /Balanced/ }).check();
    await page.getByRole("radio", { name: "No expected near-term need" }).check();
    await page.getByRole("button", { name: /continue/i }).click();

    await expect(page.getByRole("heading", { name: "Your market, ready" })).toBeVisible();
    await expect(page.getByText("12.5 shares · $104.25 avg.")).toBeVisible();
    await expect(page.getByText("Saved on this device").first()).toBeVisible();

    await page.screenshot({
      path: "outputs/onboarding-desktop.png",
      fullPage: true,
    });

    await page.getByRole("button", { name: "Build my dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(
      page.getByRole("button", { name: "Remove NVDA from watchlist" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Remove MSFT from watchlist" }),
    ).toBeVisible();
    await expect(page.getByText("Own 12.5 shares · $104.25 average cost")).toBeVisible();
  });

  test("resumes the active step and fits a 390px viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: /NVDA NVIDIA Corporation/ }).click();
    await page.getByRole("button", { name: /continue/i }).click();
    await expect(page.getByRole("heading", { name: "Which of these do you own?" })).toBeVisible();

    await page.waitForTimeout(450);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Which of these do you own?" })).toBeVisible();

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

    await page.screenshot({
      path: "outputs/onboarding-mobile.png",
      fullPage: true,
    });
  });
});
