import { describe, expect, it } from "vitest";
import {
  assertGroundedDailyBrief,
  dailyBriefAnalysisSchema,
  DailyBriefGroundingError,
  parseDailyBriefEnvelope,
} from "@/lib/ai/daily-brief-contract";

function analysis() {
  return {
    headline: "Two watchlist developments deserve attention",
    summary: "Fresh evidence affects two tracked companies.",
    developments: [
      {
        title: "Company updates change the near-term evidence set",
        whyItMatters: "The updates could change investor expectations.",
        direction: "mixed" as const,
        symbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
        evidenceIds: ["evidence:news-1", "evidence:news-2"],
      },
    ],
    watchNext: ["Watch for company confirmation."],
    unknowns: ["The durability of the market reaction remains unknown."],
  };
}

function envelope() {
  return {
    data: {
      ...analysis(),
      briefDate: "2026-11-12",
      window: {
        since: "2026-11-11T18:00:00.000Z",
        through: "2026-11-12T18:00:00.000Z",
      },
    },
    meta: {
      dataMode: "live",
      providerCoverage: "partial",
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      trackedSymbolCount: 3,
      trackedSymbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT", "NASDAQ:AAPL"],
      includedSymbolCount: 2,
      omittedSymbolCount: 1,
      evidenceCount: 2,
      sourceCount: 2,
      evidenceCoverage: { score: 0.68, label: "moderate" },
      citations: [
        {
          id: "evidence:news-1",
          title: "NVIDIA publishes an update",
          publisher: "alpaca",
          publishedAt: "2026-11-12T17:59:00.000Z",
          url: "https://example.test/nvda",
          symbolIds: ["NASDAQ:NVDA"],
          materiality: "high",
          claimStatus: "confirmed",
          isControversial: false,
        },
        {
          id: "evidence:news-2",
          title: "Microsoft publishes an update",
          publisher: "sec-edgar",
          publishedAt: "2026-11-12T17:58:00.000Z",
          url: "https://example.test/msft",
          symbolIds: ["NASDAQ:MSFT"],
          materiality: "medium",
          isControversial: false,
        },
      ],
      promptVersion: "daily-brief-2026-11-12.1",
      generatedAt: "2026-11-12T18:00:02.000Z",
      cache: {
        state: "generated",
        cachedAt: "2026-11-12T18:00:02.000Z",
        expiresAt: "2026-11-13T00:00:02.000Z",
      },
      budget: {
        consumed: true,
        remaining: 4,
        limit: 5,
        resetsAt: "2026-11-13T00:00:00.000Z",
      },
      confidenceMeaning: "evidence_synthesis_not_return_probability",
      disclaimer: "Research support only. This is not investment advice.",
    },
  };
}

