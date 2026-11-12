import { describe, expect, it, vi } from "vitest";
import type { DailyBrief, DailyBriefAnalysis } from "@/lib/ai/daily-brief-contract";
import type {
  DailyBriefGuardInput,
  DailyBriefGuardResult,
} from "@/lib/ai/daily-brief-guard";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { OrchestratedIntelligenceFeed } from "@/lib/services/live-market-data";
import {
  DailyBriefServiceError,
  generatePersonalDailyBrief,
} from "@/lib/services/personal-daily-brief";

vi.mock("cloudflare:workers", () => ({ env: {} }));

type Dependencies = NonNullable<Parameters<typeof generatePersonalDailyBrief>[2]>;
const NOW = new Date("2026-11-12T18:00:00.000Z");

const analysis: DailyBriefAnalysis = {
  headline: "Two tracked companies changed today",
  summary: "Fresh evidence changed the cross-watchlist context.",
  developments: [
    {
      title: "Two company updates changed the evidence set",
      whyItMatters: "The updates may change near-term expectations.",
      direction: "mixed",
      symbolIds: ["NASDAQ:MSFT", "NASDAQ:NVDA"],
      evidenceIds: ["evidence:msft-news", "evidence:nvda-news"],
    },
  ],
  watchNext: ["Watch for company confirmation."],
  unknowns: ["The durability of the reaction remains unknown."],
};

const chineseAnalysis: DailyBriefAnalysis = {
  ...analysis,
  headline: "两家自选公司今日出现新变化",
  summary: "最新证据改变了当前跨自选股背景。",
  developments: [
    {
      ...analysis.developments[0],
      title: "两家公司更新改变了现有证据集",
      whyItMatters: "这些更新可能改变近期市场预期。",
    },
  ],
  watchNext: ["关注公司的后续确认。"],
  unknowns: ["市场反应能否持续仍不明确。"],
};

function watchlists() {
  return [
    {
      id: "watchlist-default",
      ownerId: "owner-1",
      name: "Core holdings",
      isDefault: true,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      items: [
        {
          watchlistId: "watchlist-default",
          symbolId: "NASDAQ:NVDA",
          note: null,
          addedAt: NOW.toISOString(),
          ticker: "NVDA",
          exchange: "NASDAQ",
          name: "NVIDIA Corporation",
        },
      ],
    },
    {
      id: "watchlist-secondary",
      ownerId: "owner-1",
      name: "Cloud",
      isDefault: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      items: [
        {
          watchlistId: "watchlist-secondary",
          symbolId: "NASDAQ:MSFT",
          note: null,
          addedAt: NOW.toISOString(),
          ticker: "MSFT",
          exchange: "NASDAQ",
          name: "Microsoft Corporation",
        },
      ],
    },
  ];
}

function liveFeed(): OrchestratedIntelligenceFeed {
  return {
    data: [
      {
        id: "nvda-news",
        symbolIds: ["NASDAQ:NVDA"],
        source: "alpaca",
        sourceKind: "licensed_news",
        headline: "NVIDIA publishes a material update",
        summary: "The company published new information.",
        publishedAt: "2026-11-12T17:58:00.000Z",
        receivedAt: "2026-11-12T17:58:01.000Z",
        sourceUrl: "https://example.test/nvda",
        materiality: "high",
        isLive: true,
        claimStatus: "confirmed",
      },
      {
        id: "msft-news",
        symbolIds: ["NASDAQ:MSFT"],
        source: "sec-edgar",
        sourceKind: "sec_filing",
        headline: "Microsoft files a current report",
        summary: "The filing adds current company context.",
        publishedAt: "2026-11-12T17:57:00.000Z",
        receivedAt: "2026-11-12T17:57:01.000Z",
        sourceUrl: "https://example.test/msft",
        materiality: "medium",
        isLive: true,
      },
    ],
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: NOW.toISOString(),
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T17:58:00.000Z",
        ageSeconds: 120,
      },
      providers: [],
      notice: "Live provider evidence.",
    },
  };
}

