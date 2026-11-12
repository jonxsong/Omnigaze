import { z } from "zod";

export const omnigazeAnalysisSchema = z.object({
  stance: z.enum(["bullish", "bearish", "mixed", "neutral"]),
  confidence: z.number().min(0).max(1),
  headline: z.string().min(1).max(180),
  summary: z.string().min(1).max(1_200),
  whyNow: z.string().min(1).max(600),
  drivers: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        direction: z.enum(["positive", "negative", "mixed", "unclear"]),
        explanation: z.string().min(1).max(500),
        evidenceIds: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(6),
  unknowns: z.array(z.string().min(1).max(300)).min(1).max(6),
});

export type OmnigazeAnalysis = z.infer<typeof omnigazeAnalysisSchema>;

export const OMNIGAZE_ANALYSIS_PROMPT_VERSION = "2026-11-12.1";

export function assertGroundedAnalysis(
  output: OmnigazeAnalysis,
  allowedEvidenceIds: Iterable<string>,
) {
  const allowed = new Set(allowedEvidenceIds);
  const referenced = output.drivers.flatMap((driver) => driver.evidenceIds);
  const invalidEvidenceIds = referenced.filter((id) => !allowed.has(id));

  if (invalidEvidenceIds.length > 0) {
    throw new Error(
      `Analysis referenced unknown evidence IDs: ${[...new Set(invalidEvidenceIds)].join(", ")}`,
    );
  }

  if (referenced.length === 0) {
    throw new Error("Analysis did not cite any supplied evidence.");
  }
}
