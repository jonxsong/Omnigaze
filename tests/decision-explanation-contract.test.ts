import { describe, expect, it } from "vitest";
import {
  assertSafeDecisionExplanation,
  decisionExplanationSchema,
} from "@/lib/ai/decision-explanation-contract";

const safeExplanation = decisionExplanationSchema.parse({
  headline: "The evidence is constructive, but governance risk remains unresolved",
  synthesis:
    "Recent operating evidence supports the thesis while the governance event increases uncertainty.",
  supportiveEvidence: [
    {
      statement: "The latest filing reports continued demand growth.",
      evidenceIds: ["filing-1"],
    },
  ],
  limitingEvidence: [
    {
      statement: "The board investigation creates an unresolved governance risk.",
      evidenceIds: ["release-1", "report-1"],
    },
  ],
  invalidationConditions: ["Demand growth materially weakens in a later filing."],
  unknowns: ["The timing and outcome of the investigation remain unknown."],
});

describe("decision explanation boundary", () => {
  it("accepts a grounded, non-prescriptive explanation", () => {
    expect(() =>
      assertSafeDecisionExplanation(safeExplanation, [
        "filing-1",
        "release-1",
        "report-1",
      ]),
    ).not.toThrow();
  });

  it("rejects evidence identifiers that were not supplied to the model", () => {
    expect(() =>
      assertSafeDecisionExplanation(safeExplanation, ["filing-1", "release-1"]),
    ).toThrow(/unknown evidence IDs: report-1/);
  });

  it("rejects prescriptive or guaranteed-return language", () => {
    expect(() =>
      assertSafeDecisionExplanation(
        { ...safeExplanation, synthesis: "You should buy before it will rise." },
        ["filing-1", "release-1", "report-1"],
      ),
    ).toThrow(/non-prescriptive/);
  });

  it("does not let model output smuggle in targets or quantities", () => {
    expect(() =>
      decisionExplanationSchema.parse({
        ...safeExplanation,
        targetPrice: 200,
        sharesToBuy: 10,
        confidence: 0.9,
      }),
    ).toThrow();
  });
});
