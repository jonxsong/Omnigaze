import { describe, expect, it } from "vitest";
import type { CollectedSourceEvent } from "@/lib/ingestion/contracts";
import { projectCollectedSourceEvent } from "@/lib/services/collected-intelligence";

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
});