function dependencies(feed = liveFeed()) {
  const execute = vi.fn(
    async (
      input: DailyBriefGuardInput<DailyBrief>,
    ): Promise<DailyBriefGuardResult<DailyBrief>> => ({
      value: await input.generate(),
      meta: {
        source: "generated",
        deduplicated: false,
        modelConfig: "test-model",
        evidenceFingerprint: "c".repeat(64),
        cacheExpiresAt: "2026-11-13T00:00:00.000Z",
        generatedAt: "2026-11-12T18:00:02.000Z",
        budget: {
          charged: true,
          remaining: 18,
          limit: 20,
          resetAt: "2026-11-13T00:00:00.000Z",
        },
      },
    }),
  );
  return {
    listWatchlists: vi.fn().mockResolvedValue(watchlists()),
    getIntelligenceFeed: vi.fn().mockResolvedValue(feed),
    analyze: vi.fn().mockResolvedValue(analysis),
    guard: { execute },
    modelConfig: () => "test-model",
    now: () => NOW,
    isAiConfigured: () => true,
  } satisfies Dependencies;
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: DailyBriefServiceError["code"],
) {
  await expect(promise).rejects.toMatchObject({
    name: "DailyBriefServiceError",
    code,
  });
}

describe("generatePersonalDailyBrief", () => {
  it("generates one grounded brief across all owned watchlists", async () => {
    const deps = dependencies();
    const result = await generatePersonalDailyBrief(
      "owner-1",
      { requestId: "daily-request-1" },
      deps,
    );

    expect(deps.getIntelligenceFeed).toHaveBeenCalledWith({
      symbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
      since: "2026-11-11T18:00:00.000Z",
      limit: 100,
      minimumMateriality: "low",
    });
    expect(deps.analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        briefDate: "2026-11-12",
        trackedSymbols: ["NASDAQ:MSFT", "NASDAQ:NVDA"],
        evidence: expect.arrayContaining([
          expect.objectContaining({ id: "evidence:nvda-news" }),
          expect.objectContaining({ id: "evidence:msft-news" }),
        ]),
      }),
    );
    expect(deps.guard.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        requestId: "daily-request-1",
        identity: expect.objectContaining({
          briefDate: "2026-11-12",
          modelConfig: "test-model",
          promptVersion: "2026-11-12.2.en",
          cacheKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(result).toMatchObject({
      data: {
        headline: analysis.headline,
        briefDate: "2026-11-12",
      },
      meta: {
        dataMode: "live",
        providerCoverage: "partial",
        trackedSymbolCount: 2,
        trackedSymbolIds: ["NASDAQ:MSFT", "NASDAQ:NVDA"],
        includedSymbolCount: 2,
        omittedSymbolCount: 0,
        evidenceCount: 2,
        sourceCount: 2,
        promptVersion: "2026-11-12.2.en",
        cache: { state: "generated" },
        budget: { consumed: true, remaining: 18, limit: 20 },
      },
    });
    expect(JSON.stringify(deps.analyze.mock.calls[0][0])).not.toMatch(
      /shares|quantity|averageCost|targetPrice/i,
    );
  });

  it("isolates model input and cache identity by requested output locale", async () => {
    const englishDeps = dependencies();
    const chineseDeps = dependencies();
    chineseDeps.analyze.mockResolvedValue(chineseAnalysis);

    const english = await generatePersonalDailyBrief("owner-1", {}, englishDeps);
    const chinese = await generatePersonalDailyBrief(
      "owner-1",
      { locale: "zh-CN" },
      chineseDeps,
    );

    const englishGuardInput = englishDeps.guard.execute.mock.calls[0][0];
    const chineseGuardInput = chineseDeps.guard.execute.mock.calls[0][0];
    expect(englishGuardInput.identity.promptVersion).toBe("2026-11-12.2.en");
    expect(chineseGuardInput.identity.promptVersion).toBe(
      "2026-11-12.2.zh-CN",
    );
    expect(englishGuardInput.identity.cacheKey).not.toBe(
      chineseGuardInput.identity.cacheKey,
    );
    expect(english.meta.promptVersion).toBe("2026-11-12.2.en");
    expect(chinese.meta.promptVersion).toBe("2026-11-12.2.zh-CN");
    expect(englishDeps.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "en" }),
    );
    expect(chineseDeps.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ locale: "zh-CN" }),
    );
  });

  it("rejects a non-Chinese generated or cached narrative for zh-CN", async () => {
    const generatedDeps = dependencies();
    await expect(
      generatePersonalDailyBrief(
        "owner-1",
        { locale: "zh-CN" },
        generatedDeps,
      ),
    ).rejects.toThrow("daily_brief_locale_mismatch");

    const cachedDeps = dependencies();
    cachedDeps.guard.execute = vi.fn().mockResolvedValue({
      value: {
        ...analysis,
        briefDate: "2026-11-12",
        window: {
          since: "2026-11-11T18:00:00.000Z",
          through: NOW.toISOString(),
        },
      },
      meta: {
        source: "cache",
        deduplicated: false,
        modelConfig: "test-model",
        evidenceFingerprint: "c".repeat(64),
        cacheExpiresAt: "2026-11-13T00:00:00.000Z",
        generatedAt: "2026-11-12T18:00:02.000Z",
        budget: {
          charged: false,
          remaining: 20,
          limit: 20,
          resetAt: "2026-11-13T00:00:00.000Z",
        },
      },
    });
    await expect(
      generatePersonalDailyBrief(
        "owner-1",
        { locale: "zh-CN" },
        cachedDeps,
      ),
    ).rejects.toThrow("daily_brief_locale_mismatch");
  });

  it("serves a validated cache hit without invoking the model or charging budget", async () => {
    const deps = dependencies();
    const cached: DailyBrief = {
      ...analysis,
      briefDate: "2026-11-12",
      window: {
        since: "2026-11-11T18:00:00.000Z",
        through: NOW.toISOString(),
      },
    };
    deps.guard.execute = vi.fn().mockResolvedValue({
      value: cached,
      meta: {
        source: "cache",
        deduplicated: false,
        modelConfig: "test-model",
        evidenceFingerprint: "c".repeat(64),
        cacheExpiresAt: "2026-11-12T20:00:00.000Z",
        generatedAt: "2026-11-12T17:50:00.000Z",
        budget: {
          charged: false,
          remaining: null,
          limit: null,
          resetAt: null,
        },
      },
    });

    const result = await generatePersonalDailyBrief("owner-1", {}, deps);

    expect(deps.analyze).not.toHaveBeenCalled();
    expect(result.meta).toMatchObject({
      cache: { state: "hit", cachedAt: "2026-11-12T17:50:00.000Z" },
      budget: {
        consumed: false,
        remaining: null,
        limit: null,
        resetsAt: null,
      },
    });
  });

  it("does not mistake factual source titles for personalized trade guidance", async () => {
    const feed = liveFeed();
    feed.data[0] = {
      ...feed.data[0],
      headline: "Analyst keeps Buy rating after the company update",
    };
    const deps = dependencies(feed);

    const result = await generatePersonalDailyBrief("owner-1", {}, deps);

    expect(result.meta.citations[0]?.title).toContain("Buy rating");
  });

  it("stops before provider, guard, or model work for an empty account", async () => {
    const deps = dependencies();
    deps.listWatchlists.mockResolvedValue(
      watchlists().map((watchlist) => ({ ...watchlist, items: [] })),
    );

    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, deps),
      "empty_watchlist",
    );
    expect(deps.getIntelligenceFeed).not.toHaveBeenCalled();
    expect(deps.guard.execute).not.toHaveBeenCalled();
    expect(deps.analyze).not.toHaveBeenCalled();
  });

  it("fails closed before guard/model work for demo, stale, or irrelevant evidence", async () => {
    const demo = liveFeed();
    demo.meta = {
      ...demo.meta,
      dataMode: "demo",
      mode: "demo",
      providerCoverage: "demo",
      coverage: "demo",
      freshness: { state: "fixture", asOf: null, ageSeconds: null },
    };
    const demoDeps = dependencies(demo);
    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, demoDeps),
      "live_evidence_required",
    );
    expect(demoDeps.guard.execute).not.toHaveBeenCalled();

    const stale = liveFeed();
    stale.meta.freshness = {
      state: "stale",
      asOf: "2026-11-10T18:00:00.000Z",
      ageSeconds: 172_800,
    };
    const staleDeps = dependencies(stale);
    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, staleDeps),
      "fresh_evidence_required",
    );
    expect(staleDeps.analyze).not.toHaveBeenCalled();

    const irrelevant = liveFeed();
    irrelevant.data = irrelevant.data.map((item) => ({
      ...item,
      symbolIds: ["NASDAQ:AAPL"] as CanonicalSymbol[],
    }));
    const irrelevantDeps = dependencies(irrelevant);
    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, irrelevantDeps),
      "insufficient_evidence",
    );
    expect(irrelevantDeps.guard.execute).not.toHaveBeenCalled();
  });

  it("maps configuration, watchlist, and provider failures to safe errors", async () => {
    const configured = dependencies();
    const unconfigured = { ...configured, isAiConfigured: () => false };
    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, unconfigured),
      "ai_unconfigured",
    );
    expect(unconfigured.listWatchlists).not.toHaveBeenCalled();

    const watchlistFailure = dependencies();
    watchlistFailure.listWatchlists.mockRejectedValue(new Error("D1 internals"));
    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, watchlistFailure),
      "watchlists_unavailable",
    );

    const providerFailure = dependencies();
    providerFailure.getIntelligenceFeed.mockRejectedValue(
      new Error("provider secret detail"),
    );
    await expectServiceError(
      generatePersonalDailyBrief("owner-1", {}, providerFailure),
      "intelligence_unavailable",
    );
  });

  it("revalidates cached/model output against the current citation universe", async () => {
    const deps = dependencies();
    deps.analyze.mockResolvedValue({
      ...analysis,
      developments: [
        {
          ...analysis.developments[0],
          symbolIds: ["NASDAQ:AAPL"],
          evidenceIds: ["evidence:nvda-news"],
        },
      ],
    });

    await expect(
      generatePersonalDailyBrief("owner-1", {}, deps),
    ).rejects.toThrow("ungrounded_symbol");
  });

  it("rejects prohibited trade guidance from model or cached free text", async () => {
    const modelDeps = dependencies();
    modelDeps.analyze.mockResolvedValue({
      ...analysis,
      summary: "The evidence implies a target price of $250.",
    });
    await expect(
      generatePersonalDailyBrief("owner-1", {}, modelDeps),
    ).rejects.toThrow("prohibited_trade_guidance");

    const cacheDeps = dependencies();
    cacheDeps.guard.execute = vi.fn(async (input) => {
      const generated = await input.generate();
      return {
        value: {
          ...generated,
          watchNext: ["Consider selling 10 shares after the next update."],
        },
        meta: {
          source: "cache" as const,
          deduplicated: false,
          modelConfig: "test-model",
          evidenceFingerprint: "c".repeat(64),
          cacheExpiresAt: "2026-11-12T20:00:00.000Z",
          generatedAt: "2026-11-12T17:50:00.000Z",
          budget: {
            charged: false as const,
            remaining: null,
            limit: null,
            resetAt: null,
          },
        },
      };
    });
    await expect(
      generatePersonalDailyBrief("owner-1", {}, cacheDeps),
    ).rejects.toThrow("prohibited_trade_guidance");
  });

  it("rejects direct model advice and cached certainty claims", async () => {
    const modelDeps = dependencies();
    modelDeps.analyze.mockResolvedValue({
      ...analysis,
      headline: "Buy NVDA now.",
      summary: "NVDA will rise 20% tomorrow.",
    });
    await expect(
      generatePersonalDailyBrief("owner-1", {}, modelDeps),
    ).rejects.toThrow("prohibited_trade_guidance");

    const cacheDeps = dependencies();
    cacheDeps.guard.execute = vi.fn(async (input) => {
      const generated = await input.generate();
      return {
        value: {
          ...generated,
          developments: generated.developments.map((development, index) =>
            index === 0
              ? { ...development, whyItMatters: "Guaranteed outperformance." }
              : development,
          ),
        },
        meta: {
          source: "cache" as const,
          deduplicated: false,
          modelConfig: "test-model",
          evidenceFingerprint: "c".repeat(64),
          cacheExpiresAt: "2026-11-12T20:00:00.000Z",
          generatedAt: "2026-11-12T17:50:00.000Z",
          budget: {
            charged: false as const,
            remaining: null,
            limit: null,
            resetAt: null,
          },
        },
      };
    });
    await expect(
      generatePersonalDailyBrief("owner-1", {}, cacheDeps),
    ).rejects.toThrow("prohibited_trade_guidance");
  });
});
