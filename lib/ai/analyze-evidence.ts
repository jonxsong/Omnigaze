import { Agent, run } from "@openai/agents";
import { z } from "zod";
import type { Evidence, IntelligenceEvent, Instrument } from "@/lib/market-types";

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

type AnalysisInput = {
  instrument: Instrument;
  evidence: Evidence[];
  events: IntelligenceEvent[];
  dataCutoff: string;
};

const instructions = `You are the Omnigaze market intelligence analyst.

Your job is to interpret supplied public evidence, never to predict prices or tell a user to buy, sell, or hold a security.

Rules:
- Use only the supplied evidence and events. Never invent facts, sources, quotations, or evidence IDs.
- Clearly separate direct facts, derived observations, and inference.
- Treat a price move as an observation, not proof of causation.
- Present both supporting and contradictory signals when available.
- Use lower confidence when evidence is sparse, preliminary, conflicting, or indirect.
- Every driver must cite one or more supplied evidence IDs.
- State important unknowns explicitly.
- Write concise language suitable for a real-time market dashboard.
- Your output is research support, not investment advice.`;

export async function analyzeEvidence(input: AnalysisInput): Promise<OmnigazeAnalysis> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const agent = new Agent({
    name: "Omnigaze evidence analyst",
    instructions,
    outputType: omnigazeAnalysisSchema,
    ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
  });

  const result = await run(
    agent,
    JSON.stringify({
      task: "Create an evidence-backed near-term Omnigaze View.",
      instrument: input.instrument,
      dataCutoff: input.dataCutoff,
      evidence: input.evidence,
      events: input.events,
    }),
    { maxTurns: 1 },
  );

  const output = omnigazeAnalysisSchema.parse(result.finalOutput);
  const allowedEvidenceIds = new Set(input.evidence.map((item) => item.id));
  const invalidEvidenceIds = output.drivers
    .flatMap((driver) => driver.evidenceIds)
    .filter((id) => !allowedEvidenceIds.has(id));

  if (invalidEvidenceIds.length > 0) {
    throw new Error(
      `Analysis referenced unknown evidence IDs: ${[...new Set(invalidEvidenceIds)].join(", ")}`,
    );
  }

  return output;
}