describe("Daily Brief contracts", () => {
  it("accepts bounded model output and a strict live envelope", () => {
    expect(dailyBriefAnalysisSchema.parse(analysis())).toMatchObject({
      developments: [{ direction: "mixed" }],
    });
    expect(parseDailyBriefEnvelope(envelope())).toMatchObject({
      data: { briefDate: "2026-11-12" },
      meta: { dataMode: "live", evidenceCount: 2 },
    });
  });

  it("rejects unknown fields, stale/demo metadata, and mismatched counts", () => {
    expect(() =>
      dailyBriefAnalysisSchema.parse({ ...analysis(), targetPrice: 300 }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: { ...envelope().meta, dataMode: "demo" },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          freshness: {
            state: "stale",
            asOf: "2026-11-10T17:59:00.000Z",
            ageSeconds: 172_860,
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: { ...envelope().meta, omittedSymbolCount: 2 },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: envelope().meta.citations.map((citation, index) =>
            index === 0
              ? {
                  ...citation,
                  url: "https://news.example/story?api_key=top-secret&access_token=also-secret",
                }
              : citation,
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: envelope().meta.citations.map((citation, index) =>
            index === 0
              ? { ...citation, url: "https://news.example/story#token=top-secret" }
              : citation,
          ),
        },
      }),
    ).toThrow();
    for (const credentialKey of [
      "api-secret",
      "secret_key",
      "X-Amz-Security-Token",
      "AWSAccessKeyId",
      "GoogleAccessId",
    ]) {
      expect(() =>
        parseDailyBriefEnvelope({
          ...envelope(),
          meta: {
            ...envelope().meta,
            citations: envelope().meta.citations.map((citation, index) =>
              index === 0
                ? {
                    ...citation,
                    url: `https://news.example/story?${credentialKey}=top-secret`,
                  }
                : citation,
            ),
          },
        }),
      ).toThrow();
    }
    expect(
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: envelope().meta.citations.map((citation, index) =>
            index === 0
              ? { ...citation, url: "https://news.example/story?utm_source=brief" }
              : citation,
          ),
        },
      }).meta.citations[0]?.url,
    ).toContain("utm_source=brief");
  });

  it("prevents cache hits from consuming generation budget", () => {
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          cache: { ...envelope().meta.cache, state: "hit" },
          budget: { ...envelope().meta.budget, consumed: true },
        },
      }),
    ).toThrow();
    expect(
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          cache: { ...envelope().meta.cache, state: "hit" },
          budget: {
            consumed: false,
            remaining: null,
            limit: null,
            resetsAt: null,
          },
        },
      }).meta.cache.state,
    ).toBe("hit");
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          cache: { ...envelope().meta.cache, state: "hit" },
          budget: { ...envelope().meta.budget, consumed: false },
        },
      }),
    ).toThrow();

    expect(
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          cache: { ...envelope().meta.cache, state: "deduplicated" },
          budget: {
            consumed: false,
            remaining: null,
            limit: null,
            resetsAt: null,
          },
        },
      }).meta.cache.state,
    ).toBe("deduplicated");
  });

  it("requires the UTC brief date and safe public citation URLs", () => {
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        data: {
          ...envelope().data,
          window: {
            since: "2026-11-12T00:00:00-08:00",
            through: "2026-11-12T23:30:00-08:00",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: envelope().meta.citations.map((citation, index) =>
            index === 0
              ? { ...citation, url: "javascript:alert(1)" }
              : citation,
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: envelope().meta.citations.map((citation, index) =>
            index === 0
              ? { ...citation, url: "https://user:pass@example.test/nvda" }
              : citation,
          ),
        },
      }),
    ).toThrow();
  });

  it("binds freshness and citations to the authenticated watchlist window", () => {
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          trackedSymbolIds: ["NASDAQ:NVDA", "NASDAQ:AAPL", "NASDAQ:TSLA"],
        },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          freshness: {
            ...envelope().meta.freshness,
            asOf: "2026-11-11T17:59:00.000Z",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: envelope().meta.citations.map((citation, index) =>
            index === 0
              ? { ...citation, publishedAt: "2026-11-11T17:59:00.000Z" }
              : citation,
          ),
        },
      }),
    ).toThrow();
  });

  it("accepts only evidence-backed symbols and evidence IDs", () => {
    const output = dailyBriefAnalysisSchema.parse(analysis());
    expect(() =>
      assertGroundedDailyBrief(output, [
        { id: "evidence:news-1", symbolIds: ["NASDAQ:NVDA"] },
        { id: "evidence:news-2", symbolIds: ["NASDAQ:MSFT"] },
      ]),
    ).not.toThrow();

    expect(() =>
      assertGroundedDailyBrief(
        {
          ...output,
          developments: [
            {
              ...output.developments[0],
              evidenceIds: ["evidence:unknown"],
            },
          ],
        },
        [{ id: "evidence:news-1", symbolIds: ["NASDAQ:NVDA"] }],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefGroundingError>>({
        code: "unknown_evidence_id",
      }),
    );
  });

  it("rejects a ticker that is absent from the cited evidence", () => {
    expect(() =>
      assertGroundedDailyBrief(dailyBriefAnalysisSchema.parse(analysis()), [
        {
          id: "evidence:news-1",
          symbolIds: ["NASDAQ:NVDA"],
        },
        {
          id: "evidence:news-2",
          symbolIds: ["NASDAQ:AAPL"],
        },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefGroundingError>>({
        code: "ungrounded_symbol",
      }),
    );
    expect(() =>
      parseDailyBriefEnvelope({
        ...envelope(),
        data: {
          ...envelope().data,
          developments: [
            {
              ...envelope().data.developments[0],
              symbolIds: ["NASDAQ:AAPL"],
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects duplicate evidence catalog IDs and duplicate output references", () => {
    const output = dailyBriefAnalysisSchema.parse(analysis());
    expect(() =>
      assertGroundedDailyBrief(output, [
        { id: "evidence:news-1", symbolIds: ["NASDAQ:NVDA"] },
        { id: "evidence:news-1", symbolIds: ["NASDAQ:MSFT"] },
      ]),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefGroundingError>>({
        code: "duplicate_evidence_id",
      }),
    );

    expect(() =>
      assertGroundedDailyBrief(
        {
          ...output,
          developments: [
            {
              ...output.developments[0],
              evidenceIds: ["evidence:news-1", "evidence:news-1"],
            },
          ],
        },
        [{ id: "evidence:news-1", symbolIds: ["NASDAQ:NVDA"] }],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<DailyBriefGroundingError>>({
        code: "duplicate_output_reference",
      }),
    );
  });
});
