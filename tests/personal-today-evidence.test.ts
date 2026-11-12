import { describe, expect, it } from "vitest";
import type { CanonicalSymbol, Materiality } from "@/lib/market-types";
import type {
  IntelligenceFeedItem,
  OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";
import {
  dailyBriefEvidenceCoverage,
  DailyBriefEvidenceError,
  selectDailyBriefEvidence,
} from "@/lib/services/personal-today-evidence";

const NOW = new Date("2026-11-12T18:00:00.000Z");

function event(
  id: string,
  symbolIds: CanonicalSymbol[],
  options: Partial<IntelligenceFeedItem> & { materiality?: Materiality } = {},
): IntelligenceFeedItem {
  return {
    id,
    symbolIds,
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: `Headline ${id}`,
    summary: `Summary ${id}`,
    publishedAt: "2026-11-12T17:00:00.000Z",
    receivedAt: "2026-11-12T17:00:01.000Z",
    sourceUrl: `https://example.test/${id}`,
    materiality: options.materiality ?? "medium",
    isLive: true,
    category: "market",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["update"],
    isControversial: false,
    ...options,
  };
}

function feed(
  data: IntelligenceFeedItem[],
  meta: Partial<OrchestratedIntelligenceFeed["meta"]> = {},
): OrchestratedIntelligenceFeed {
  return {
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: NOW.toISOString(),
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      providers: [],
      notice: "Live provider evidence.",
      ...meta,
    },
  };
}

