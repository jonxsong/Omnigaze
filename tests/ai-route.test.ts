import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockInstrumentResolutionError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  }
  return {
    analyzeEvidence: vi.fn(),
    resolveCanonicalInstrument: vi.fn(),
    getIntelligenceFeed: vi.fn(),
    getChatGPTUser: vi.fn(),
    InstrumentResolutionError: MockInstrumentResolutionError,
  };
});

vi.mock("@/lib/ai/analyze-evidence", () => ({
  analyzeEvidence: mocks.analyzeEvidence,
  OMNIGAZE_ANALYSIS_PROMPT_VERSION: "test-prompt-v1",
}));

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/services/instrument-resolution", () => ({
  resolveCanonicalInstrument: mocks.resolveCanonicalInstrument,
  InstrumentResolutionError: mocks.InstrumentResolutionError,
}));

vi.mock("@/lib/services/live-market-data", () => ({
  liveMarketData: { getIntelligenceFeed: mocks.getIntelligenceFeed },
}));

import { POST } from "@/app/api/ai/analyze/route";

const meta = {
  dataMode: "live" as const,
  mode: "live" as const,
  providerCoverage: "partial" as const,
  coverage: "partial" as const,
  generatedAt: "2026-11-12T08:00:00.000Z",
  freshness: {
    state: "fresh" as const,
    asOf: "2026-11-12T07:59:00.000Z",
    ageSeconds: 60,
  },
  providers: [],
  notice: "Live provider data.",
};

function analyzeRequest(body: unknown) {
  return new Request("https://omnigaze.test/api/ai/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("AI analysis route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "user-a",
      email: "a@example.test",
      fullName: "A User",
    });
    mocks.resolveCanonicalInstrument.mockResolvedValue({
      id: "NYSE:IBM",
      ticker: "IBM",
      exchange: "NYSE",
      name: "International Business Machines Corporation",
      sector: null,
      currency: "USD",
      status: "active",
    });
    mocks.getIntelligenceFeed.mockResolvedValue({
      data: [
        {
          id: "alpaca:ibm-news-1",
          symbolIds: ["NYSE:IBM"],
          source: "alpaca",
          sourceKind: "licensed_news",
          headline: "IBM publishes a material update",
          summary: "The update is available for review.",
          publishedAt: "2026-11-12T07:59:00.000Z",
          receivedAt: "2026-11-12T07:59:01.000Z",
          sourceUrl: "https://example.test/ibm",
          materiality: "high",
          isLive: true,
        },
      ],
      meta,
    });
    mocks.analyzeEvidence.mockResolvedValue({
      stance: "mixed",
      confidence: 0.5,
      headline: "Evidence is mixed",
      summary: "The evidence has both supportive and limiting signals.",
      whyNow: "A new source event changed the evidence set.",
      drivers: [
        {
          label: "Company update",
          direction: "mixed",
          explanation: "The update adds current context.",
          evidenceIds: ["evidence:alpaca:ibm-news-1"],
        },
      ],
      unknowns: ["The durability of the change is unknown."],
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("analyzes an arbitrary server-verified equity without fixture identity fallback", async () => {
    const response = await POST(analyzeRequest({ symbol_id: "nyse:ibm" }));
    const body = (await response.json()) as {
      meta: {
        symbolId: string;
        dataMode: string;
        evidenceCount: number;
        promptVersion: string;
      };
    };

    expect(response.status).toBe(200);
    expect(mocks.resolveCanonicalInstrument).toHaveBeenCalledWith("NYSE:IBM");
    expect(mocks.analyzeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: expect.objectContaining({
          id: "NYSE:IBM",
          ticker: "IBM",
          name: "International Business Machines Corporation",
        }),
      }),
    );
    expect(body.meta).toMatchObject({
      symbolId: "NYSE:IBM",
      dataMode: "live",
      evidenceCount: 1,
      promptVersion: "test-prompt-v1",
    });
    expect(JSON.stringify(body)).not.toContain("NVDA");
  });

  it("rejects anonymous model calls before provider or AI work", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);

    const response = await POST(analyzeRequest({ symbol_id: "NYSE:IBM" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "Authentication required.",
      code: "auth_required",
    });
    expect(mocks.resolveCanonicalInstrument).not.toHaveBeenCalled();
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
  });

  it("fails closed when the symbol cannot be verified", async () => {
    mocks.resolveCanonicalInstrument.mockRejectedValue(
      new mocks.InstrumentResolutionError("symbol_not_supported"),
    );

    const response = await POST(
      analyzeRequest({ symbol_id: "NASDAQ:NOTREAL" }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Symbol not found.",
      code: "symbol_not_supported",
    });
    expect(mocks.getIntelligenceFeed).not.toHaveBeenCalled();
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
  });

  it("requires current evidence before invoking the model", async () => {
    mocks.getIntelligenceFeed.mockResolvedValue({ data: [], meta });

    const response = await POST(analyzeRequest({ symbol_id: "NYSE:IBM" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "insufficient_evidence" });
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
  });
});
