import { z } from "zod";

const citedPointSchema = z
  .object({
    statement: z.string().min(1).max(500),
    evidenceIds: z.array(z.string().min(1)).min(1).max(8),
  })
  .strict();

export const decisionExplanationSchema = z
  .object({
    headline: z.string().min(1).max(160),
    synthesis: z.string().min(1).max(1_000),
    supportiveEvidence: z.array(citedPointSchema).min(1).max(5),
    limitingEvidence: z.array(citedPointSchema).min(1).max(5),
    invalidationConditions: z.array(z.string().min(1).max(300)).min(1).max(6),
    unknowns: z.array(z.string().min(1).max(300)).min(1).max(6),
  })
  .strict();

export type DecisionExplanation = z.infer<typeof decisionExplanationSchema>;

export const DECISION_EXPLANATION_PROMPT_VERSION = "2026-11-12.1";

const PROHIBITED_CLAIMS = [
  /\bguaranteed?\b/i,
  /\brisk[- ]?free\b/i,
  /\bcan(?:not|'t) lose\b/i,
  /\byou should (?:buy|sell|hold)\b/i,
  /\b(?:buy|sell) exactly\b/i,
  /\b(?:will|must) (?:rise|fall|go up|go down)\b/i,
];

function allNarrativeText(output: DecisionExplanation) {
  return [
    output.headline,
    output.synthesis,
    ...output.supportiveEvidence.map((point) => point.statement),
    ...output.limitingEvidence.map((point) => point.statement),
    ...output.invalidationConditions,
    ...output.unknowns,
  ].join("\n");
}

/**
 * Enforces the boundary between deterministic scenario math and AI narrative.
 * The schema intentionally has no price, share-quantity, target, or confidence
 * fields for a model to populate.
 */
export function assertSafeDecisionExplanation(
  output: DecisionExplanation,
  allowedEvidenceIds: Iterable<string>,
) {
  const allowed = new Set(allowedEvidenceIds);
  const referenced = [
    ...output.supportiveEvidence,
    ...output.limitingEvidence,
  ].flatMap((point) => point.evidenceIds);
  const unknownIds = [...new Set(referenced.filter((id) => !allowed.has(id)))];

  if (unknownIds.length > 0) {
    throw new Error(
      `Decision explanation referenced unknown evidence IDs: ${unknownIds.join(", ")}`,
    );
  }

  const text = allNarrativeText(output);
  const unsafeClaim = PROHIBITED_CLAIMS.find((pattern) => pattern.test(text));
  if (unsafeClaim) {
    throw new Error("Decision explanation crossed the non-prescriptive language boundary.");
  }
}
