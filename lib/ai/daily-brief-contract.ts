import { z } from "zod";
import type { CanonicalSymbol } from "@/lib/market-types";

const canonicalSymbolSchema = z
  .string()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .transform((value) => value as CanonicalSymbol);

const isoTimestampSchema = z.string().datetime({ offset: true });

const publicHttpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Citation URLs must use credential-free HTTP or HTTPS.");

const briefDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
      new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value),
    "Brief date must be a real UTC calendar date.",
  );

const dailyBriefDevelopmentSchema = z
  .object({
    title: z.string().trim().min(1).max(180),
    whyItMatters: z.string().trim().min(1).max(700),
    direction: z.enum(["positive", "negative", "mixed", "unclear"]),
    symbolIds: z.array(canonicalSymbolSchema).min(1).max(12),
    evidenceIds: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  })
  .strict();

/**
 * Model-owned fields only. Dates, evidence metadata, cache state, and budgets
 * are attached deterministically by the application after validation.
 */
export const dailyBriefAnalysisSchema = z
  .object({
    headline: z.string().trim().min(1).max(180),
    summary: z.string().trim().min(1).max(1_200),
    developments: z.array(dailyBriefDevelopmentSchema).min(1).max(3),
    watchNext: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
    unknowns: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
  })
  .strict();

export const dailyBriefSchema = dailyBriefAnalysisSchema
  .extend({
    briefDate: briefDateSchema,
    window: z
      .object({
        since: isoTimestampSchema,
        through: isoTimestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((brief, context) => {
    if (Date.parse(brief.window.since) >= Date.parse(brief.window.through)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["window", "through"],
        message: "The brief window must end after it starts.",
      });
    }
    if (
      new Date(brief.window.through).toISOString().slice(0, 10) !==
      brief.briefDate
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["briefDate"],
        message: "The brief date must match the UTC window end date.",
      });
    }
  });

const dailyBriefCitationSchema = z
  .object({
    id: z.string().trim().min(1).max(300),
    title: z.string().trim().min(1).max(500),
    publisher: z.string().trim().min(1).max(200),
    publishedAt: isoTimestampSchema,
    url: publicHttpUrlSchema.nullable(),
    symbolIds: z.array(canonicalSymbolSchema).min(1).max(12),
    materiality: z.enum(["low", "medium", "high", "critical"]),
    claimStatus: z
      .enum([
        "confirmed",
        "official-investigation",
        "reported",
        "allegation",
        "disputed",
        "corrected",
      ])
      .optional(),
    isControversial: z.boolean(),
  })
  .strict();

