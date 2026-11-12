import { describe, expect, it, vi } from "vitest";
import type { OmnigazeAnalysis } from "@/lib/ai/analysis-contract";
import type {
  GuardedOmnigazeViewInput,
  GuardedOmnigazeViewResult,
} from "@/lib/ai/omnigaze-view-guard";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { OrchestratedIntelligenceFeed } from "@/lib/services/live-market-data";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";
import {
  generateOmnigazeView,
  OmnigazeViewError,
} from "@/lib/services/omnigaze-view";

type ServiceDependencies = NonNullable<
  Parameters<typeof generateOmnigazeView>[2]
>;

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

const chineseAnalysis: OmnigazeAnalysis = {
  ...analysis,
  headline: "证据呈现混合信号",
  summary: "最新证据同时包含支持与限制因素。",
  whyNow: "新的公司公告改变了当前证据集。",
  drivers: analysis.drivers.map((driver) => ({
    ...driver,
    label: "公司公告",
    explanation: "该公告提供了新的近期背景。",
  })),
  unknowns: ["相关影响能否持续仍不明确。"],
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
  const execute = vi.fn(
    async <T>(
      input: GuardedOmnigazeViewInput<T>,
    ): Promise<GuardedOmnigazeViewResult<T>> => ({
      value: await input.generate(),
      meta: {
        source: "generated" as const,
        deduplicated: false,
        modelConfig: "test-model",
        evidenceFingerprint: "a".repeat(64),
        cacheExpiresAt: "2026-11-12T18:05:00.000Z",
        budget: {
          charged: true as const,
          remaining: 19,
          limit: 20,
          resetAt: "2026-11-13T00:00:00.000Z",
        },
      },
    }),
  );
  const guard = {
    execute,
  };
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
    guard: guard as ServiceDependencies["guard"],
    modelConfig: () => "test-model",
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

    const result = await generateOmnigazeView(
      symbolId,
      { ownerId: "owner-1", requestId: "request-1" },
      deps,
    );

    expect(deps.getIntelligenceFeed).toHaveBeenCalledWith({
      symbols: [symbolId],
      since: "2026-11-05T18:00:00.000Z",
      limit: 30,
    });
    expect(deps.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "en",
        instrument: expect.objectContaining({ id: symbolId, ticker: "IBM" }),
        evidence: [
          expect.objectContaining({
            id: "evidence:alpaca:news-1",
            publisher: "alpaca",
          }),
        ],
      }),
    );
    expect(deps.guard!.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        symbolId,
        requestId: "request-1",
        modelConfig: "test-model",
        fingerprint: {
          evidence: [
            expect.objectContaining({
              id: "evidence:alpaca:news-1",
              revisionAt: "2026-11-12T17:59:00.000Z",
              contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
          ],
        },
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
        promptVersion: "2026-11-12.1:en",
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
        ai: {
          source: "generated",
          budget: { charged: true, remaining: 19, limit: 20 },
        },
      },
    });
  });

  it("isolates Chinese and English generation identities and model inputs", async () => {
    const english = dependencies();
    const chinese = dependencies();
    chinese.analyze.mockResolvedValue(chineseAnalysis);

    await generateOmnigazeView(
      symbolId,
      { ownerId: "owner-1", locale: "en" },
      english,
    );
    const chineseResult = await generateOmnigazeView(
      symbolId,
      { ownerId: "owner-1", locale: "zh-CN" },
      chinese,
    );

    const englishGuard = vi.mocked(english.guard!.execute).mock.calls[0][0];
    const chineseGuard = vi.mocked(chinese.guard!.execute).mock.calls[0][0];
    expect(englishGuard.promptVersion).toBe("2026-11-12.1:en");
    expect(chineseGuard.promptVersion).toBe("2026-11-12.1:zh-CN");
    expect(chineseGuard.promptVersion).not.toBe(englishGuard.promptVersion);
    expect(chinese.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "zh-CN" }),
    );
    expect(chineseResult.meta.promptVersion).toBe("2026-11-12.1:zh-CN");
  });

  it.each([
    "建议您买入 IBM",
    "目标价为 $250",
    "卖出 10 股 IBM",
    "IBM 一定上涨",
    "You should buy IBM",
    "We recommend buying IBM",
    "We recommend that you buy IBM",
    "推荐买入 IBM",
    "Buy 10 shares",
  ])("rejects prescriptive generated analysis: %s", async (summary) => {
    const deps = dependencies();
    deps.analyze.mockResolvedValue({ ...analysis, summary });

    await expect(
      generateOmnigazeView(
        symbolId,
        { ownerId: "owner-1", locale: "en" },
        deps,
      ),
    ).rejects.toThrow("prohibited_trade_guidance");
  });

  it("rejects a Chinese request when model-authored fields remain English", async () => {
    const deps = dependencies();

    await expect(
      generateOmnigazeView(
        symbolId,
        { ownerId: "owner-1", locale: "zh-CN" },
        deps,
      ),
    ).rejects.toThrow("analysis_locale_mismatch");
  });

  it("excludes volatile receipt time from the evidence content fingerprint", async () => {
    const firstFeed = liveFeed();
    const secondFeed = liveFeed({
      data: firstFeed.data.map((item) => ({
        ...item,
        receivedAt: "2026-11-12T18:00:00.000Z",
      })),
    });
    const first = dependencies(firstFeed);
    const second = dependencies(secondFeed);

    await generateOmnigazeView(
      symbolId,
      { ownerId: "owner-1", requestId: "request-first" },
      first,
    );
    await generateOmnigazeView(
      symbolId,
      { ownerId: "owner-1", requestId: "request-second" },
      second,
    );

    const firstInput = vi.mocked(first.guard!.execute).mock.calls[0][0];
    const secondInput = vi.mocked(second.guard!.execute).mock.calls[0][0];
    expect(firstInput.fingerprint.evidence).toEqual(
      secondInput.fingerprint.evidence,
    );
  });

  it("revalidates cached analysis citations against the current evidence set", async () => {
    const deps = dependencies();
    const execute = deps.guard!.execute.bind(deps.guard);
    deps.guard!.execute = vi.fn(async (input) => {
      const result = await execute(input);
      return {
        ...result,
        value: {
          ...result.value,
          data: {
            ...result.value.data,
            drivers: result.value.data.drivers.map((driver) => ({
              ...driver,
              evidenceIds: ["evidence:not-in-current-feed"],
            })),
          },
        },
      };
    });

    await expect(
      generateOmnigazeView(
        symbolId,
        { ownerId: "owner-1", requestId: "request-invalid-cache" },
        deps,
      ),
    ).rejects.toThrow("unknown evidence IDs");
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
      generateOmnigazeView(symbolId, { ownerId: "owner-1" }, deps),
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
      generateOmnigazeView(symbolId, { ownerId: "owner-1" }, deps),
      "fresh_evidence_required",
    );
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("rejects a nominally live envelope containing no live relevant items", async () => {
    const feed = liveFeed();
    feed.data = feed.data.map((item) => ({ ...item, isLive: false }));
    const deps = dependencies(feed);

    await expectViewError(
      generateOmnigazeView(symbolId, { ownerId: "owner-1" }, deps),
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
      generateOmnigazeView(symbolId, { ownerId: "owner-1" }, deps),
      "symbol_not_supported",
    );
    expect(deps.getIntelligenceFeed).not.toHaveBeenCalled();
  });

  it("checks AI configuration before provider or catalog work", async () => {
    const deps = dependencies();

    await expectViewError(
      generateOmnigazeView(
        symbolId,
        { ownerId: "owner-1" },
        { ...deps, isAiConfigured: () => false },
      ),
      "ai_unconfigured",
    );
    expect(deps.resolveInstrument).not.toHaveBeenCalled();
    expect(deps.getIntelligenceFeed).not.toHaveBeenCalled();
  });
});