describe("personal Today evidence selection", () => {
  it("prefers material events while giving tracked symbols diverse representation", () => {
    const result = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:MSFT", "NASDAQ:NVDA"],
      feed: feed([
        event("nvda-critical", ["NASDAQ:NVDA"], {
          materiality: "critical",
          publishedAt: "2026-11-12T17:55:00.000Z",
        }),
        event("nvda-high", ["NASDAQ:NVDA"], {
          materiality: "high",
          publishedAt: "2026-11-12T17:58:00.000Z",
        }),
        event("msft-low", ["NASDAQ:MSFT"], {
          materiality: "low",
          publishedAt: "2026-11-12T16:00:00.000Z",
        }),
      ]),
      now: NOW,
      maxEvents: 2,
    });

    expect(result.items.map((item) => item.eventId)).toEqual([
      "nvda-critical",
      "msft-low",
    ]);
    expect(result.includedSymbols).toEqual(["NASDAQ:MSFT", "NASDAQ:NVDA"]);
    expect(result.omittedSymbols).toEqual([]);
    expect(result.omittedEventCount).toBe(1);
  });

  it("removes demo, global, untracked, future, old, and malformed evidence", () => {
    const valid = event("valid", ["NASDAQ:NVDA"]);
    const result = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:NVDA"],
      feed: feed([
        valid,
        event("fixture", ["NASDAQ:NVDA"], {
          isLive: false,
          sourceKind: "demo_fixture",
        }),
        event("global", []),
        event("other", ["NASDAQ:MSFT"]),
        event("future", ["NASDAQ:NVDA"], {
          publishedAt: "2026-11-12T18:00:01.000Z",
        }),
        event("old", ["NASDAQ:NVDA"], {
          publishedAt: "2026-11-11T17:59:59.999Z",
        }),
        event("bad-date", ["NASDAQ:NVDA"], { publishedAt: "not-a-date" }),
        event("fake-live-fixture", ["NASDAQ:NVDA"], {
          isLive: true,
          sourceKind: "demo_fixture",
        }),
      ]),
      now: NOW,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      eventId: "valid",
      id: "evidence:valid",
      symbolIds: ["NASDAQ:NVDA"],
    });
  });

  it("uses the newest provider revision for a stable event identity", () => {
    const result = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:NVDA"],
      feed: feed([
        event("corrected", ["NASDAQ:NVDA"], {
          headline: "Older headline",
          materiality: "critical",
          providerUpdatedAt: "2026-11-12T17:10:00.000Z",
        }),
        event("corrected", ["NASDAQ:NVDA"], {
          headline: "Corrected headline",
          materiality: "medium",
          providerUpdatedAt: "2026-11-12T17:50:00.000Z",
          claimStatus: "corrected",
        }),
      ]),
      now: NOW,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        eventId: "corrected",
        headline: "Corrected headline",
        claimStatus: "corrected",
      }),
    ]);
  });

  it("is deterministic across provider ordering and canonicalizes safe fields", () => {
    const first = event("first", ["NASDAQ:NVDA", "NASDAQ:NVDA"], {
      topicTags: [" governance ", "governance", "executive"],
      summary: "  A summary with   normalized spacing. ",
      sourceUrl: "javascript:alert(1)",
    });
    const second = event("second", ["NASDAQ:MSFT"], {
      publishedAt: "2026-11-12T17:30:00.000Z",
    });
    const a = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
      feed: feed([first, second]),
      now: NOW,
    });
    const b = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:MSFT", "NASDAQ:NVDA"],
      feed: feed([second, first]),
      now: NOW,
    });

    expect(a).toEqual(b);
    expect(a.items.find((item) => item.eventId === "first")).toMatchObject({
      symbolIds: ["NASDAQ:NVDA"],
      topicTags: ["executive", "governance"],
      summary: "A summary with normalized spacing.",
      sourceUrl: null,
    });

    const credentialUrl = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:NVDA"],
      feed: feed([
        event("credential-url", ["NASDAQ:NVDA"], {
          sourceUrl: "https://news.example/story?api_key=top-secret",
        }),
      ]),
      now: NOW,
    });
    expect(credentialUrl.items[0]?.sourceUrl).toBeNull();
  });

  it("fails closed for demo, stale, unknown, future-dated, or empty evidence", () => {
    const live = [event("valid", ["NASDAQ:NVDA"])];
    const attempts = [
      feed(live, { dataMode: "demo", mode: "demo" }),
      feed(live, {
        freshness: {
          state: "stale",
          asOf: "2026-11-11T17:59:00.000Z",
          ageSeconds: 86_460,
        },
      }),
      feed(live, {
        freshness: { state: "unknown", asOf: null, ageSeconds: null },
      }),
      feed(live, {
        freshness: {
          state: "fresh",
          asOf: "2026-11-12T18:00:01.000Z",
          ageSeconds: 0,
        },
      }),
      feed(live, {
        freshness: {
          state: "fresh",
          asOf: "2026-11-11T17:59:59.000Z",
          ageSeconds: 0,
        },
      }),
    ];

    expect(() =>
      selectDailyBriefEvidence({
        trackedSymbols: ["NASDAQ:NVDA"],
        feed: attempts[0],
        now: NOW,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefEvidenceError>>({
        code: "live_evidence_required",
      }),
    );
    for (const candidate of attempts.slice(1)) {
      expect(() =>
        selectDailyBriefEvidence({
          trackedSymbols: ["NASDAQ:NVDA"],
          feed: candidate,
          now: NOW,
        }),
      ).toThrowError(
        expect.objectContaining<Partial<DailyBriefEvidenceError>>({
          code: "fresh_evidence_required",
        }),
      );
    }
    expect(() =>
      selectDailyBriefEvidence({
        trackedSymbols: ["NASDAQ:NVDA"],
        feed: feed([]),
        now: NOW,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefEvidenceError>>({
        code: "insufficient_evidence",
      }),
    );
  });

  it("rejects empty/invalid watchlists and invalid selection bounds", () => {
    expect(() =>
      selectDailyBriefEvidence({ trackedSymbols: [], feed: feed([]), now: NOW }),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefEvidenceError>>({
        code: "empty_watchlist",
      }),
    );
    expect(() =>
      selectDailyBriefEvidence({
        trackedSymbols: ["NVDA" as CanonicalSymbol],
        feed: feed([]),
        now: NOW,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefEvidenceError>>({
        code: "invalid_request",
      }),
    );
    expect(() =>
      selectDailyBriefEvidence({
        trackedSymbols: ["NASDAQ:NVDA"],
        feed: feed([event("valid", ["NASDAQ:NVDA"])]),
        now: NOW,
        maxEvents: 13,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefEvidenceError>>({
        code: "invalid_request",
      }),
    );
  });

  it("reports deterministic coverage without presenting it as confidence", () => {
    const selection = selectDailyBriefEvidence({
      trackedSymbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
      feed: feed([
        event("nvda", ["NASDAQ:NVDA"]),
        event("msft", ["NASDAQ:MSFT"], { source: "sec-edgar" }),
      ]),
      now: NOW,
    });
    expect(dailyBriefEvidenceCoverage(selection)).toEqual({
      score: 0.58,
      label: "moderate",
    });
  });
});
