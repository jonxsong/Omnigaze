import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockInstrumentResolutionError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    getIntelligenceFeed: vi.fn(),
    getChatGPTUser: vi.fn(),
    listUserWatchlists: vi.fn(),
    resolveCanonicalInstrument: vi.fn(),
    InstrumentResolutionError: MockInstrumentResolutionError,
  };
});

vi.mock("@/lib/services/intelligence-read-plane", () => ({
  intelligenceReadPlane: {
    getIntelligenceFeed: mocks.getIntelligenceFeed,
  },
}));

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/repositories/watchlists", () => ({
  listUserWatchlists: mocks.listUserWatchlists,
}));

vi.mock("@/lib/services/instrument-resolution", () => ({
  resolveCanonicalInstrument: mocks.resolveCanonicalInstrument,
  InstrumentResolutionError: mocks.InstrumentResolutionError,
}));

import { GET as getPublicIntelligence } from "@/app/api/intelligence/route";
import { GET as getTodayIntelligence } from "@/app/api/intelligence/today/route";
import { POST as postMcp } from "@/app/mcp/route";

const symbolId = "NASDAQ:NVDA" as const;
const generatedAt = "2026-11-12T18:45:00.000Z";
const readPlane = {
  strategy: "durable_plus_request_time" as const,
  requestTimeFailed: true,
  collectedReadFailed: false,
  collectedTruncated: false,
  origins: {
    requestTime: {
      status: "failed" as const,
      candidateCount: 0,
      selectedCount: 0,
    },
    durable: {
      status: "ready" as const,
      candidateCount: 1,
      selectedCount: 1,
    },
  },
};

const feed = {
  data: [
    {
      id: "alpaca:durable-news-1",
      symbolIds: [symbolId],
      source: "alpaca",
      sourceKind: "licensed_news" as const,
      headline: "Durable evidence remains available",
      summary: "The collected receipt survived a request-time outage.",
      publishedAt: "2026-11-12T18:44:00.000Z",
      receivedAt: "2026-11-12T18:44:02.000Z",
      providerUpdatedAt: "2026-11-12T18:44:00.000Z",
      sourceUrl: "https://example.test/durable-news-1",
      materiality: "high" as const,
      isLive: true,
    },
  ],
  meta: {
    dataMode: "live" as const,
    mode: "live" as const,
    providerCoverage: "partial" as const,
    coverage: "partial" as const,
    generatedAt,
    freshness: {
      state: "fresh" as const,
      asOf: "2026-11-12T18:44:00.000Z",
      ageSeconds: 60,
    },
    providers: [],
    fallbackReason: "provider_request_failed" as const,
    notice: "Durable provider receipts are shown.",
    readPlane,
  },
};

function watchlists() {
  return [
    {
      id: "watchlist-default",
      ownerId: "owner-1",
      name: "Core holdings",
      isDefault: true,
      createdAt: generatedAt,
      updatedAt: generatedAt,
      items: [
        {
          watchlistId: "watchlist-default",
          symbolId,
          note: null,
          addedAt: generatedAt,
          ticker: "NVDA",
          exchange: "NASDAQ",
          name: "NVIDIA Corporation",
        },
      ],
    },
  ];
}

async function callTool(name: string, arguments_: Record<string, unknown>) {
  const response = await postMcp(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": "owner-1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    }),
  );
  const body = (await response.json()) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(body.result.content[0].text) as {
    data: unknown;
    meta: Record<string, unknown>;
  };
}

describe("unified intelligence read-plane consumer wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIntelligenceFeed.mockResolvedValue(feed);
    mocks.getChatGPTUser.mockResolvedValue({ userId: "owner-1" });
    mocks.listUserWatchlists.mockResolvedValue(watchlists());
    mocks.resolveCanonicalInstrument.mockResolvedValue({
      id: symbolId,
      ticker: "NVDA",
      exchange: "NASDAQ",
      name: "NVIDIA Corporation",
      sector: "Technology",
      currency: "USD",
      status: "active",
    });
  });

  it("serves the public and authenticated Today APIs from the unified plane", async () => {
    const publicResponse = await getPublicIntelligence(
      new Request(
        "https://omnigaze.test/api/intelligence?symbol=nasdaq:nvda&limit=10",
      ),
    );
    const publicBody = (await publicResponse.json()) as typeof feed;
    expect(publicResponse.status).toBe(200);
    expect(publicBody.meta.readPlane).toEqual(readPlane);

    const todayResponse = await getTodayIntelligence(
      new Request("https://omnigaze.test/api/intelligence/today?limit=10"),
    );
    const todayBody = (await todayResponse.json()) as {
      data: typeof feed.data;
      meta: typeof feed.meta & { scope: string; status: string };
    };
    expect(todayResponse.status).toBe(200);
    expect(todayBody.data).toHaveLength(1);
    expect(todayBody.meta).toMatchObject({
      scope: "personal",
      status: "ready",
      readPlane,
    });
    expect(mocks.getIntelligenceFeed).toHaveBeenCalledTimes(2);
  });

  it("preserves read-plane provenance in both MCP intelligence reads", async () => {
    const publicFeed = await callTool("get_intelligence_feed", {
      symbol_id: symbolId,
      limit: 10,
    });
    expect(publicFeed.meta).toMatchObject({ readPlane });

    const dashboard = await callTool("get_watchlist_dashboard", {});
    expect(dashboard.meta).toMatchObject({
      scope: "personal",
      identity: "authenticated",
      readPlane,
    });
    expect(dashboard.data).toMatchObject({
      symbols: [symbolId],
      events: [{ id: "alpaca:durable-news-1" }],
    });
    expect(mocks.getIntelligenceFeed).toHaveBeenCalledTimes(2);
  });
});
