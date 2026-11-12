import { z } from "zod";
import { omnigazeAnalysisSchema } from "@/lib/ai/analysis-contract";
import type { CanonicalSymbol } from "@/lib/market-types";

const canonicalSymbolSchema = z
  .string()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .transform((value) => value as CanonicalSymbol);

const citationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  publisher: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  url: z.string().url().nullable(),
  classification: z.enum(["fact", "derived", "inference"]),
});

export const omnigazeViewEnvelopeSchema = z.object({
  data: omnigazeAnalysisSchema,
  meta: z.object({
    symbolId: canonicalSymbolSchema,
    dataCutoff: z.string().datetime({ offset: true }),
    generatedAt: z.string().datetime({ offset: true }),
    promptVersion: z.string().min(1),
    dataMode: z.literal("live"),
    providerCoverage: z.enum(["complete", "partial"]),
    freshness: z.object({
      state: z.literal("fresh"),
      asOf: z.string().datetime({ offset: true }),
      ageSeconds: z.number().int().nonnegative(),
    }),
    evidenceCount: z.number().int().positive(),
    eventCount: z.number().int().positive(),
    sources: z.array(z.string().min(1)).min(1),
    evidenceCoverage: z.object({
      score: z.number().min(0).max(1),
      label: z.enum(["limited", "moderate", "strong"]),
      evidenceCount: z.number().int().positive(),
      sourceCount: z.number().int().positive(),
    }),
    citations: z.array(citationSchema).min(1),
    confidenceMeaning: z.literal(
      "evidence_interpretation_not_return_probability",
    ),
    disclaimer: z.string().min(1),
  }),
});

export type OmnigazeViewEnvelope = z.infer<
  typeof omnigazeViewEnvelopeSchema
>;

export function parseOmnigazeViewEnvelope(value: unknown) {
  return omnigazeViewEnvelopeSchema.parse(value);
}