export const dailyBriefEnvelopeSchema = z
  .object({
    data: dailyBriefSchema,
    meta: z
      .object({
        dataMode: z.literal("live"),
        providerCoverage: z.enum(["complete", "partial"]),
        freshness: z
          .object({
            state: z.literal("fresh"),
            asOf: isoTimestampSchema,
            ageSeconds: z.number().int().nonnegative(),
          })
          .strict(),
        trackedSymbolCount: z.number().int().positive().max(100),
        trackedSymbolIds: z.array(canonicalSymbolSchema).min(1).max(100),
        includedSymbolCount: z.number().int().positive().max(100),
        omittedSymbolCount: z.number().int().nonnegative().max(100),
        evidenceCount: z.number().int().positive().max(12),
        sourceCount: z.number().int().positive().max(12),
        evidenceCoverage: z
          .object({
            score: z.number().min(0).max(1),
            label: z.enum(["limited", "moderate", "strong"]),
          })
          .strict(),
        citations: z.array(dailyBriefCitationSchema).min(1).max(12),
        promptVersion: z.string().trim().min(1).max(128),
        generatedAt: isoTimestampSchema,
        cache: z
          .object({
            state: z.enum(["generated", "hit", "deduplicated"]),
            cachedAt: isoTimestampSchema,
            expiresAt: isoTimestampSchema,
          })
          .strict(),
        budget: z.discriminatedUnion("consumed", [
          z
            .object({
              consumed: z.literal(true),
              remaining: z.number().int().nonnegative(),
              limit: z.number().int().positive(),
              resetsAt: isoTimestampSchema,
            })
            .strict(),
          z
            .object({
              consumed: z.literal(false),
              remaining: z.null(),
              limit: z.null(),
              resetsAt: z.null(),
            })
            .strict(),
        ]),
        confidenceMeaning: z.literal(
          "evidence_synthesis_not_return_probability",
        ),
        disclaimer: z.string().trim().min(1).max(500),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const meta = envelope.meta;
    const trackedSymbols = new Set(meta.trackedSymbolIds);
    if (
      trackedSymbols.size !== meta.trackedSymbolIds.length ||
      meta.trackedSymbolIds.length !== meta.trackedSymbolCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "trackedSymbolIds"],
        message: "Tracked symbols must be unique and match the tracked count.",
      });
    }
    if (
      meta.includedSymbolCount + meta.omittedSymbolCount !==
      meta.trackedSymbolCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "trackedSymbolCount"],
        message: "Included and omitted symbols must equal tracked symbols.",
      });
    }
    if (meta.evidenceCount !== meta.citations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "evidenceCount"],
        message: "Evidence count must match the citation set.",
      });
    }
    const citationIds = new Set(meta.citations.map((citation) => citation.id));
    if (citationIds.size !== meta.citations.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "citations"],
        message: "Citation IDs must be unique.",
      });
    }
    if (
      new Set(meta.citations.map((citation) => citation.publisher)).size !==
      meta.sourceCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "sourceCount"],
        message: "Source count must match the citation publishers.",
      });
    }
    if (
      new Set(meta.citations.flatMap((citation) => citation.symbolIds)).size !==
      meta.includedSymbolCount
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "includedSymbolCount"],
        message: "Included-symbol count must match the citation universe.",
      });
    }
    if (
      meta.citations.some((citation) =>
        citation.symbolIds.some((symbol) => !trackedSymbols.has(symbol)),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "citations"],
        message: "Every citation symbol must belong to the tracked watchlist.",
      });
    }
    const windowSince = Date.parse(envelope.data.window.since);
    const windowThrough = Date.parse(envelope.data.window.through);
    const freshnessAsOf = Date.parse(meta.freshness.asOf);
    if (freshnessAsOf < windowSince || freshnessAsOf > windowThrough) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "freshness", "asOf"],
        message: "Evidence freshness must fall within the brief window.",
      });
    }
    if (
      meta.citations.some((citation) => {
        const publishedAt = Date.parse(citation.publishedAt);
        return publishedAt < windowSince || publishedAt > windowThrough;
      })
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "citations"],
        message: "Every citation must fall within the brief window.",
      });
    }
    if (Date.parse(meta.cache.expiresAt) <= Date.parse(meta.cache.cachedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "cache", "expiresAt"],
        message: "Cache expiry must be after cache creation.",
      });
    }
    if (
      (meta.cache.state !== "generated" && meta.budget.consumed) ||
      (meta.cache.state === "generated" && !meta.budget.consumed)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "budget", "consumed"],
        message: "Cache and budget state are inconsistent.",
      });
    }
    if (meta.budget.consumed && meta.budget.remaining > meta.budget.limit) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "budget", "remaining"],
        message: "Remaining budget cannot exceed its limit.",
      });
    }
    try {
      assertGroundedDailyBrief(envelope.data, meta.citations);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data", "developments"],
        message: "Every development must be grounded in the citation set.",
      });
    }
  });

export type DailyBriefAnalysis = z.infer<typeof dailyBriefAnalysisSchema>;
export type DailyBrief = z.infer<typeof dailyBriefSchema>;
export type DailyBriefEnvelope = z.infer<typeof dailyBriefEnvelopeSchema>;

export interface DailyBriefGroundingEvidence {
  id: string;
  symbolIds: readonly CanonicalSymbol[];
}

export class DailyBriefGroundingError extends Error {
  constructor(
    readonly code:
      | "duplicate_evidence_id"
      | "duplicate_output_reference"
      | "unknown_evidence_id"
      | "ungrounded_symbol",
  ) {
    super(code);
    this.name = "DailyBriefGroundingError";
  }
}

export function assertGroundedDailyBrief(
  output: DailyBriefAnalysis | DailyBrief,
  evidence: readonly DailyBriefGroundingEvidence[],
) {
  const evidenceById = new Map<string, ReadonlySet<CanonicalSymbol>>();
  for (const item of evidence) {
    if (evidenceById.has(item.id)) {
      throw new DailyBriefGroundingError("duplicate_evidence_id");
    }
    evidenceById.set(item.id, new Set(item.symbolIds));
  }

  for (const development of output.developments) {
    if (
      new Set(development.evidenceIds).size !== development.evidenceIds.length ||
      new Set(development.symbolIds).size !== development.symbolIds.length
    ) {
      throw new DailyBriefGroundingError("duplicate_output_reference");
    }

    const citedSymbols = new Set<CanonicalSymbol>();
    for (const evidenceId of development.evidenceIds) {
      const symbols = evidenceById.get(evidenceId);
      if (!symbols) {
        throw new DailyBriefGroundingError("unknown_evidence_id");
      }
      for (const symbol of symbols) citedSymbols.add(symbol);
    }

    if (development.symbolIds.some((symbol) => !citedSymbols.has(symbol))) {
      throw new DailyBriefGroundingError("ungrounded_symbol");
    }
  }
}

export function parseDailyBriefEnvelope(value: unknown) {
  return dailyBriefEnvelopeSchema.parse(value);
}
