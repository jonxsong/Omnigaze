import { describe, expect, it, vi } from "vitest";
import type { CollectedIntelligenceFeed } from "@/lib/services/collected-intelligence";
import {
  createIntelligenceReadPlane,
  IntelligenceReadPlaneError,
} from "@/lib/services/intelligence-read-plane";
import type {
  IntelligenceFeedItem,
  OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";

const now = new Date("2026-11-12T18:45:00.000Z");

function event(
  id: string,
  overrides: Partial<IntelligenceFeedItem> = {},
): IntelligenceFeedItem {
  return {
    id,
    symbolIds: ["NASDAQ:NVDA"],
    source: id.split(":")[0] ?? "alpaca",
    sourceKind: "licensed_news",
    headline: `Headline for ${id}`,
    summary: null,
    publishedAt: "2026-11-12T18:40:00.000Z",
    receivedAt: "2026-11-12T18:40:05.000Z",
    providerUpdatedAt: "2026-11-12T18:40:00.000Z",
    sourceUrl: `https://example.test/${encodeURIComponent(id)}`,
    materiality: "medium",
    isLive: true,
    ...overrides,
  };
}

function liveFeed(
  data: IntelligenceFeedItem[],
  overrides: Partial<OrchestratedIntelligenceFeed["meta"]> = {},
): OrchestratedIntelligenceFeed {
  return {
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "complete",
      coverage: "complete",
      generatedAt: now.toISOString(),
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T18:40:00.000Z",
        ageSeconds: 300,
      },
      providers: [],
      notice: "Live test feed.",
      ...overrides,
    },
  };
}

