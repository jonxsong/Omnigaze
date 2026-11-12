import { afterEach, describe, expect, it, vi } from "vitest";
import { dailyBriefAnalysisSchema } from "@/lib/ai/daily-brief-contract";
import {
  DAILY_BRIEF_MODEL_INSTRUCTIONS,
  generateDailyBriefAnalysis,
  validateDailyBriefAnalysis,
} from "@/lib/ai/generate-daily-brief";
import type { DailyBriefEvidenceItem } from "@/lib/services/personal-today-evidence";

const agents = vi.hoisted(() => ({
  Agent: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@openai/agents", () => agents);

const evidence = [
  { id: "evidence:nvda-1", symbolIds: ["NASDAQ:NVDA"] as const },
  { id: "evidence:msft-1", symbolIds: ["NASDAQ:MSFT"] as const },
];

const modelEvidence: DailyBriefEvidenceItem[] = evidence.map((item, index) => ({
  id: item.id,
  eventId: `event-${index + 1}`,
  symbolIds: [...item.symbolIds],
  source: index === 0 ? "Alpaca News" : "SEC EDGAR",
  sourceKind: index === 0 ? "licensed_news" : "sec_filing",
  headline: index === 0 ? "NVIDIA publishes an update" : "Microsoft files a report",
  summary: null,
  publishedAt: `2026-11-12T17:5${index}:00.000Z`,
  providerUpdatedAt: null,
  sourceUrl: null,
  materiality: index === 0 ? "high" : "medium",
  topicTags: [],
  isControversial: false,
}));

function output() {
  return {
    headline: "Two tracked companies changed today",
    summary: "Fresh evidence changed the watchlist context.",
    developments: [
      {
        title: "Company updates changed the evidence set",
        whyItMatters: "The updates may change near-term expectations.",
        direction: "mixed",
        symbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
        evidenceIds: ["evidence:nvda-1", "evidence:msft-1"],
      },
    ],
    watchNext: ["Watch for company confirmation."],
    unknowns: ["The durability of the reaction remains unknown."],
  };
}

describe("Daily Brief model output gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("does not let the model infer why bounded selection omitted a symbol", () => {
    expect(DAILY_BRIEF_MODEL_INSTRUCTIONS).toContain(
      "never infer why an unrepresented tracked symbol was omitted",
    );
    expect(DAILY_BRIEF_MODEL_INSTRUCTIONS).toContain(
      "eligible evidence may exist outside the selection limit",
    );
  });

  it("accepts only a strictly grounded synthesis", () => {
    expect(validateDailyBriefAnalysis(output(), evidence)).toMatchObject({
      developments: [
        {
          symbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
          evidenceIds: ["evidence:nvda-1", "evidence:msft-1"],
        },
      ],
    });

    expect(
      validateDailyBriefAnalysis(
        {
          ...output(),
          summary:
            "A broker maintained its Buy rating; no price target was provided.",
        },
        evidence,
      ).summary,
    ).toContain("Buy rating");
  });

  it("rejects target prices, trade sizes, and other non-contract fields", () => {
    expect(() =>
      validateDailyBriefAnalysis(
        {
          ...output(),
          targetPrice: 250,
          sharesToBuy: 10,
        },
        evidence,
      ),
    ).toThrow();

    expect(() =>
      validateDailyBriefAnalysis(
        {
          ...output(),
          summary: "The evidence supports a price target of $250.",
        },
        evidence,
      ),
    ).toThrow("prohibited_trade_guidance");

    expect(() =>
      validateDailyBriefAnalysis(
        {
          ...output(),
          watchNext: ["Consider selling 10 shares after the next update."],
        },
        evidence,
      ),
    ).toThrow("prohibited_trade_guidance");
  });

  it.each([
    { field: "headline", text: "Buy NVDA now." },
    { field: "summary", text: "NVDA will rise 20% tomorrow." },
    { field: "whyItMatters", text: "Guaranteed outperformance." },
    { field: "watchNext", text: "This is a risk-free return." },
    { field: "unknowns", text: "The stock must fall tomorrow." },
    { field: "headline", text: "Go long NVDA today." },
    { field: "headline", text: "Short NVDA before earnings." },
    { field: "summary", text: "Increase your NVDA position now." },
    { field: "summary", text: "The portfolio is bullish overall." },
    { field: "summary", text: "NVDA is certain to gain 20% next week." },
    { field: "watchNext", text: "Expect a 25% return tomorrow." },
    { field: "headline", text: "Purchase NVDA shares." },
    { field: "watchNext", text: "Take profits in NVDA." },
    { field: "watchNext", text: "Set a stop-loss at $150." },
    { field: "summary", text: "NVDA has 20% upside." },
    { field: "summary", text: "The stock is expected to rise tomorrow." },
    {
      field: "summary",
      text: "No return is guaranteed, but this outcome is guaranteed.",
    },
    {
      field: "summary",
      text: "Returns are not guaranteed, yet profits are guaranteed.",
    },
    {
      field: "summary",
      text: "No result is risk-free, but this trade is risk-free.",
    },
  ] as const)("rejects direct guidance or return certainty in $field", ({ field, text }) => {
    const candidate = output();
    if (field === "headline" || field === "summary") candidate[field] = text;
    if (field === "whyItMatters") candidate.developments[0].whyItMatters = text;
    if (field === "watchNext" || field === "unknowns") candidate[field] = [text];

    expect(() => validateDailyBriefAnalysis(candidate, evidence)).toThrow(
      "prohibited_trade_guidance",
    );
  });

  it.each([
    "The central bank may hold at 5.25%.",
    "Average position size remains unknown.",
    "Consider adding regulatory updates to the watch list.",
    "A broker maintained its Buy rating; no price target was provided.",
    "Returns are not guaranteed and no risk-free outcome exists.",
    "Returns are never guaranteed.",
    "No outcome is guaranteed.",
    "Short interest increased after the filing.",
    "Analysts maintained a bullish view on NVDA.",
    "A broker forecast a 5% industry gain in its published note.",
    "Buy pressure increased after earnings.",
    "Exit risk remains elevated.",
  ])("accepts non-prescriptive research language: %s", (summary) => {
    expect(
      validateDailyBriefAnalysis({ ...output(), summary }, evidence).summary,
    ).toBe(summary);
  });

  it("rejects invented citations and tickers absent from cited evidence", () => {
    const base = output();
    expect(() =>
      validateDailyBriefAnalysis(
        {
          ...base,
          developments: [
            { ...base.developments[0], evidenceIds: ["evidence:invented"] },
          ],
        },
        evidence,
      ),
    ).toThrow("unknown_evidence_id");
    expect(() =>
      validateDailyBriefAnalysis(
        {
          ...base,
          developments: [
            {
              ...base.developments[0],
              symbolIds: ["NASDAQ:AAPL"],
              evidenceIds: ["evidence:nvda-1"],
            },
          ],
        },
        evidence,
      ),
    ).toThrow("ungrounded_symbol");
  });

  it("runs the strict model adapter for one turn and revalidates its output", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    agents.run.mockResolvedValueOnce({ finalOutput: output() });

    await expect(
      generateDailyBriefAnalysis({
        briefDate: "2026-11-12",
        window: {
          since: "2026-11-11T18:00:00.000Z",
          through: "2026-11-12T18:00:00.000Z",
        },
        trackedSymbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
        evidence: modelEvidence,
      }),
    ).resolves.toMatchObject({ headline: output().headline });

    expect(agents.Agent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Omnigaze Daily Brief analyst",
        instructions: DAILY_BRIEF_MODEL_INSTRUCTIONS,
        outputType: dailyBriefAnalysisSchema,
      }),
    );
    expect(agents.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('"trackedSymbols":["NASDAQ:NVDA","NASDAQ:MSFT"]'),
      { maxTurns: 1 },
    );
  });
});
