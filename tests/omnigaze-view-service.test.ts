import { describe, expect, it, vi } from "vitest";
import type { OmnigazeAnalysis } from "@/lib/ai/analysis-contract";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { OrchestratedIntelligenceFeed } from "@/lib/services/live-market-data";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";
import {
  generateOmnigazeView,
  OmnigazeViewError,
} from "@/lib/services/omnigaze-view";

const symbolId = "NYSE:IBM" as CanonicalSymbol;
const now = new Date("2026-11-12T18:00:00.000Z");

const analysis: OmnigazeAnalysis = {
  stance: "mixed",
  confidence: 0.58,
  headline: "Current evidence is mixed",
  summary: "The latest evidence contains both supportive and limiting signals.",
  whyNow: "A new company update changed the evidence set.",
  drivers: [
    {
      label: "Company update",
      direction: "mixed",
      explanation: "The current update adds relevant context.",
      evidenceIds: ["evidence:alpaca:news-1"],
    },
  ],
  unknowns: ["The durability of the development remains unknown."],
};

function liveFeed(
  overrides: Partial<OrchestratedIntelligenceFeed> = {},
): OrchestratedIntelligenceFeed {
  return {
    data: [
      {
        id: "alpaca:news-1",
        symbolIds: [symbolId],
        source: "alpaca",
        sourceKind: "licensed_news",
        headline: "IBM publishes a material update",
        summary: "The update is available for review.",
        publishedAt: "2026-11-12T17:59:00.000Z",
        receivedAt: "2026-11-12T17:59:02.000Z",
        providerUpdatedAt: "2026-11-12T17:59:00.000Z",
        sourceUrl: "https://example.test/ibm",
        materiality: "high",
        isLive: true,
      },
    ],
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: now.toISOString(),
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:59:00.000Z",
        ageSeconds: 60,
      },
      providers: [],
      notice: "Live provider data.",
    },
    ...overrides,
  };
}

function dependencies(feed = liveFeed()) {
  return {
    isAiConfigured: () => true,
    now: () => now,
    resolveInstrument: vi.fn().mockResolvedValue({
      id: symbolId,
      ticker: "IBM",
      exchange: "NYSE",
      name: "International Business Machines Corporation",
      sector: null,
      currency: "USD" as const,
      status: "active" as const,
    }),
    getIntelligenceFeed: vi.fn().mockResolvedValue(feed),
    analyze: vi.fn().mockResolvedValue(analysis),
  };
}

async function expectViewError(
  promise: Promise<unknown>,
  code: OmnigazeViewError["code"],
) {
  await expect(promise).rejects.toMatchObject({
    name: "OmnigazeViewError",
    code,
  });
}

describe("generateOmnigazeView", () => {
  it("generates a cited view for an arbitrary verified symbol", async () => {
    const deps = dependencies();

    const result = await generateOmnigazeView(symbolId, deps);

    expect(deps.getIntelligenceFeed).toHaveBeenCalledWith({
      symbols: [symbolId],
      since: "2026-11-05T18:00:00.000Z",
      limit: 30,
    });
    expect(deps.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: expect.objectContaining({ id: symbolId, ticker: "IBM" }),
        evidence: [
          expect.objectContaining({
            id: "evidence:alpaca:news-1",
            publisher: "alpaca",
          }),
        ],
      }),
    );
    expect(result).toMatchObject({
      data: analysis,
      meta: {
        symbolId,
        dataMode: "live",
        providerCoverage: "partial",
        freshness: { state: "fresh", ageSeconds: 60 },
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
          expect.objectContaining({
            id: "evidence:alpaca:news-1",
            title: "IBM publishes a material update",
          }),
        ],
      },
    });
  });

  it("fails closed before model work when only demo evidence is available", async () => {
    const deps = dependencies(
      liveFeed({
        meta: {
          ...liveFeed().meta,
          dataMode: "demo",
          mode: "demo",
          providerCoverage: "demo",
          coverage: "demo",
          freshness: { state: "fixture", asOf: null, ageSeconds: null },
        },
      }),
    );

    await expectViewError(
      generateOmnigazeView(symbolId, deps),
      "live_evidence_required",
    );
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("fails closed before model work when provider evidence is stale", async () => {
    const deps = dependencies(
      liveFeed({
        meta: {
          ...liveFeed().meta,
          freshness: {
            state: "stale",
            asOf: "2026-11-10T17:59:00.000Z",
            ageSeconds: 172_860,
          },
        },
      }),
    );

    await expectViewError(
      generateOmnigazeView(symbolId, deps),
      "fresh_evidence_required",
    );
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("rejects a nominally live envelope containing no live relevant items", async () => {
    const feed = liveFeed();
    feed.data = feed.data.map((item) => ({ ...item, isLive: false }));
    const deps = dependencies(feed);

    await expectViewError(
      generateOmnigazeView(symbolId, deps),
      "insufficient_evidence",
    );
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("maps known instrument failures to stable public error codes", async () => {
    const deps = dependencies();
    deps.resolveInstrument.mockRejectedValue(
      new InstrumentResolutionError("symbol_not_supported"),
    );

    await expectViewError(
      generateOmnigazeView(symbolId, deps),
      "symbol_not_supported",
    );
    expect(deps.getIntelligenceFeed).not.toHaveBeenCalled();
  });

  it("checks AI configuration before provider or catalog work", async () => {
    const deps = dependencies();

    await expectViewError(
      generateOmnigazeView(symbolId, {
        ...deps,
        isAiConfigured: () => false,
      }),
      "ai_unconfigured",
    );
    expect(deps.resolveInstrument).not.toHaveBeenCalled();
    expect(deps.getIntelligenceFeed).not.toHaveBeenCalled();
  });
});
