import { describe, expect, it } from "vitest";
import { stockWorkspaces } from "@/lib/demo-market-data";
import { buildAnalysisContextFromFeed } from "@/lib/ai/build-analysis-context";
import type {
  IntelligenceFeedItem,
  OrchestrationMeta,
} from "@/lib/services/live-market-data";

const instrument = stockWorkspaces[0].instrument;
const meta: OrchestrationMeta = {
  dataMode: "live",
  mode: "live",
  providerCoverage: "partial",
  coverage: "partial",
  generatedAt: "2026-11-12T18:00:00.000Z",
  freshness: {
    state: "fresh",
    asOf: "2026-11-12T17:59:00.000Z",
    ageSeconds: 60,
  },
  providers: [],
  notice: "Live provider data.",
};

function feedItem(overrides: Partial<IntelligenceFeedItem> = {}): IntelligenceFeedItem {
  return {
    id: "alpaca:news-1",
    symbolIds: [instrument.id],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: "Company publishes a material update",
    summary: "The event was captured from a licensed source.",
    publishedAt: "2026-11-12T17:58:00.000Z",
    receivedAt: "2026-11-12T17:58:02.000Z",
    sourceUrl: "https://example.test/source",
    materiality: "high",
    isLive: true,
    ...overrides,
  };
}

describe("AI analysis context", () => {
  it("creates a one-to-one evidence citation for every feed event", () => {
    const context = buildAnalysisContextFromFeed({
      instrument,
      items: [feedItem()],
      meta,
    });

    expect(context.sourceMode).toBe("live");
    expect(context.evidence).toHaveLength(1);
    expect(context.events[0].evidenceIds).toEqual([context.evidence[0].id]);
    expect(context.evidence[0]).toMatchObject({
      classification: "fact",
      publisher: "alpaca",
      url: "https://example.test/source",
    });
  });

  it("excludes events for another symbol and evidence beyond the cutoff", () => {
    const context = buildAnalysisContextFromFeed({
      instrument,
      items: [
        feedItem({ id: "other-symbol", symbolIds: ["NASDAQ:MSFT"] }),
        feedItem({ id: "future", publishedAt: "2026-11-12T18:00:01.000Z" }),
      ],
      meta,
    });

    expect(context.evidence).toEqual([]);
    expect(context.events).toEqual([]);
  });

  it("maps SEC filings to filing events", () => {
    const context = buildAnalysisContextFromFeed({
      instrument,
      items: [feedItem({ sourceKind: "sec_filing", source: "sec-edgar" })],
      meta,
    });

    expect(context.events[0].category).toBe("filing");
  });
});
