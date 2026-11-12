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

const aiBudgetSchema = z.discriminatedUnion("charged", [
  z
    .object({
      charged: z.literal(false),
      remaining: z.null(),
      limit: z.null(),
      resetAt: z.null(),
    })
    .strict(),
  z
    .object({
      charged: z.literal(true),
      remaining: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
      resetAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]).superRefine((budget, context) => {
  if (budget.charged && budget.remaining > budget.limit) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Remaining AI budget cannot exceed its limit.",
      path: ["remaining"],
    });
  }
});

const aiGuardSchema = z
  .object({
    source: z.enum(["cache", "generated"]),
    deduplicated: z.boolean(),
    modelConfig: z.string().trim().min(1).max(128),
    evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    cacheExpiresAt: z.string().datetime({ offset: true }),
    servedAt: z.string().datetime({ offset: true }),
    budget: aiBudgetSchema,
  })
  .strict()
  .superRefine((guard, context) => {
    if (guard.source === "cache" && guard.budget.charged) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget", "charged"],
        message: "A cache hit cannot consume an AI generation budget.",
      });
    }
    if (guard.deduplicated && guard.budget.charged) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["budget", "charged"],
        message: "A deduplicated follower cannot consume another AI budget.",
      });
    }
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
    ai: aiGuardSchema.optional(),
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
