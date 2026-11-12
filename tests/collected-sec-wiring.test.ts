import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectedSourceEvent } from "@/lib/ingestion/contracts";

const mocks = vi.hoisted(() => ({
  listCollectedEvents: vi.fn(),
}));

vi.mock("@/lib/ingestion/repository", () => ({
  ingestionRepository: {
    listCollectedEvents: mocks.listCollectedEvents,
  },
}));

import { getCollectedIntelligenceFeed } from "@/lib/services/collected-intelligence";

const filing: CollectedSourceEvent = {
  receiptId: "src_filing",
  provider: "sec-edgar",
  sourceKind: "sec_filing",
  sourceEventId: "0001045810-26-000042",
  publishedAt: "2026-11-12T07:50:00.000Z",
  observedAt: "2026-11-12T07:50:01.000Z",
  providerRevisionAt: "2026-11-12T07:50:00.000Z",
  effectiveAt: "2026-11-12T07:50:00.000Z",
  lastSeenAt: "2026-11-12T07:50:02.000Z",
  symbolIds: ["NASDAQ:NVDA"],
  payloadPolicy: "minimal_redacted_v1",
  envelope: {
    schema: "omnigaze.provider-receipt.v1",
    headline: "8-K/A filed with the SEC",
    summary: "A regulatory filing is available for evidence review.",
    url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000042/report.htm",
    contentDigest: "a".repeat(64),
  },
};

describe("default durable SEC read wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    mocks.listCollectedEvents.mockImplementation(
      async ({ provider }: { provider: string }) => ({
        items: provider === "sec-edgar" ? [filing] : [],
        hasMore: false,
        nextBefore: null,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps retained filings visible with collection and request-time SEC both off", async () => {
    const result = await getCollectedIntelligenceFeed(
      {
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-12T07:00:00.000Z",
        limit: 20,
      },
      {
        ALPACA_INGESTION_SYMBOLS: "NASDAQ:MSFT",
        SEC_DURABLE_INGESTION_ENABLED: "false",
        SEC_EDGAR_ENABLED: "false",
        SEC_INGESTION_SYMBOLS: "NASDAQ:MSFT",
      },
    );

    expect(result.data).toEqual([
      expect.objectContaining({
        id: "sec-edgar:0001045810-26-000042",
        sourceKind: "sec_filing",
        headline: "8-K/A filed with the SEC",
        topicTags: ["filing", "amendment"],
      }),
    ]);
    expect(mocks.listCollectedEvents).toHaveBeenCalledOnce();
    expect(mocks.listCollectedEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "sec-edgar",
        symbolIds: ["NASDAQ:NVDA"],
      }),
    );
    expect(mocks.listCollectedEvents.mock.calls[0][0]).not.toHaveProperty(
      "partitionKey",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
