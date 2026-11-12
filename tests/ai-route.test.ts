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
    findCachedView: vi.fn(),
    putCachedView: vi.fn(),
    reserveBudget: vi.fn(),
    completeBudget: vi.fn(),
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

vi.mock("@/lib/ai/guardrails-repository", () => ({
  aiGuardrailsRepository: {
    findCachedView: mocks.findCachedView,
    putCachedView: mocks.putCachedView,
    reserveBudget: mocks.reserveBudget,
    completeBudget: mocks.completeBudget,
  },
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
    mocks.findCachedView.mockResolvedValue(null);
    mocks.putCachedView.mockResolvedValue(undefined);
    mocks.reserveBudget.mockImplementation(() =>
      Promise.resolve({
        granted: true,
        reservationId: "reservation-route-1",
        remaining: 19,
        limit: 20,
        resetAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      }),
    );
    mocks.completeBudget.mockResolvedValue(undefined);
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
    mocks.analyzeEvidence.mockResolvedValueOnce({
      stance: "mixed",
      confidence: 0.5,
      headline: "证据呈现混合信号",
      summary: "最新证据同时包含支持与限制因素。",
      whyNow: "新的公司公告改变了当前证据集。",
      drivers: [
        {
          label: "公司公告",
          direction: "mixed",
          explanation: "该公告提供了新的近期背景。",
          evidenceIds: ["evidence:alpaca:ibm-news-1"],
        },
      ],
      unknowns: ["相关影响能否持续仍不明确。"],
    });
    const response = await POST(
      analyzeRequest({
        symbol_id: "nyse:ibm",
        request_id: "route-request-1",
        locale: "zh-CN",
      }),
    );
    const body = (await response.json()) as {
      meta: {
        symbolId: string;
        dataMode: string;
        evidenceCount: number;
        promptVersion: string;
        ai: {
          source: string;
          budget: { charged: boolean };
        };
      };
    };

    expect(response.status).toBe(200);
    expect(mocks.resolveCanonicalInstrument).toHaveBeenCalledWith("NYSE:IBM");
    expect(mocks.reserveBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "user-a",
        requestId: "route-request-1",
      }),
    );
    expect(mocks.analyzeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        instrument: expect.objectContaining({
          id: "NYSE:IBM",
          ticker: "IBM",
          name: "International Business Machines Corporation",
        }),
        locale: "zh-CN",
      }),
    );
    expect(body.meta).toMatchObject({
      symbolId: "NYSE:IBM",
      dataMode: "live",
      evidenceCount: 1,
      promptVersion: "2026-11-12.1:zh-CN",
      ai: expect.objectContaining({
        source: "generated",
        budget: expect.objectContaining({ charged: true }),
      }),
    });
    expect(response.headers.get("x-omnigaze-ai-cache")).toBe("miss");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(body)).not.toContain("NVDA");
  });

  it("rejects unsupported analysis locales at the strict HTTP boundary", async () => {
    const response = await POST(
      analyzeRequest({ symbol_id: "NYSE:IBM", locale: "zh-TW" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(mocks.resolveCanonicalInstrument).not.toHaveBeenCalled();
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
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

  it("does not invoke the model for demo evidence", async () => {
    mocks.getIntelligenceFeed.mockResolvedValue({
      data: [],
      meta: {
        ...meta,
        dataMode: "demo",
        mode: "demo",
        providerCoverage: "demo",
        coverage: "demo",
        freshness: { state: "fixture", asOf: null, ageSeconds: null },
      },
    });

    const response = await POST(analyzeRequest({ symbol_id: "NYSE:IBM" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "live_evidence_required",
    });
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
  });

  it("does not invoke the model for stale evidence", async () => {
    mocks.getIntelligenceFeed.mockResolvedValue({
      data: [],
      meta: {
        ...meta,
        freshness: {
          state: "stale",
          asOf: "2026-11-10T08:00:00.000Z",
          ageSeconds: 172_800,
        },
      },
    });

    const response = await POST(analyzeRequest({ symbol_id: "NYSE:IBM" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "fresh_evidence_required",
    });
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
  });

  it("returns honest retry metadata when the user's rolling budget is full", async () => {
    const retryAt = new Date(Date.now() + 45_000).toISOString();
    mocks.reserveBudget.mockResolvedValue({
      granted: false,
      reason: "rolling_limit",
      remaining: 12,
      limit: 20,
      retryAt,
    });

    const response = await POST(
      analyzeRequest({
        symbol_id: "NYSE:IBM",
        request_id: "route-request-rate-limit",
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(response.headers.get("x-omnigaze-ai-budget-reason")).toBe(
      "rolling_limit",
    );
    expect(await response.json()).toMatchObject({
      code: "ai_rate_limited",
      retryAt,
      budgetReason: "rolling_limit",
    });
    expect(mocks.analyzeEvidence).not.toHaveBeenCalled();
  });

  it("correlates and sanitizes an unexpected analysis failure", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.analyzeEvidence.mockRejectedValue(
      new Error(
        "do-not-log-analysis-secret owner-a https://provider.test?token=secret",
      ),
    );

    const response = await POST(analyzeRequest({ symbol_id: "NYSE:IBM" }));
    const body = (await response.json()) as {
      code: string;
      error: string;
      requestId: string;
    };

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      code: "analysis_failed",
      error: "Analysis could not be completed.",
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(response.headers.get("server-timing")).toMatch(
      /^omnigaze;dur=\d+\.\d$/,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "omnigaze.unexpected_failure",
      expect.objectContaining({
        event: "omnigaze.unexpected_failure",
        operation: "api.ai.analyze.post",
        requestId: body.requestId,
        failureKind: "error",
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "omnigaze.api_request",
        operation: "api.ai.analyze.post",
        requestId: body.requestId,
        status: 502,
        outcome: "server_error",
      }),
    );
    const serializedLogs = JSON.stringify(errorSpy.mock.calls);
    expect(serializedLogs).not.toContain("do-not-log-analysis-secret");
    expect(serializedLogs).not.toContain("owner-a");
    expect(serializedLogs).not.toContain("token=secret");

    errorSpy.mockRestore();
  });
});
