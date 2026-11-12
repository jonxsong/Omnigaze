import { describe, expect, it, vi } from "vitest";
import type {
  InboxListResult,
  IntelligenceInboxRepository,
} from "@/lib/intelligence-inbox/repository";
import {
  getAlertRules,
  getIntelligenceInbox,
  getIntelligenceInboxItem,
  type InboxServiceDependencies,
} from "@/lib/intelligence-inbox/service";
import type {
  IntelligenceFeedItem,
  OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const generatedAt = "2026-11-12T08:00:00.000Z";

function item(overrides: Partial<IntelligenceFeedItem> = {}): IntelligenceFeedItem {
  return {
    id: "alpaca:event-1",
    symbolIds: ["NASDAQ:NVDA"],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: "Provider event",
    summary: "Evidence-backed summary",
    publishedAt: "2026-11-12T07:55:00.000Z",
    receivedAt: "2026-11-12T07:56:00.000Z",
    sourceUrl: "https://example.test/event-1",
    materiality: "high",
    isLive: true,
    category: "market",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["market"],
    isControversial: false,
    ...overrides,
  };
}

function feed(
  dataMode: "live" | "demo",
  freshness: "fresh" | "stale" | "unknown" | "fixture",
  data: IntelligenceFeedItem[] = [],
): OrchestratedIntelligenceFeed {
  const coverage = dataMode === "live" ? "complete" : "demo";
  return {
    data,
    meta: {
      dataMode,
      mode: dataMode,
      providerCoverage: coverage,
      coverage,
      generatedAt,
      freshness: { state: freshness, asOf: generatedAt, ageSeconds: 0 },
      providers: [],
      notice: "Provider notice",
    },
  };
}

function repository(stored: InboxListResult = {
  items: [],
  counts: { all: 0, unread: 0, saved: 0, alerts: 0 },
}) {
  return {
    claimReconciliation: vi.fn().mockResolvedValue({
      acquired: true,
      token: "claim-a",
      reason: "claimed",
      catchupPending: false,
      nextAllowedAt: generatedAt,
      lastCompletedAt: null,
    }),
    completeReconciliation: vi.fn().mockResolvedValue(undefined),
    syncLiveItems: vi
      .fn()
      .mockImplementation(async (_ownerId, items: IntelligenceFeedItem[]) => ({
        baselineApplied: true,
        hasMoreCandidates: items.length > 0,
        newItemCount: items.length,
        newDeliveryCount: 0,
      })),
    listInbox: vi.fn().mockResolvedValue(stored),
    getInboxItem: vi.fn(),
    listRules: vi.fn().mockResolvedValue([]),
    updateInboxState: vi.fn(),
    putAlertRule: vi.fn(),
  } as unknown as IntelligenceInboxRepository;
}

function dependencies(
  inboxRepository: IntelligenceInboxRepository,
  providerResult: OrchestratedIntelligenceFeed | Error,
  withSymbol = true,
): InboxServiceDependencies {
  return {
    repository: inboxRepository,
    listWatchlists: vi.fn().mockResolvedValue([
      {
        id: "watchlist-a",
        ownerId: "owner-a",
        name: "Core holdings",
        isDefault: true,
        createdAt: generatedAt,
        updatedAt: generatedAt,
        items: withSymbol
          ? [
              {
                watchlistId: "watchlist-a",
                symbolId: "NASDAQ:NVDA",
                note: null,
                addedAt: generatedAt,
                ticker: "NVDA",
                exchange: "NASDAQ",
                name: "NVIDIA",
              },
            ]
          : [],
      },
    ]),
    getFeed: vi.fn().mockImplementation(async () => {
      if (providerResult instanceof Error) throw providerResult;
      return providerResult;
    }),
    now: () => new Date(generatedAt),
  } as InboxServiceDependencies;
}

describe("intelligence inbox orchestration", () => {
  it("mutates durable state only for fresh live provider output", async () => {
    const repo = repository();
    const deps = dependencies(
      repo,
      feed("live", "fresh", [
        item(),
        item({
          id: "demo:event",
          source: "omnigaze-demo",
          sourceKind: "demo_fixture",
          isLive: false,
        }),
        item({ id: "alpaca:other", symbolIds: ["NASDAQ:MSFT"] }),
      ]),
    );

    const result = await getIntelligenceInbox(
      "owner-a",
      { filter: "all", limit: 25 },
      deps,
    );

    expect(repo.syncLiveItems).toHaveBeenCalledWith(
      "owner-a",
      [expect.objectContaining({ id: "alpaca:event-1", isLive: true })],
      generatedAt,
    );
    expect(result.meta.sync).toMatchObject({
      status: "live",
      baselineApplied: true,
      hasMoreCandidates: true,
      newItemCount: 1,
      newDeliveryCount: 0,
    });
    expect(result.meta).toMatchObject({
      scope: "personal",
      identity: "authenticated",
      persistence: "server",
      channel: "in_app",
      filter: "all",
      limit: 25,
    });
  });

  it("orders sync candidates newest-first for bounded repository selection", async () => {
    const repo = repository();
    const events = Array.from({ length: 10 }, (_, index) =>
      item({
        id: `alpaca:event-${index}`,
        publishedAt: new Date(
          Date.parse("2026-11-12T07:00:00.000Z") + index * 60_000,
        ).toISOString(),
      }),
    ).reverse();

    await getIntelligenceInbox(
      "owner-a",
      { filter: "all", limit: 50 },
      dependencies(repo, feed("live", "fresh", events)),
    );

    const synced = vi.mocked(repo.syncLiveItems).mock.calls[0][1];
    expect(synced.map((event) => event.id).slice(0, 4)).toEqual([
      "alpaca:event-9",
      "alpaca:event-8",
      "alpaca:event-7",
      "alpaca:event-6",
    ]);
    expect(synced).toHaveLength(10);
  });

  it("persists only individually fresh items while retaining fresh corrections", async () => {
    const repo = repository();
    await getIntelligenceInbox(
      "owner-a",
      { filter: "all", limit: 50 },
      dependencies(
        repo,
        feed("live", "fresh", [
          item({ id: "alpaca:fresh" }),
          item({
            id: "alpaca:stale",
            publishedAt: "2026-11-10T07:55:00.000Z",
          }),
          item({
            id: "alpaca:fresh-correction",
            publishedAt: "2026-11-01T07:55:00.000Z",
            providerUpdatedAt: "2026-11-12T07:50:00.000Z",
          }),
          item({
            id: "alpaca:future-clock",
            publishedAt: "2026-11-12T08:06:00.000Z",
          }),
        ]),
      ),
    );

    const synced = vi.mocked(repo.syncLiveItems).mock.calls[0][1];
    expect(synced.map((event) => event.id)).toEqual([
      "alpaca:fresh",
      "alpaca:fresh-correction",
    ]);
  });

  it.each(["in_flight", "throttled"] as const)(
    "reuses persisted state while provider refresh is %s",
    async (reason) => {
      const repo = repository();
      vi.mocked(repo.claimReconciliation).mockResolvedValue({
        acquired: false,
        token: null,
        reason,
        catchupPending: true,
        nextAllowedAt: "2026-11-12T08:00:02.000Z",
        lastCompletedAt:
          reason === "throttled" ? "2026-11-12T08:00:00.000Z" : null,
      });
      const deps = dependencies(repo, feed("live", "fresh", [item()]));

      const result = await getIntelligenceInbox(
        "owner-a",
        { filter: "saved", limit: 100 },
        deps,
      );

      expect(deps.getFeed).not.toHaveBeenCalled();
      expect(repo.syncLiveItems).not.toHaveBeenCalled();
      expect(repo.completeReconciliation).not.toHaveBeenCalled();
      expect(result.meta.sync).toMatchObject({
        status: "refresh_deferred",
        hasMoreCandidates: true,
        newItemCount: 0,
        newDeliveryCount: 0,
      });
      expect(result.meta.sync.notice).toMatch(
        reason === "in_flight" ? /already in progress/i : /checked recently/i,
      );
    },
  );

  it.each([
    ["demo fixtures", feed("demo", "fixture"), "demo_suppressed", false],
    [
      "stale live data",
      feed("live", "stale", [item()]),
      "stale_suppressed",
      true,
    ],
    [
      "unknown freshness",
      feed("live", "unknown", [item()]),
      "stale_suppressed",
      true,
    ],
    [
      "provider failure",
      new Error("provider secret"),
      "provider_unavailable",
      false,
    ],
  ] as const)(
    "returns persisted items without event writes for %s",
    async (_label, providerResult, expectedStatus, activates) => {
      const stored = {
        items: [{ event: { eventId: "stored:event" } }],
        counts: { all: 1, unread: 1, saved: 0, alerts: 0 },
      } as unknown as InboxListResult;
      const repo = repository(stored);
      const result = await getIntelligenceInbox(
        "owner-a",
        { filter: "unread", limit: 10 },
        dependencies(repo, providerResult),
      );

      if (activates) {
        expect(repo.syncLiveItems).toHaveBeenCalledWith(
          "owner-a",
          [],
          generatedAt,
        );
      } else {
        expect(repo.syncLiveItems).not.toHaveBeenCalled();
      }
      expect(result.data.items).toBe(stored.items);
      expect(result.meta.sync).toMatchObject({
        status: expectedStatus,
        baselineApplied: activates,
        newItemCount: 0,
        newDeliveryCount: 0,
      });
      expect(JSON.stringify(result)).not.toContain("provider secret");
      if (expectedStatus === "provider_unavailable") {
        expect(repo.completeReconciliation).toHaveBeenCalledWith(
          "owner-a",
          "claim-a",
          generatedAt,
          { providerSucceeded: false, hasMoreCandidates: false },
        );
      } else {
        expect(repo.completeReconciliation).toHaveBeenCalledWith(
          "owner-a",
          "claim-a",
          generatedAt,
          expect.objectContaining({ providerSucceeded: true }),
        );
      }
    },
  );

  it("records a successful empty live activation even when freshness is unknown", async () => {
    const repo = repository();
    const result = await getIntelligenceInbox(
      "owner-a",
      { filter: "all", limit: 50 },
      dependencies(repo, feed("live", "unknown", [])),
    );

    expect(repo.syncLiveItems).toHaveBeenCalledWith("owner-a", [], generatedAt);
    expect(result.meta.sync).toMatchObject({
      status: "live",
      freshness: "unknown",
      baselineApplied: true,
      newItemCount: 0,
      newDeliveryCount: 0,
    });
  });

  it("does not activate an inbox until the owner tracks a symbol", async () => {
    const repo = repository();
    const deps = dependencies(repo, feed("live", "fresh", [item()]), false);

    const result = await getIntelligenceInbox(
      "owner-a",
      { filter: "all", limit: 50 },
      deps,
    );

    expect(deps.getFeed).not.toHaveBeenCalled();
    expect(repo.claimReconciliation).not.toHaveBeenCalled();
    expect(repo.syncLiveItems).not.toHaveBeenCalled();
    expect(result.meta.sync.status).toBe("empty_watchlist");
  });

  it("surfaces persistence failures instead of mislabeling them as provider outages", async () => {
    const repo = repository();
    vi.mocked(repo.syncLiveItems).mockRejectedValue(new Error("D1 unavailable"));

    await expect(
      getIntelligenceInbox(
        "owner-a",
        { filter: "all", limit: 50 },
        dependencies(repo, feed("live", "fresh", [item()])),
      ),
    ).rejects.toThrow("D1 unavailable");
  });

  it("derives alert-rule scope from the authenticated owner's watchlist", async () => {
    const repo = repository();
    const deps = dependencies(repo, feed("live", "fresh"));

    const result = await getAlertRules("owner-a", deps);

    expect(repo.listRules).toHaveBeenCalledWith("owner-a", [
      {
        id: "NASDAQ:NVDA",
        ticker: "NVDA",
        exchange: "NASDAQ",
        name: "NVIDIA",
      },
    ]);
    expect(result.meta).toMatchObject({
      scope: "personal",
      identity: "authenticated",
      channel: "in_app",
    });
    expect(JSON.stringify(result)).not.toContain("owner-a");
  });

  it("reads a focused durable item without invoking providers or watchlists", async () => {
    const repo = repository();
    const storedItem = {
      event: {
        eventId: "alpaca:event-1",
        eventRevision: 2,
        symbols: [],
      },
      state: { version: 3 },
      alert: { triggered: false },
    };
    vi.mocked(repo.getInboxItem).mockResolvedValue(storedItem as never);
    const deps = dependencies(repo, new Error("provider must not run"));

    const result = await getIntelligenceInboxItem(
      "owner-a",
      "alpaca:event-1",
      deps,
    );

    expect(repo.getInboxItem).toHaveBeenCalledWith(
      "owner-a",
      "alpaca:event-1",
    );
    expect(deps.listWatchlists).not.toHaveBeenCalled();
    expect(deps.getFeed).not.toHaveBeenCalled();
    expect(result).toEqual({
      data: { item: storedItem },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        channel: "in_app",
        generatedAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain("owner-a");
  });
});
