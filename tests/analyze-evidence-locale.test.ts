import { afterEach, describe, expect, it, vi } from "vitest";
import { omnigazeAnalysisSchema } from "@/lib/ai/analysis-contract";
import {
  analysisInstructionsForLocale,
  analyzeEvidence,
} from "@/lib/ai/analyze-evidence";
import type { CanonicalSymbol } from "@/lib/market-types";

const agents = vi.hoisted(() => ({
  Agent: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@openai/agents", () => agents);

const analysis = {
  stance: "mixed" as const,
  confidence: 0.5,
  headline: "证据呈现混合信号",
  summary: "最新公开证据同时包含支持与限制因素。",
  whyNow: "新的公司公告改变了当前证据集。",
  drivers: [
    {
      label: "公司公告",
      direction: "mixed" as const,
      explanation: "该公告提供了新的近期背景。",
      evidenceIds: ["evidence:news-1"],
    },
  ],
  unknowns: ["相关影响能否持续仍不明确。"],
};

describe("Omnigaze View model locale", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("requires Simplified Chinese narrative while preserving evidence identity", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    agents.run.mockResolvedValueOnce({ finalOutput: analysis });

    await expect(
      analyzeEvidence({
        locale: "zh-CN",
        instrument: {
          id: "NASDAQ:NVDA" as CanonicalSymbol,
          ticker: "NVDA",
          exchange: "NASDAQ",
          name: "NVIDIA Corporation",
          sector: "Semiconductors",
          currency: "USD",
        },
        dataCutoff: "2026-11-12T18:00:00.000Z",
        evidence: [
          {
            id: "evidence:news-1",
            title: "NVIDIA publishes an update",
            publisher: "Example News",
            publishedAt: "2026-11-12T17:59:00.000Z",
            url: "https://example.test/nvda",
            classification: "fact",
            excerpt: "NVIDIA Corporation announced an update.",
          },
        ],
        events: [],
      }),
    ).resolves.toEqual(analysis);

    expect(agents.Agent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Omnigaze evidence analyst",
        outputType: omnigazeAnalysisSchema,
        instructions: expect.stringContaining("Simplified Chinese"),
      }),
    );
    const agentOptions = agents.Agent.mock.calls[0][0] as { instructions: string };
    expect(agentOptions.instructions).toContain("company names");
    expect(agentOptions.instructions).toContain("evidence IDs");
    const prompt = JSON.parse(agents.run.mock.calls[0][1] as string) as {
      task: string;
      outputLocale: string;
      instrument: { name: string };
    };
    expect(prompt).toMatchObject({
      outputLocale: "zh-CN",
      instrument: { name: "NVIDIA Corporation" },
    });
    expect(prompt.task).toContain("简体中文");
  });

  it("builds an explicit English language requirement", () => {
    expect(analysisInstructionsForLocale("en")).toContain(
      "every model-authored narrative field in clear English",
    );
  });
});
