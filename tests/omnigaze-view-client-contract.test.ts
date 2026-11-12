import { describe, expect, it } from "vitest";
import { parseOmnigazeViewEnvelope } from "@/lib/ai/omnigaze-view-client-contract";

function envelope() {
  return {
    data: {
      stance: "mixed",
      confidence: 0.58,
      headline: "Current evidence is mixed",
      summary: "The evidence contains supportive and limiting signals.",
      whyNow: "A new company update changed the evidence set.",
      drivers: [
        {
          label: "Company update",
          direction: "mixed",
          explanation: "The update adds current context.",
          evidenceIds: ["evidence:alpaca:news-1"],
        },
      ],
      unknowns: ["Durability remains unknown."],
    },
    meta: {
      symbolId: "NYSE:IBM",
      dataCutoff: "2026-11-12T18:00:00.000Z",
      generatedAt: "2026-11-12T18:00:02.000Z",
      promptVersion: "2026-11-12.1",
      dataMode: "live",
      providerCoverage: "partial",
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      evidenceCount: 1,
      eventCount: 1,
      sources: ["alpaca"],
      evidenceCoverage: {
        score: 0.4,
        label: "limited",
        evidenceCount: 1,
        sourceCount: 1,
      },
      citations: [
        {
          id: "evidence:alpaca:news-1",
          title: "IBM publishes a material update",
          publisher: "alpaca",
          publishedAt: "2026-11-12T17:59:00.000Z",
          url: "https://example.test/ibm",
          classification: "fact",
        },
      ],
      ai: {
        source: "generated",
        deduplicated: false,
        modelConfig: "openai-agents-sdk-default",
        evidenceFingerprint: "a".repeat(64),
        cacheExpiresAt: "2026-11-12T18:05:02.000Z",
        servedAt: "2026-11-12T18:00:02.000Z",
        budget: {
          charged: true,
          remaining: 19,
          limit: 20,
          resetAt: "2026-11-13T00:00:00.000Z",
        },
      },
      confidenceMeaning: "evidence_interpretation_not_return_probability",
      disclaimer: "Research support only. This is not investment advice.",
    },
  };
}

describe("Omnigaze View client contract", () => {
  it("accepts the live evidence-backed response", () => {
    expect(parseOmnigazeViewEnvelope(envelope())).toMatchObject({
      meta: {
        symbolId: "NYSE:IBM",
        dataMode: "live",
        evidenceCoverage: { label: "limited" },
        ai: { source: "generated", budget: { charged: true, remaining: 19 } },
      },
    });
  });

  it("remains compatible with a live response from before guard metadata", () => {
    const value = envelope();
    const { ai, ...meta } = value.meta;

    expect(ai).toBeDefined();
    expect(parseOmnigazeViewEnvelope({ ...value, meta })).toMatchObject({
      meta: { symbolId: "NYSE:IBM", dataMode: "live" },
    });
  });

  it("accepts a cache hit only when no generation budget was charged", () => {
    const base = envelope();
    const value = {
      ...base,
      meta: {
        ...base.meta,
        ai: {
          ...base.meta.ai,
          source: "cache",
          budget: {
            charged: false,
            remaining: null,
            limit: null,
            resetAt: null,
          },
        },
      },
    };

    expect(parseOmnigazeViewEnvelope(value)).toMatchObject({
      meta: { ai: { source: "cache", budget: { charged: false } } },
    });
  });

  it("rejects dishonest cache or deduplication budget metadata", () => {
    expect(() =>
      parseOmnigazeViewEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          ai: { ...envelope().meta.ai, source: "cache" },
        },
      }),
    ).toThrow();
    expect(() =>
      parseOmnigazeViewEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          ai: { ...envelope().meta.ai, deduplicated: true },
        },
      }),
    ).toThrow();
  });

  it("rejects demo or stale responses at the client boundary", () => {
    expect(() =>
      parseOmnigazeViewEnvelope({
        ...envelope(),
        meta: { ...envelope().meta, dataMode: "demo" },
      }),
    ).toThrow();
    expect(() =>
      parseOmnigazeViewEnvelope({
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
  });

  it("rejects missing citations and non-positive evidence counts", () => {
    expect(() =>
      parseOmnigazeViewEnvelope({
        ...envelope(),
        meta: {
          ...envelope().meta,
          citations: [],
          evidenceCount: 0,
        },
      }),
    ).toThrow();
  });
});
