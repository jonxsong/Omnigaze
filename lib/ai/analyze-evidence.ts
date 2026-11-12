import { Agent, run } from "@openai/agents";
import type { Evidence, IntelligenceEvent, Instrument } from "@/lib/market-types";
import type { AppLocale } from "@/lib/app-locale";
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
  locale?: AppLocale;
};

const baseInstructions = `You are the Omnigaze market intelligence analyst.

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

export function analysisInstructionsForLocale(locale: AppLocale) {
  const languageRequirement = locale === "zh-CN"
    ? `Write every model-authored narrative field in clear Simplified Chinese. This applies to headline, summary, whyNow, every driver label and explanation, and every unknown. Preserve tickers, company names, proper nouns, evidence IDs, and quoted source text exactly as supplied; do not translate, rewrite, or fabricate source material.`
    : `Write every model-authored narrative field in clear English. Preserve tickers, company names, proper nouns, evidence IDs, and quoted source text exactly as supplied; do not translate, rewrite, or fabricate source material.`;
  return `${baseInstructions}\n- ${languageRequirement}`;
}

export async function analyzeEvidence(input: AnalysisInput): Promise<OmnigazeAnalysis> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const locale = input.locale ?? "en";
  const agent = new Agent({
    name: "Omnigaze evidence analyst",
    instructions: analysisInstructionsForLocale(locale),
    outputType: omnigazeAnalysisSchema,
    ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
  });

  const result = await run(
    agent,
    JSON.stringify({
      task: locale === "zh-CN"
        ? "用简体中文创建一份以证据为基础的近期 Omnigaze 观点。"
        : "Create an evidence-backed near-term Omnigaze View in English.",
      outputLocale: locale,
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