function collected(
  data: IntelligenceFeedItem[],
  hasMore = false,
): CollectedIntelligenceFeed {
  return { data, hasMore };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("unified intelligence read plane", () => {
  it("starts both reads concurrently and applies materiality and the final limit after merging", async () => {
    const request = deferred<OrchestratedIntelligenceFeed>();
    const durable = deferred<CollectedIntelligenceFeed>();
    const getRequestTimeFeed = vi.fn(() => request.promise);
    const getCollectedFeed = vi.fn(() => durable.promise);
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed,
      getCollectedFeed,
      now: () => now,
    });

    const pending = service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-12T00:00:00.000Z",
      limit: 1,
      minimumMateriality: "high",
    });
    expect(getRequestTimeFeed).toHaveBeenCalledOnce();
    expect(getCollectedFeed).toHaveBeenCalledOnce();
    expect(getRequestTimeFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, minimumMateriality: "low" }),
    );
    expect(getCollectedFeed).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );

    request.resolve(
      liveFeed([
        event("alpaca:new-low", {
          materiality: "low",
          providerUpdatedAt: "2026-11-12T18:44:00.000Z",
        }),
        event("alpaca:high", {
          materiality: "high",
          providerUpdatedAt: "2026-11-12T18:42:00.000Z",
        }),
      ]),
    );
    durable.resolve(
      collected([
        event("sec-edgar:critical", {
          source: "sec-edgar",
          sourceKind: "sec_filing",
          materiality: "critical",
          providerUpdatedAt: "2026-11-12T18:43:00.000Z",
        }),
      ], true),
    );

    const result = await pending;
    expect(result.data.map((item) => item.id)).toEqual([
      "sec-edgar:critical",
    ]);
    expect(result.meta).toMatchObject({
      dataMode: "live",
      providerCoverage: "partial",
      readPlane: {
        collectedTruncated: true,
        origins: {
          requestTime: { candidateCount: 2, selectedCount: 0 },
          durable: { candidateCount: 1, selectedCount: 1 },
        },
      },
    });
  });

  it("keeps the newest correction and gives the durable receipt exact-tie precedence", async () => {
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () =>
        liveFeed([
          event("alpaca:newer-wins", {
            headline: "Request-time newer",
            providerUpdatedAt: "2026-11-12T18:44:00.000Z",
          }),
          event("alpaca:tie", {
            headline: "Request-time tie",
            providerUpdatedAt: "2026-11-12T18:43:00.000Z",
          }),
        ]),
      getCollectedFeed: async () =>
        collected([
          event("alpaca:newer-wins", {
            headline: "Durable older",
            providerUpdatedAt: "2026-11-12T18:42:00.000Z",
          }),
          event("alpaca:tie", {
            headline: "Durable tie",
            providerUpdatedAt: "2026-11-12T18:43:00.000Z",
          }),
        ]),
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-12T00:00:00.000Z",
      limit: 10,
    });

    expect(result.data).toEqual([
      expect.objectContaining({
        id: "alpaca:newer-wins",
        headline: "Request-time newer",
      }),
      expect.objectContaining({ id: "alpaca:tie", headline: "Durable tie" }),
    ]);
    expect(result.meta.readPlane.origins).toEqual({
      requestTime: { status: "live", candidateCount: 2, selectedCount: 1 },
      durable: { status: "ready", candidateCount: 2, selectedCount: 1 },
    });
  });

  it("does not resurrect an older high-materiality version after a newer downgrade", async () => {
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () =>
        liveFeed([
          event("alpaca:downgraded", {
            headline: "Newer low-materiality correction",
            materiality: "low",
            providerUpdatedAt: "2026-11-12T18:44:00.000Z",
          }),
        ]),
      getCollectedFeed: async () =>
        collected([
          event("alpaca:downgraded", {
            headline: "Older high-materiality version",
            materiality: "high",
            providerUpdatedAt: "2026-11-12T18:40:00.000Z",
          }),
        ]),
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-12T00:00:00.000Z",
      limit: 10,
      minimumMateriality: "high",
    });
    expect(result.data).toEqual([]);
  });

  it("serves fresh durable evidence as partial live coverage when the request-time read fails", async () => {
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () => {
        throw new Error("upstream secret must not escape");
      },
      getCollectedFeed: async () =>
        collected([
          event("alpaca:durable-fresh", {
            providerUpdatedAt: "2026-11-12T18:44:00.000Z",
          }),
        ]),
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-12T00:00:00.000Z",
      limit: 10,
    });
    expect(result).toMatchObject({
      data: [{ id: "alpaca:durable-fresh" }],
      meta: {
        dataMode: "live",
        providerCoverage: "partial",
        fallbackReason: "provider_request_failed",
        freshness: {
          state: "fresh",
          asOf: "2026-11-12T18:44:00.000Z",
          ageSeconds: 60,
        },
        readPlane: {
          requestTimeFailed: true,
          origins: {
            requestTime: { status: "failed", selectedCount: 0 },
            durable: { status: "ready", selectedCount: 1 },
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("must not escape");
  });

  it("rescues the normal provider-failure demo envelope without leaking fixtures", async () => {
    const fixture = event("demo:fixture", {
      source: "omnigaze-demo",
      sourceKind: "demo_fixture",
      isLive: false,
    });
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () =>
        liveFeed([fixture], {
          dataMode: "demo",
          mode: "demo",
          providerCoverage: "demo",
          coverage: "demo",
          freshness: {
            state: "fixture",
            asOf: fixture.publishedAt,
            ageSeconds: null,
          },
          fallbackReason: "provider_request_failed",
        }),
      getCollectedFeed: async () =>
        collected([
          event("alpaca:durable-rescue", {
            providerUpdatedAt: "2026-11-12T18:44:00.000Z",
          }),
        ]),
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-12T00:00:00.000Z",
      limit: 10,
    });
    expect(result.data.map((item) => item.id)).toEqual([
      "alpaca:durable-rescue",
    ]);
    expect(result.meta).toMatchObject({
      dataMode: "live",
      providerCoverage: "partial",
      freshness: { state: "fresh" },
      readPlane: {
        requestTimeFailed: true,
        origins: {
          requestTime: { status: "demo", candidateCount: 0 },
          durable: { status: "ready", selectedCount: 1 },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("demo:fixture");
  });

  it("keeps live request-time evidence available when the durable read fails", async () => {
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () =>
        liveFeed([
          event("alpaca:request-time", {
            providerUpdatedAt: "2026-11-12T18:44:00.000Z",
          }),
        ]),
      getCollectedFeed: async () => {
        throw new Error("private database detail");
      },
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-12T00:00:00.000Z",
      limit: 10,
    });
    expect(result.data.map((item) => item.id)).toEqual([
      "alpaca:request-time",
    ]);
    expect(result.meta).toMatchObject({
      dataMode: "live",
      providerCoverage: "partial",
      readPlane: {
        collectedReadFailed: true,
        origins: { durable: { status: "failed" } },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private database detail");
  });

  it("does not upgrade stale durable evidence or a future-dated correction", async () => {
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () => {
        throw new Error("offline");
      },
      getCollectedFeed: async () =>
        collected([
          event("alpaca:stale", {
            publishedAt: "2026-11-10T18:00:00.000Z",
            providerUpdatedAt: "2026-11-12T20:00:00.000Z",
          }),
        ]),
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-01T00:00:00.000Z",
      limit: 10,
    });
    expect(result.meta.freshness).toEqual({
      state: "stale",
      asOf: "2026-11-10T18:00:00.000Z",
      ageSeconds: 175_500,
    });
  });

  it("preserves a demo response when no durable live evidence exists", async () => {
    const fixture = event("demo:fixture", {
      source: "omnigaze-demo",
      sourceKind: "demo_fixture",
      isLive: false,
    });
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () =>
        liveFeed([fixture], {
          dataMode: "demo",
          mode: "demo",
          providerCoverage: "demo",
          coverage: "demo",
          freshness: {
            state: "fixture",
            asOf: fixture.publishedAt,
            ageSeconds: null,
          },
          fallbackReason: "provider_unconfigured",
        }),
      getCollectedFeed: async () => collected([]),
      now: () => now,
    });

    const result = await service.getIntelligenceFeed({
      since: "2026-11-12T00:00:00.000Z",
      limit: 10,
    });
    expect(result.data).toEqual([fixture]);
    expect(result.meta).toMatchObject({
      dataMode: "demo",
      freshness: { state: "fixture" },
      readPlane: {
        requestTimeFailed: false,
        origins: {
          requestTime: { status: "demo" },
          durable: { status: "ready", candidateCount: 0 },
        },
      },
    });
  });

  it("fails with a safe error when neither read plane can return a feed", async () => {
    const service = createIntelligenceReadPlane({
      getRequestTimeFeed: async () => {
        throw new Error("request details");
      },
      getCollectedFeed: async () => {
        throw new Error("database details");
      },
      now: () => now,
    });

    await expect(
      service.getIntelligenceFeed({
        since: "2026-11-12T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toEqual(
      new IntelligenceReadPlaneError("intelligence_read_unavailable"),
    );
  });
});

