import { describe, expect, it } from "vitest";
import {
  parsePersonalTodayEnvelope,
  personalTodayEnvelopeSchema,
} from "@/lib/api/personal-today-client";

const NOW = "2026-11-12T18:00:00.000Z";

function event(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    symbolIds: ["NASDAQ:NVDA"],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: `Headline ${id}`,
    summary: `Summary ${id}`,
    publishedAt: "2026-11-12T17:00:00.000Z",
    receivedAt: "2026-11-12T17:00:01.000Z",
    sourceUrl: `https://example.test/${id}`,
    materiality: "medium",
    isLive: true,
    category: "market",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["governance"],
    isControversial: false,
    ...overrides,
  };
}

function readyEnvelope(data: unknown[]) {
  return {
    watchlists: [
      {
        id: "watchlist-1",
        name: "Core holdings",
        isDefault: true,
        itemCount: 1,
      },
    ],
    symbols: ["NASDAQ:NVDA"],
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: NOW,
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      providers: [],
      notice: "Live provider evidence.",
      readPlane: {
        strategy: "durable_plus_request_time",
        requestTimeFailed: false,
        collectedReadFailed: false,
        collectedTruncated: false,
        origins: {
          requestTime: { status: "live", candidateCount: 2, selectedCount: 1 },
          durable: { status: "ready", candidateCount: 0, selectedCount: 0 },
        },
      },
      scope: "personal",
      status: "ready",
    },
  };
}

describe("personal Today client contract", () => {
  it("keeps the newest provider revision and drops events outside the tracked universe", () => {
    const parsed = parsePersonalTodayEnvelope(
      readyEnvelope([
        event("same", { headline: "Older headline" }),
        event("outside", { symbolIds: ["NASDAQ:MSFT"] }),
        event("same", {
          headline: "Corrected headline",
          providerUpdatedAt: "2026-11-12T17:45:00.000Z",
          receivedAt: "2026-11-12T17:45:01.000Z",
          symbolIds: ["NASDAQ:NVDA", "NASDAQ:NVDA"],
        }),
      ]),
    );

    expect(parsed.meta.status).toBe("ready");
    expect(parsed.data).toEqual([
      expect.objectContaining({
        id: "same",
        headline: "Corrected headline",
        symbolIds: ["NASDAQ:NVDA"],
      }),
    ]);
  });

  it("canonicalizes safe links and converts malformed or credential-bearing links to null", () => {
    const parsed = parsePersonalTodayEnvelope(
      readyEnvelope([
        event("safe", { sourceUrl: "https://example.test/a/../story" }),
        event("credential", {
          sourceUrl: "https://example.test/story?api_key=do-not-render",
        }),
        event("malformed", { sourceUrl: "javascript:alert(1)" }),
      ]),
    );

    expect(parsed.data.map(({ sourceUrl }) => sourceUrl)).toEqual([
      "https://example.test/story",
      null,
      null,
    ]);
  });

  it("accepts the strict empty-watchlist response and rejects unrecognized fields", () => {
    const empty = {
      watchlists: [],
      symbols: [],
      data: [],
      meta: {
        scope: "personal",
        status: "empty",
        generatedAt: NOW,
        notice: "Add a symbol.",
      },
    };
    expect(parsePersonalTodayEnvelope(empty).meta.status).toBe("empty");
    expect(
      personalTodayEnvelopeSchema.safeParse({
        ...readyEnvelope([event("valid")]),
        investmentConfidence: 0.99,
      }).success,
    ).toBe(false);
    expect(
      personalTodayEnvelopeSchema.safeParse({
        ...empty,
        data: [event("not-empty")],
      }).success,
    ).toBe(false);
  });
});
