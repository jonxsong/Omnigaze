import { describe, expect, it, vi } from "vitest";
import type {
  CollectedSourceEvent,
  ListCollectedEventsInput,
} from "@/lib/ingestion/contracts";
import {
  getCollectedIntelligenceFeedForScopes,
  projectCollectedSourceEvent,
} from "@/lib/services/collected-intelligence";

function collected(
  overrides: Partial<CollectedSourceEvent> = {},
): CollectedSourceEvent {
  return {
    receiptId: "src_version_hash",
    provider: "alpaca",
    sourceKind: "licensed_news",
    sourceEventId: "42",
    publishedAt: "2026-10-01T07:00:00.000Z",
    observedAt: "2026-11-12T07:50:00.000Z",
    providerRevisionAt: "2026-11-12T07:49:00.000Z",
    effectiveAt: "2026-11-12T07:49:00.000Z",
    lastSeenAt: "2026-11-12T07:50:00.000Z",
    symbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
    payloadPolicy: "minimal_redacted_v1",
    envelope: {
      schema: "omnigaze.provider-receipt.v1",
      headline: "CEO controversy prompts a board investigation",
      summary: "The report remains an allegation while the review continues.",
      url: "https://example.test/news/42",
      contentDigest: "a".repeat(64),
    },
    ...overrides,
  };
}

describe("collected intelligence projection", () => {
  it("maps correction versions to stable provider identity and tracked symbols", () => {
    const projected = projectCollectedSourceEvent(
      collected(),
      new Set(["NASDAQ:NVDA"]),
    );

    expect(projected).toMatchObject({
      id: "alpaca:42",
      symbolIds: ["NASDAQ:NVDA"],
      source: "alpaca",
      sourceKind: "licensed_news",
      publishedAt: "2026-10-01T07:00:00.000Z",
      providerUpdatedAt: "2026-11-12T07:49:00.000Z",
      sourceUrl: "https://example.test/news/42",
      isLive: true,
      category: "governance",
      claimStatus: "official-investigation",
      isControversial: true,
    });
    expect(projected?.id).not.toContain("src_version_hash");
  });

  it("fails closed on malformed envelopes and untracked symbols", () => {
    expect(
      projectCollectedSourceEvent(
        collected({
          envelope: {
            schema: "unexpected",
            headline: "Headline",
            summary: null,
            url: null,
            contentDigest: "a".repeat(64),
          },
        }),
        new Set(["NASDAQ:NVDA"]),
      ),
    ).toBeNull();
    expect(
      projectCollectedSourceEvent(
        collected(),
        new Set(["NYSE:IBM"]),
      ),
    ).toBeNull();
  });

  it("does not surface unsafe URL schemes", () => {
    expect(
      projectCollectedSourceEvent(
        collected({
          envelope: {
            ...collected().envelope,
            url: "javascript:alert(1)",
          },
        }),
        new Set(["NASDAQ:NVDA"]),
      )?.sourceUrl,
    ).toBeNull();
  });

  it("projects SEC filing amendments with stable identity and base-form materiality", () => {
    const projected = projectCollectedSourceEvent(
      collected({
        provider: "sec-edgar",
        sourceKind: "sec_filing",
        sourceEventId: "0001045810-26-000042",
        envelope: {
          schema: "omnigaze.provider-receipt.v1",
          headline: "10-Q/A filed with the SEC",
          summary: "A regulatory filing is available for evidence review.",
          url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000042/report.htm",
          contentDigest: "b".repeat(64),
        },
      }),
      new Set(["NASDAQ:NVDA"]),
    );

    expect(projected).toMatchObject({
      id: "sec-edgar:0001045810-26-000042",
      source: "sec-edgar",
      sourceKind: "sec_filing",
      headline: "10-Q/A filed with the SEC",
      materiality: "high",
      category: "filing",
      claimStatus: "confirmed",
      causalLink: "unassessed",
      topicTags: ["filing", "amendment"],
      isControversial: false,
      isLive: true,
    });
  });

  it("decodes stored display text before classification without changing the durable envelope", () => {
    const event = collected({
      envelope: {
        ...collected().envelope,
        headline: "CEO&#39;s board investigati&#x6f;n &amp; review",
        summary:
          "Management &amp;amp; directors opened an independent investigation.",
      },
    });
    const originalEnvelope = event.envelope;

    expect(
      projectCollectedSourceEvent(event, new Set(["NASDAQ:NVDA"])),
    ).toMatchObject({
      headline: "CEO's board investigation & review",
      summary: "Management & directors opened an independent investigation.",
      category: "governance",
      claimStatus: "official-investigation",
    });
    expect(event.envelope).toBe(originalEnvelope);
    expect(event.envelope.headline).toContain("&#39;");
    expect(event.envelope.summary).toContain("&amp;amp;");
  });

  it("rejects a stored headline that is blank after entity decoding", () => {
    const event = collected({
      envelope: {
        ...collected().envelope,
        headline: "&nbsp;",
        summary: "&#160;",
      },
    });

    expect(
      projectCollectedSourceEvent(event, new Set(["NASDAQ:NVDA"])),
    ).toBeNull();
  });

  it("merges bounded provider partitions once and keeps the newest immutable version", async () => {
    const older = collected({
      receiptId: "src_old",
      providerRevisionAt: "2026-11-12T07:49:00.000Z",
      effectiveAt: "2026-11-12T07:49:00.000Z",
      observedAt: "2026-11-12T07:50:00.000Z",
      envelope: {
        ...collected().envelope,
        headline: "Older correction",
      },
    });
    const newer = collected({
      receiptId: "src_new",
      providerRevisionAt: "2026-11-12T07:55:00.000Z",
      effectiveAt: "2026-11-12T07:55:00.000Z",
      observedAt: "2026-11-12T07:56:00.000Z",
      envelope: {
        ...collected().envelope,
        headline: "Newer correction",
      },
    });
    const filing = collected({
      receiptId: "src_filing",
      provider: "sec-edgar",
      sourceKind: "sec_filing",
      sourceEventId: "0001045810-26-000043",
      providerRevisionAt: "2026-11-12T07:52:00.000Z",
      effectiveAt: "2026-11-12T07:52:00.000Z",
      envelope: {
        schema: "omnigaze.provider-receipt.v1",
        headline: "8-K filed with the SEC",
        summary: "A regulatory filing is available for evidence review.",
        url: null,
        contentDigest: "c".repeat(64),
      },
    });
    const listCollectedEvents = vi.fn(async ({ partitionKey }: ListCollectedEventsInput) => ({
      items:
        partitionKey === "news-a"
          ? [older]
          : partitionKey === "news-b"
            ? [newer]
            : [filing],
      hasMore: partitionKey === "filings",
      nextBefore: null,
    }));

    const result = await getCollectedIntelligenceFeedForScopes(
      {
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-12T07:00:00.000Z",
        limit: 10,
        scopes: [
          { provider: "alpaca", partitionKey: "news-a" },
          { provider: "alpaca", partitionKey: "news-b" },
          { provider: "sec-edgar", partitionKey: "filings" },
        ],
      },
      { listCollectedEvents },
    );

    expect(result.hasMore).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data.map((item) => item.id)).toEqual([
      "alpaca:42",
      "sec-edgar:0001045810-26-000043",
    ]);
    expect(result.data[0].headline).toBe("Newer correction");
    expect(listCollectedEvents).toHaveBeenCalledTimes(3);
  });
});
