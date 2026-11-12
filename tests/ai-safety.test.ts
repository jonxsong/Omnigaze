import { describe, expect, it } from "vitest";
import {
  assertGroundedAnalysis,
  omnigazeAnalysisSchema,
} from "@/lib/ai/analysis-contract";

const groundedOutput = omnigazeAnalysisSchema.parse({
  stance: "mixed",
  confidence: 0.54,
  headline: "Demand strength meets valuation uncertainty",
  summary: "The supplied evidence contains both supportive and limiting signals.",
  whyNow: "A newly observed filing changed the evidence set.",
  drivers: [
    {
      label: "Revenue signal",
      direction: "positive",
      explanation: "The cited filing reports stronger revenue.",
      evidenceIds: ["evidence-1"],
    },
  ],
  unknowns: ["The durability of the reported demand is not yet known."],
});

describe("AI groundedness boundary", () => {
  it("accepts output whose citations are a subset of supplied evidence", () => {
    expect(() =>
      assertGroundedAnalysis(groundedOutput, ["evidence-1", "evidence-2"]),
    ).not.toThrow();
  });

  it("rejects invented evidence identifiers before returning an analysis", () => {
    expect(() => assertGroundedAnalysis(groundedOutput, ["evidence-2"])).toThrow(
      /unknown evidence IDs: evidence-1/,
    );
  });

  it("rejects confidence scores outside the declared range", () => {
    expect(() =>
      omnigazeAnalysisSchema.parse({ ...groundedOutput, confidence: 1.01 }),
    ).toThrow();
  });
});
