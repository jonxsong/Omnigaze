import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const NOW = "2026-11-12T08:00:00.000Z";
const EVENT_ID = "alpaca:news-omnigaze-e2e";
const SYMBOL_ID = "NASDAQ:NVDA";

interface InboxState {
  read: boolean;
  saved: boolean;
  dismissed: boolean;
  readRevision: number;
  hasUpdate: boolean;
  version: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface AlertRule {
  symbol: {
    id: typeof SYMBOL_ID;
    ticker: "NVDA";
    exchange: "NASDAQ";
    name: "NVIDIA Corporation";
  };
  enabled: boolean;
  minimumMateriality: "medium" | "high" | "critical";
  includeControversy: boolean;
  channel: "in_app";
  version: number;
  persisted: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

function createState(overrides: Partial<InboxState> = {}): InboxState {
  return {
    read: false,
    saved: false,
    dismissed: false,
    readRevision: 0,
    hasUpdate: false,
    version: 1,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function createRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    symbol: {
      id: SYMBOL_ID,
      ticker: "NVDA",
      exchange: "NASDAQ",
      name: "NVIDIA Corporation",
    },
    enabled: false,
    minimumMateriality: "high",
    includeControversy: false,
    channel: "in_app",
    version: 0,
    persisted: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function inboxEnvelope(
  state: InboxState,
  rule = createRule(),
  countOverrides: Partial<{
    all: number;
    unread: number;
    saved: number;
    alerts: number;
  }> = {},
) {
  const visible = !state.dismissed;
  return {
    data: {
      items: [
        {
          event: {
            eventId: EVENT_ID,
            eventRevision: 1,
            symbols: [rule.symbol],
            source: {
              name: "Alpaca News",
              kind: "licensed_news",
              url: "https://example.test/omnigaze-e2e",
            },
            headline: "NVIDIA publishes a material platform update",
            summary:
              "A deterministic browser fixture verifies durable inbox interactions.",
            materiality: "high",
            category: "product",
            claimStatus: "confirmed",
            causalLink: "unassessed",
            topicTags: ["product"],
            isControversial: false,
            publishedAt: NOW,
            receivedAt: NOW,
          },
          state,
          alert: {
            triggered: false,
            deliveryCount: 0,
            lastDeliveredAt: null,
            matchedRuleSymbols: [],
          },
        },
      ],
      counts: {
        all: visible ? 1 : 0,
        unread: visible && (!state.read || state.hasUpdate) ? 1 : 0,
        saved: state.saved ? 1 : 0,
        alerts: 0,
        ...countOverrides,
      },
      rules: [rule],
    },
    meta: {
      scope: "personal",
      identity: "authenticated",
      persistence: "server",
      channel: "in_app",
      filter: "all",
      limit: 100,
      sync: {
        status: "live",
        checkedAt: NOW,
        dataMode: "live",
        freshness: "fresh",
        providerCoverage: "partial",
        baselineApplied: false,
        hasMoreCandidates: false,
        newItemCount: 0,
        newDeliveryCount: 0,
        notice: "Fresh live provider events were reconciled.",
      },
      generatedAt: NOW,
    },
  };
}

function rulesEnvelope(rule: AlertRule) {
  return {
    data: { rules: [rule] },
    meta: {
      scope: "personal",
      identity: "authenticated",
      persistence: "server",
      channel: "in_app",
      generatedAt: NOW,
    },
  };
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
      watchlist.items.some((item) => item.symbolId === SYMBOL_ID),
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
      symbol_id: SYMBOL_ID,
    },
  });
  expect(add.status()).toBe(200);
}

async function signInWithNvda(page: Page, request: APIRequestContext) {
  await page.goto("/signin-with-chatgpt?return_to=/dashboard", {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(/\/dashboard$/);
  await ensureNvdaTracked(request);
  await page.reload();
  await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
}

test.describe("Omnigaze intelligence inbox", () => {
  test("keeps anonymous inbox activity sign-in gated and fits a mobile viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let inboxRequests = 0;
    let ruleRequests = 0;
    await page.route("**/api/intelligence/inbox**", async (route) => {
      inboxRequests += 1;
      await route.fulfill({ status: 500, body: "unexpected anonymous inbox call" });
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      ruleRequests += 1;
      await route.fulfill({ status: 500, body: "unexpected anonymous rules call" });
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page.locator("main")).toHaveAttribute("data-hydrated", "true");
    const trigger = page.getByTestId("intelligence-inbox-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();

    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId("inbox-auth-gate")).toContainText(
      "Sign in to keep your intelligence",
    );
    await expect(page.getByRole("link", { name: "Sign in to continue" })).toHaveAttribute(
      "href",
      /\/signin-with-chatgpt\?return_to=%2Fdashboard/,
    );
    await expect(drawer).toContainText(
      "does not create background alerts or store inbox activity while you are signed out",
    );

    await expect
      .poll(async () => (await drawer.boundingBox())?.x ?? Number.POSITIVE_INFINITY)
      .toBeLessThanOrEqual(1);
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThanOrEqual(1);
    expect(box!.width).toBeGreaterThanOrEqual(389);
    expect(box!.height).toBeGreaterThanOrEqual(843);
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(inboxRequests).toBe(0);
    expect(ruleRequests).toBe(0);
  });

  test("persists read and saved state through close and reopen with exact CAS payloads", async ({
    context,
    page,
  }) => {
    let state = createState();
    const rule = createRule();
    const counts = { all: 1005, unread: 301, saved: 17, alerts: 22 };
    const mutations: Array<Record<string, unknown>> = [];

    await page.route("**/api/intelligence/inbox**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/intelligence/inbox") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(inboxEnvelope(state, rule, counts)),
        });
        return;
      }
      if (request.method() === "PATCH") {
        const body = request.postDataJSON() as {
          read: boolean;
          saved: boolean;
          dismissed: boolean;
          expected_version: number;
          expected_event_revision: number;
        };
        mutations.push(body);
        if (state.read !== body.read) counts.unread += body.read ? -1 : 1;
        if (state.saved !== body.saved) counts.saved += body.saved ? 1 : -1;
        state = {
          ...state,
          read: body.read,
          saved: body.saved,
          dismissed: body.dismissed,
          readRevision: body.read ? 1 : 0,
          hasUpdate: false,
          version: state.version + 1,
          lastSeenAt: NOW,
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { eventId: EVENT_ID, eventRevision: 1, state },
            meta: {
              scope: "personal",
              identity: "authenticated",
              persistence: "server",
              replayed: false,
              generatedAt: NOW,
            },
          }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rulesEnvelope(rule)),
      });
    });

    await signInWithNvda(page, context.request);
    await page.getByTestId("intelligence-inbox-trigger").click();
    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await expect(drawer.getByText("NVIDIA publishes a material platform update")).toBeVisible();

    const inboxTab = drawer.getByRole("tab", { name: /Inbox/ });
    await expect(inboxTab).toHaveAttribute("aria-controls", "intelligence-inbox-panel");
    await inboxTab.focus();
    await inboxTab.press("End");
    const rulesTab = drawer.getByRole("tab", { name: "Rules" });
    await expect(rulesTab).toBeFocused();
    await expect(rulesTab).toHaveAttribute("aria-selected", "true");
    await rulesTab.press("Home");
    await expect(inboxTab).toBeFocused();
    await expect(inboxTab).toHaveAttribute("aria-selected", "true");

    await drawer.getByRole("button", { name: "Mark read" }).click();
    await expect(drawer.getByRole("button", { name: "Mark unread" })).toBeVisible();
    await drawer.getByRole("button", { name: "Save for thesis" }).click();
    await expect(drawer.getByRole("button", { name: "Saved" })).toBeVisible();
    await expect(page.getByTestId("intelligence-inbox-trigger")).toHaveAttribute(
      "aria-label",
      "Open intelligence inbox, 300 unread",
    );

    expect(mutations).toEqual([
      {
        read: true,
        saved: false,
        dismissed: false,
        expected_version: 1,
        expected_event_revision: 1,
      },
      {
        read: true,
        saved: true,
        dismissed: false,
        expected_version: 2,
        expected_event_revision: 1,
      },
    ]);

    await drawer.getByRole("button", { name: "Close intelligence inbox" }).click();
    await page.getByTestId("intelligence-inbox-trigger").click();
    await drawer.getByRole("tab", { name: "Saved" }).click();
    await expect(drawer.getByText("NVIDIA publishes a material platform update")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Saved" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Mark unread" })).toBeVisible();
    await expect(drawer.getByRole("tab", { name: /Inbox/ })).toContainText("99+");
  });

  test("loads durable saved research outside the active inbox window", async ({
    context,
    page,
  }) => {
    const rule = createRule();
    const savedState = createState({
      read: true,
      saved: true,
      dismissed: true,
      readRevision: 1,
    });
    let savedReads = 0;

    await page.route("**/api/intelligence/inbox**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.pathname !== "/api/intelligence/inbox") {
        await route.fallback();
        return;
      }
      const saved = url.searchParams.get("filter") === "saved";
      if (saved) savedReads += 1;
      const envelope = inboxEnvelope(savedState, rule, {
        all: 0,
        unread: 0,
        saved: 1,
        alerts: 0,
      });
      if (!saved) envelope.data.items = [];
      envelope.meta.filter = saved ? "saved" : "all";
      envelope.meta.sync.status = "refresh_deferred";
      envelope.meta.sync.notice = "A recent provider check is being reused.";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(envelope),
      });
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rulesEnvelope(rule)),
      });
    });

    await signInWithNvda(page, context.request);
    await page.getByTestId("intelligence-inbox-trigger").click();
    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await drawer.getByRole("tab", { name: "Saved" }).click();

    await expect(drawer.getByText("NVIDIA publishes a material platform update")).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect(drawer).toContainText("Recent provider check reused");
    await expect(drawer).not.toContainText("Live provider refresh is delayed");
    expect(savedReads).toBeGreaterThan(0);
    await expect(drawer.getByRole("button", { name: "All" })).toHaveCount(0);
  });

  test("waits for a deferred lease and bounded catch-up before saving a timeline event", async ({
    context,
    page,
  }) => {
    const rule = createRule();
    let state = createState();
    let drawerReads = 0;
    let focusedReads = 0;
    let mutations = 0;

    await page.route("**/api/intelligence?*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: [
            {
              id: EVENT_ID,
              symbolIds: [SYMBOL_ID],
              source: "Alpaca News",
              sourceKind: "licensed_news",
              headline: "NVIDIA publishes a material platform update",
              summary: "A bounded catch-up fixture should become durably saveable.",
              publishedAt: NOW,
              receivedAt: NOW,
              providerUpdatedAt: NOW,
              sourceUrl: "https://example.test/omnigaze-e2e",
              materiality: "high",
              isLive: true,
              category: "product",
              claimStatus: "confirmed",
              causalLink: "unassessed",
              topicTags: ["product"],
              isControversial: false,
            },
          ],
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage: "partial",
            coverage: "partial",
            generatedAt: NOW,
            freshness: { state: "fresh", asOf: NOW, ageSeconds: 0 },
            providers: [],
            notice: "Fresh live provider events were reconciled.",
          },
        }),
      });
    });
    await page.route("**/api/intelligence/inbox**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/intelligence/inbox") {
        const envelope = inboxEnvelope(state, rule);
        if (url.searchParams.get("limit") === "100") {
          drawerReads += 1;
          if (drawerReads === 1) {
            envelope.data.items = [];
            envelope.meta.sync.status = "refresh_deferred";
            envelope.meta.sync.hasMoreCandidates = false;
          } else if (drawerReads === 2) {
            envelope.data.items = [];
            envelope.meta.sync.hasMoreCandidates = true;
          }
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(envelope),
        });
        return;
      }
      if (
        request.method() === "GET" &&
        decodeURIComponent(url.pathname).endsWith(`/${EVENT_ID}`)
      ) {
        focusedReads += 1;
        await route.fulfill({ status: 404, body: "unexpected focused read" });
        return;
      }
      if (request.method() === "PATCH") {
        mutations += 1;
        state = createState({
          read: true,
          saved: true,
          readRevision: 1,
          version: 2,
        });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { eventId: EVENT_ID, eventRevision: 1, state },
            meta: {
              scope: "personal",
              identity: "authenticated",
              persistence: "server",
              replayed: false,
              generatedAt: NOW,
            },
          }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rulesEnvelope(rule)),
      });
    });

    await signInWithNvda(page, context.request);
    const timelineCard = page.locator(".event-card").filter({
      hasText: "NVIDIA publishes a material platform update",
    });
    await expect(timelineCard).toBeVisible();
    await timelineCard.getByRole("button", { name: "Save for thesis" }).click();

    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await expect(drawer).toContainText(
      "Finishing the durable refresh before saving",
    );
    await expect(drawer).toContainText("Saved to your thesis workspace.", {
      timeout: 10_000,
    });
    await expect(drawer.getByRole("button", { name: "Saved" })).toBeVisible();
    expect(drawerReads).toBeGreaterThanOrEqual(3);
    expect(focusedReads).toBe(0);
    expect(mutations).toBe(1);
  });

  test("requires explicit opt-in for an in-app-only symbol rule", async ({
    context,
    page,
  }) => {
    const state = createState({ read: true, readRevision: 1 });
    let rule = createRule();
    const writes: Array<Record<string, unknown>> = [];

    await page.route("**/api/intelligence/inbox**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(inboxEnvelope(state, rule)),
      });
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rulesEnvelope(rule)),
        });
        return;
      }
      const body = request.postDataJSON() as {
        enabled: boolean;
        minimum_materiality: "medium" | "high" | "critical";
        include_controversy: boolean;
        expected_version: number;
      };
      writes.push(body);
      rule = createRule({
        enabled: body.enabled,
        minimumMateriality: body.minimum_materiality,
        includeControversy: body.include_controversy,
        version: 1,
        persisted: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { rule },
          meta: {
            scope: "personal",
            identity: "authenticated",
            persistence: "server",
            channel: "in_app",
            replayed: false,
            generatedAt: NOW,
          },
        }),
      });
    });

    await signInWithNvda(page, context.request);
    await page.getByTestId("intelligence-inbox-trigger").click();
    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await drawer.getByRole("tab", { name: "Rules" }).click();
    await expect(drawer).toContainText(
      "Email, SMS, push, and browser notifications are not enabled",
    );
    await expect(drawer).toContainText(
      "Rules are off by default and are never inferred from onboarding answers",
    );

    const toggle = drawer.getByRole("checkbox", {
      name: "Enable NVDA in-app alert rule",
    });
    await expect(toggle).not.toBeChecked();
    await toggle.locator("..").click();
    await expect(toggle).toBeChecked();
    expect(writes).toEqual([
      {
        enabled: true,
        minimum_materiality: "high",
        include_controversy: false,
        expected_version: 0,
      },
    ]);
  });

  test("reloads authoritative state after an optimistic inbox conflict", async ({
    context,
    page,
  }) => {
    let state = createState();
    const rule = createRule();
    let conflicts = 0;
    let inboxReads = 0;

    await page.route("**/api/intelligence/inbox**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/intelligence/inbox") {
        inboxReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(inboxEnvelope(state, rule)),
        });
        return;
      }
      if (request.method() === "PATCH") {
        conflicts += 1;
        state = createState({ version: 5 });
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "version_conflict",
            error: "Inbox item changed. Refresh before saving again.",
          }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rulesEnvelope(rule)),
      });
    });

    await signInWithNvda(page, context.request);
    await page.getByTestId("intelligence-inbox-trigger").click();
    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await drawer.getByRole("button", { name: "Mark read" }).click();

    await expect(drawer).toContainText(
      "This event changed in another session. Omnigaze loaded the latest account state.",
    );
    await expect(drawer.getByRole("button", { name: "Mark read" })).toBeVisible();
    expect(conflicts).toBe(1);
    expect(inboxReads).toBeGreaterThanOrEqual(3);
  });

  test("reconciles committed state after uncertain mutation responses", async ({
    context,
    page,
  }) => {
    let state = createState();
    let rule = createRule();
    let focusedReads = 0;
    let ruleReads = 0;

    await page.route("**/api/intelligence/inbox**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/api/intelligence/inbox") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(inboxEnvelope(state, rule)),
        });
        return;
      }
      if (
        request.method() === "GET" &&
        decodeURIComponent(url.pathname).endsWith(`/${EVENT_ID}`)
      ) {
        focusedReads += 1;
        const item = inboxEnvelope(state, rule).data.items[0];
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            data: { item },
            meta: {
              scope: "personal",
              identity: "authenticated",
              persistence: "server",
              channel: "in_app",
              generatedAt: NOW,
            },
          }),
        });
        return;
      }
      if (request.method() === "PATCH") {
        state = createState({ saved: true, version: 2 });
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Update acknowledgement was lost." }),
        });
        return;
      }
      await route.fallback();
    });
    await page.route("**/api/alerts/rules**", async (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        ruleReads += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(rulesEnvelope(rule)),
        });
        return;
      }
      rule = createRule({
        enabled: true,
        version: 1,
        persisted: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Rule acknowledgement was lost." }),
      });
    });

    await signInWithNvda(page, context.request);
    await page.getByTestId("intelligence-inbox-trigger").click();
    const drawer = page.getByTestId("intelligence-inbox-drawer");
    await drawer.getByRole("button", { name: "Save for thesis" }).click();

    await expect(drawer.getByRole("button", { name: "Saved" })).toBeVisible();
    await expect(drawer).toContainText(
      "Update acknowledgement was lost. Omnigaze loaded the latest account state.",
    );
    expect(focusedReads).toBe(1);

    await drawer.getByRole("tab", { name: "Rules" }).click();
    const toggle = drawer.getByRole("checkbox", {
      name: "Enable NVDA in-app alert rule",
    });
    await toggle.locator("..").click();
    await expect(toggle).toBeChecked();
    await expect(drawer).toContainText(
      "Rule acknowledgement was lost. Omnigaze loaded the latest rule state.",
    );
    expect(ruleReads).toBeGreaterThan(0);
  });
});
