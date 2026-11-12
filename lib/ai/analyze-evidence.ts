import { Agent, run } from "@openai/agents";
import type { Evidence, IntelligenceEvent, Instrument } from "@/lib/market-types";
import {
  assertGroundedAnalysis,
  omnigazeAnalysisSchema,
  type OmnigazeAnalysis,
} from "@/lib/ai/analysis-contract";

export {
  assertGroundedAnalysis,
  OMNIGAZE_ANALYSIS_PROMPT_VERSION,
  omnigazeAnalysisSchema,
} from "@/lib/ai/analysis-contract";
export type { OmnigazeAnalysis } from "@/lib/ai/analysis-contract";

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
- Preserve claim status. An allegation, reported claim, dispute, or investigation is not a confirmed underlying fact.
- For controversial executive, legal, political, or reputational events, use neutral attribution and explain why the event could matter without amplifying salacious detail.
- A temporal association may be described as a possible contributor, never as the sole cause of a market move without direct supporting evidence.
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
  assertGroundedAnalysis(
    output,
    input.evidence.map((item) => item.id),
  );

  return output;
}
