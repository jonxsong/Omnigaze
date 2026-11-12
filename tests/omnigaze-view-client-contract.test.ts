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
      },
    });
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
